import { executeStep } from '../executor/stepExecutor';
import { PlanStep, StepResult } from '../types';
import { broadcast } from './websocketService';

// ─── Utility Helpers ──────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getExecAsync() {
  const { exec }    = await import('child_process');
  const { promisify } = await import('util');
  return { execAsync: promisify(exec) };
}

// ─── Adaptive Workarounds ─────────────────────────────────────────────────────

export async function tryAdaptiveWorkaround(
  step: PlanStep,
  error: string,
  sessionId: string,
): Promise<StepResult | null> {
  broadcast({
    type: 'planning',
    message: `Trying adaptive workaround for step ${step.step_number}...`,
  });

  if (error.includes("Executable doesn't exist") || error.includes('playwright install')) {
    broadcast({ type: 'planning', message: 'Auto-installing Playwright browsers...' });
    try {
      const { execAsync: exec2 } = await getExecAsync();
      await exec2('npx playwright install chromium', { timeout: 120_000 });
      broadcast({ type: 'planning', message: '✓ Playwright installed — retrying step...' });
      return await executeStep(step);
    } catch (installErr) {
      console.error('[Workaround] Playwright install failed:', installErr);
      if (step.capability === 'browser_open' && step.parameters.url) {
        return openInSystemBrowser(step.parameters.url);
      }
    }
  }

  if (error.includes('robotjs') || error.includes('Cannot type')) {
    if (step.parameters.text) {
      return openTextInNotepad(step.parameters.text, sessionId);
    }
  }

  if (step.capability === 'open_application' && step.parameters.app_name) {
    return openViaShell(step.parameters.app_name);
  }

  return null;
}

// ─── System Browser Fallback ──────────────────────────────────────────────────

export async function openInSystemBrowser(url: string): Promise<StepResult> {
  const { execAsync: exec2 } = await getExecAsync();
  const finalUrl = url.startsWith('http') ? url : `https://${url}`;
  if (process.platform === 'win32') {
    await exec2(`start "" "${finalUrl}"`);
  } else if (process.platform === 'darwin') {
    await exec2(`open "${finalUrl}"`);
  } else {
    await exec2(`xdg-open "${finalUrl}"`);
  }
  await sleep(1500);
  return { success: true, url: finalUrl, message: `Opened ${finalUrl} in system default browser` };
}

// ─── Notepad Fallback ─────────────────────────────────────────────────────────

export async function openTextInNotepad(text: string, _sessionId: string): Promise<StepResult> {
  const { execAsync: exec2 } = await getExecAsync();
  const fs2   = await import('fs/promises');
  const os2   = await import('os');
  const path2 = await import('path');
  const tmpFile = path2.join(os2.tmpdir(), `nexus-text-${Date.now()}.txt`);
  await fs2.writeFile(tmpFile, text, 'utf-8');
  if (process.platform === 'win32') {
    await exec2(`notepad "${tmpFile}"`);
  }
  return { success: true, path: tmpFile, message: `Text written to ${tmpFile}` };
}

// ─── Shell App Opener ─────────────────────────────────────────────────────────

export async function openViaShell(appName: string): Promise<StepResult> {
  const { execAsync: exec2 } = await getExecAsync();
  if (process.platform === 'win32') {
    try {
      await exec2(`powershell -Command "Start-Process '${appName}'"`, { timeout: 5000 });
      return { success: true, message: `Opened ${appName} via PowerShell` };
    } catch {
      await exec2(`cmd /c start ${appName}`, { timeout: 5000 });
      return { success: true, message: `Opened ${appName} via cmd` };
    }
  }
  throw new Error(`Cannot open ${appName}`);
}
