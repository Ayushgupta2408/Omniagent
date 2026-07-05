/**
 * desktopEngine.ts  — NEXUS Desktop Engine v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Calls desktop_agent.py (four-layer engine) for native app automation.
 * Adds verify() support — confirms each action actually worked before
 * moving to the next step.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { exec }  from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { promisify } from 'util';
import { StepResult } from '../types';

const execAsync = promisify(exec);

// ─── Config ───────────────────────────────────────────────────────────────────

async function getAgentPath(): Promise<string> {
  const candidates = [
    path.join(__dirname, '..', '..', 'scripts', 'desktop_agent.py'),
    path.join(__dirname, '..', 'scripts', 'desktop_agent.py'),
    path.join(process.cwd(), 'scripts', 'desktop_agent.py'),
    path.join(process.cwd(), 'desktop_agent.py'),
  ];
  for (const p of candidates) {
    try { await fs.access(p); return p; } catch { /* next */ }
  }
  throw new Error(
    `desktop_agent.py not found. Expected at:\n${candidates.join('\n')}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── pywinauto + deps check ───────────────────────────────────────────────────

let depsReady = false;

export async function ensurePywinauto(): Promise<void> {
  if (depsReady) return;

  // Check Python
  for (const py of ['python', 'python3']) {
    try { await execAsync(`${py} --version`, { timeout: 5000 }); break; }
    catch { /* try next */ }
  }

  // Install all required packages in one shot
  const PACKAGES = [
    'pywinauto',
    'pyautogui',
    'Pillow',
    'opencv-python',
    'psutil',
    'easyocr',
  ];

  for (const pkg of PACKAGES) {
    try {
      await execAsync(`python -c "import ${pkg.toLowerCase().replace('-', '_')}"`, { timeout: 5000 });
    } catch {
      console.log(`[DesktopEngine] Installing ${pkg}...`);
      try {
        await execAsync(`pip install ${pkg} --quiet`, { timeout: 120_000 });
      } catch (e) {
        console.warn(`[DesktopEngine] Could not install ${pkg}: ${(e as Error).message}`);
      }
    }
  }

  depsReady = true;
}

// ─── Agent caller ─────────────────────────────────────────────────────────────

interface AgentResult {
  success: boolean;
  message?: string;
  error?: string;
  strategy?: string;
  title?: string;
  path?: string;
  electron?: boolean;
  cdp_port?: number;
  elements?: Array<{ title: string; control_type: string; auto_id: string }>;
}

async function callAgent(args: string[], timeoutMs = 30_000): Promise<AgentResult> {
  await ensurePywinauto();
  const scriptPath  = await getAgentPath();
  const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
  const cmd         = `python "${scriptPath}" ${escapedArgs}`;

  console.log(`[DesktopEngine] Running: ${cmd.slice(0, 140)}`);

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: timeoutMs });

    // stderr contains log lines (JSON with "log" key) — print them
    if (stderr) {
      for (const line of stderr.split('\n').filter(Boolean)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.log) console.log(`  [agent] ${parsed.log}`);
        } catch { /* raw stderr */ }
      }
    }

    // Find the last valid JSON line in stdout (the ok/fail output)
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const result = JSON.parse(lines[i]) as AgentResult;
        if ('success' in result) return result;
      } catch { /* try previous line */ }
    }

    return { success: false, error: `No valid JSON in output: ${stdout.slice(0, 200)}` };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    if (e.stdout) {
      const lines = e.stdout.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const result = JSON.parse(lines[i]) as AgentResult;
          if ('success' in result) return result;
        } catch { /* try previous */ }
      }
    }
    return { success: false, error: e.message.slice(0, 300) };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Wait for app window to be ready.
 */
export async function appFindWindow(
  appName: string,
  timeoutSeconds = 10,
): Promise<StepResult> {
  const result = await callAgent(
    ['find_window', appName, '--timeout', String(timeoutSeconds)],
    (timeoutSeconds + 5) * 1000,
  );
  if (!result.success) throw new Error(result.error ?? `Window not found: "${appName}"`);

  const info = result.electron
    ? ` [Electron${result.cdp_port ? ` CDP:${result.cdp_port}` : ' no-CDP'}]`
    : ' [native]';

  return {
    success: true,
    message: `${result.message}${info}`,
    title:   result.title,
    electron: result.electron,
    cdp_port: result.cdp_port,
  };
}

/**
 * Click a UI element inside a native app.
 */
export async function appClick(
  appName: string,
  elementName: string,
): Promise<StepResult> {
  const result = await callAgent(['click', appName, elementName], 25_000);
  if (!result.success) throw new Error(result.error ?? `Could not click "${elementName}"`);
  return {
    success:  true,
    message:  result.message ?? `Clicked "${elementName}"`,
    strategy: result.strategy,
  };
}

/**
 * Type text into a UI element inside a native app.
 */
export async function appType(
  appName: string,
  elementName: string,
  text: string,
): Promise<StepResult> {
  const result = await callAgent(['type', appName, elementName, text], 25_000);
  if (!result.success) throw new Error(result.error ?? `Could not type into "${elementName}"`);
  return {
    success:  true,
    message:  result.message ?? `Typed into "${elementName}"`,
    strategy: result.strategy,
  };
}

/**
 * Focus a native app window.
 */
export async function appFocusWindow(appName: string): Promise<StepResult> {
  const result = await callAgent(['focus_window', appName], 8_000);
  if (!result.success) throw new Error(result.error ?? `Could not focus "${appName}"`);
  return { success: true, message: result.message ?? `Focused "${appName}"` };
}

/**
 * Take a screenshot of an app window.
 */
export async function appScreenshot(appName: string): Promise<StepResult> {
  const result = await callAgent(['screenshot', appName], 10_000);
  if (!result.success) throw new Error(result.error ?? `Screenshot failed for "${appName}"`);
  return { success: true, message: result.message ?? 'Screenshot taken', path: result.path };
}

/**
 * Verify that specific text is visible in an app window.
 * Useful for confirming actions worked.
 */
export async function appVerify(appName: string, text: string): Promise<StepResult> {
  const result = await callAgent(['verify', appName, text], 15_000);
  if (!result.success) throw new Error(result.error ?? `"${text}" not found in "${appName}"`);
  return { success: true, message: result.message ?? `Verified: "${text}" visible` };
}

/**
 * List all UI elements (debugging).
 */
export async function appListElements(appName: string): Promise<StepResult> {
  const result = await callAgent(['list_elements', appName], 12_000);
  if (!result.success) throw new Error(result.error ?? `Could not list elements in "${appName}"`);
  return {
    success:  true,
    message:  result.message ?? 'Listed elements',
    elements: result.elements,
    electron: result.electron,
    cdp_port: result.cdp_port,
  };
}