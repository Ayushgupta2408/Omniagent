// ═══════════════════════════════════════════════════════════════════════════
// NEXUS — Smart Auto-Fix System
// ═══════════════════════════════════════════════════════════════════════════
//
// KEY INSIGHT: Retrying the same file with the same error = infinite loop.
// The fix must PATCH THE SOURCE FILE before retrying, not just install deps.
//
// FIX: Replaced inline `import('./types').PlanStep` with proper top-level
//      import. Both the interface definition AND the export signature now
//      use the same imported type — no more dual-import inconsistency.
//
// FIX: Removed unused `analyzeError()` function that was dead code
//      (a copy-paste leftover from planner.ts — it was never called here).
//
// Error → Fix mapping:
//   ModuleNotFoundError  → pip install pkg
//   UnicodeEncodeError   → patch open() calls with encoding='utf-8'
//   FileNotFoundError    → add os.makedirs before file writes
//   ConnectionError      → add timeout=15 to requests.get()
//   SyntaxError          → return null so replanner rewrites the script
//   Cannot find module   → npm install pkg

import * as fs   from 'fs/promises';
import * as path from 'path';
import * as os   from 'os';
import type { PlanStep } from '../types/index';

// ─── Patch registry ───────────────────────────────────────────────────────────

interface AutoFix {
  name: string;
  test: (error: string) => boolean;
  fix: (
    error: string,
    step: PlanStep,
    broadcast: (msg: object) => void,
  ) => Promise<string | null>;
}

const AUTO_FIXES: AutoFix[] = [

  // ── Fix 1: Missing Python module ─────────────────────────────────────────
  {
    name: 'pip-install',
    test: (e) => /ModuleNotFoundError: No module named/.test(e),
    fix: async (error, _step, broadcast) => {
      const match = error.match(/ModuleNotFoundError: No module named '([^']+)'/);
      if (!match) return null;
      const pkg = match[1].split('.')[0]; // e.g. "bs4" from "bs4.element"
      broadcast({ type: 'planning', message: `Auto-fix: installing missing module "${pkg}"...` });
      try {
        const { execAsync } = await getExecAsync();
        await execAsync(`pip install ${pkg} --quiet`, { timeout: 60_000 });
        return `pip install ${pkg}`;
      } catch {
        try {
          const { execAsync } = await getExecAsync();
          await execAsync(`pip3 install ${pkg} --quiet`, { timeout: 60_000 });
          return `pip3 install ${pkg}`;
        } catch {
          return null;
        }
      }
    },
  },

  // ── Fix 2: UnicodeEncodeError → patch open() calls to use utf-8 ──────────
  {
    name: 'unicode-encoding',
    test: (e) => e.includes('UnicodeEncodeError') || e.includes('charmap'),
    fix: async (error, step, broadcast) => {
      const filePath = extractPythonFilePath(step);
      if (!filePath) return null;

      broadcast({
        type: 'planning',
        message: `Auto-fix: patching Unicode encoding in ${path.basename(filePath)}...`,
      });

      try {
        let content = await fs.readFile(filePath, 'utf-8');
        let changed = false;

        // open('file', 'w') → open('file', 'w', encoding='utf-8')
        if (/open\([^)]+,\s*['"]w['"]\)/.test(content)) {
          content = content.replace(
            /open\(([^)]+),\s*['"]w['"]\)/g,
            "open($1, 'w', encoding='utf-8')"
          );
          changed = true;
        }

        // open('file', 'a') → open('file', 'a', encoding='utf-8')
        content = content.replace(
          /open\(([^)]+),\s*['"]a['"]\)/g,
          "open($1, 'a', encoding='utf-8')"
        );

        // open('file', 'r') → open('file', 'r', encoding='utf-8')
        content = content.replace(
          /open\(([^)]+),\s*['"]r['"]\)/g,
          "open($1, 'r', encoding='utf-8')"
        );

        // Add PYTHONIOENCODING env at top if print() is used
        if (content.includes('print(') && !content.includes('PYTHONIOENCODING')) {
          content = `import os\nos.environ['PYTHONIOENCODING'] = 'utf-8'\n` + content;
          changed = true;
        }

        // Replace response.text writes with safe decode
        if (content.includes('response.text') && error.includes('UnicodeEncodeError')) {
          content = content.replace(
            /f\.write\(response\.text\)/g,
            "f.write(response.content.decode('utf-8', errors='replace'))"
          );
          changed = true;
        }

        // Generic fallback if nothing specific matched
        if (!changed) {
          content = content.replace(
            /open\(([^,)]+)\)/g,
            "open($1, encoding='utf-8')"
          );
        }

        await fs.writeFile(filePath, content, 'utf-8');
        return `patched encoding='utf-8' in ${path.basename(filePath)}`;
      } catch (e) {
        console.warn('[AutoFix] Unicode patch failed:', (e as Error).message);
        return null;
      }
    },
  },

  // ── Fix 3: FileNotFoundError → add os.makedirs ───────────────────────────
  {
    name: 'missing-directory',
    test: (e) => e.includes('FileNotFoundError') || (e.includes('No such file') && e.includes('.py')),
    fix: async (error, step, broadcast) => {
      const filePath = extractPythonFilePath(step);
      if (!filePath) return null;

      broadcast({ type: 'planning', message: `Auto-fix: adding directory creation to script...` });

      try {
        let content = await fs.readFile(filePath, 'utf-8');

        if (!content.includes('os.makedirs')) {
          const dirMatch = error.match(/No such file or directory: '([^']+)'/);
          if (dirMatch) {
            const missingDir = path.dirname(dirMatch[1]);
            const insertLine = `\nimport os\nos.makedirs(r'${missingDir}', exist_ok=True)\n`;
            content = insertLine + content;
            await fs.writeFile(filePath, content, 'utf-8');
            return `added os.makedirs('${missingDir}') to script`;
          }
        }
        return null;
      } catch {
        return null;
      }
    },
  },

  // ── Fix 4: requests.ConnectionError → add timeout ────────────────────────
  {
    name: 'connection-error',
    test: (e) => e.includes('ConnectionError') || e.includes('requests.exceptions'),
    fix: async (_error, step, broadcast) => {
      const filePath = extractPythonFilePath(step);
      if (!filePath) return null;

      broadcast({
        type: 'planning',
        message: `Auto-fix: adding timeout and error handling to network calls...`,
      });

      try {
        let content = await fs.readFile(filePath, 'utf-8');

        content = content.replace(
          /requests\.get\(([^)]+)\)/g,
          (match, args) => {
            if (args.includes('timeout')) return match;
            return `requests.get(${args}, timeout=15)`;
          }
        );

        await fs.writeFile(filePath, content, 'utf-8');
        return `added timeout=15 to requests calls in ${path.basename(filePath)}`;
      } catch {
        return null;
      }
    },
  },

  // ── Fix 5: Missing Node module ────────────────────────────────────────────
  {
    name: 'npm-install',
    test: (e) => /Cannot find module '([^.][^']+)'/.test(e),
    fix: async (error, _step, broadcast) => {
      const match = error.match(/Cannot find module '([^.][^']+)'/);
      if (!match) return null;
      const pkg = match[1];
      broadcast({ type: 'planning', message: `Auto-fix: installing missing Node module "${pkg}"...` });
      try {
        const { execAsync } = await getExecAsync();
        await execAsync(`npm install ${pkg}`, { timeout: 60_000 });
        return `npm install ${pkg}`;
      } catch {
        return null;
      }
    },
  },

  // ── Fix 6: Python SyntaxError → signal replanner to rewrite ──────────────
  {
    name: 'syntax-error-replan',
    test: (e) => e.includes('IndentationError') || e.includes('SyntaxError'),
    fix: async (_error, _step, broadcast) => {
      broadcast({
        type: 'planning',
        message: `Auto-fix: syntax error detected — will rewrite script from scratch...`,
      });
      // Return null so the mid-execution replanner in server.ts takes over.
      // It will see the error message and generate a corrected script.
      return null;
    },
  },

];

// ─── Helper: extract Python file path from a shell command step ───────────────
// FIX: Uses the top-level PlanStep import, not inline import('./types').PlanStep

function extractPythonFilePath(step: PlanStep): string | null {
  const cmd = step.parameters?.command ?? '';
  const match = cmd.match(/python3?\s+["']?([^\s"']+\.py)["']?/i);
  if (!match) return null;

  let filePath = match[1];
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    filePath = path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

// ─── Helper: execAsync ────────────────────────────────────────────────────────

async function getExecAsync() {
  const { exec }      = await import('child_process');
  const { promisify } = await import('util');
  return { execAsync: promisify(exec) };
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function tryAutoFixBeforeRetry(
  step: PlanStep,
  error: string,
  broadcast: (msg: object) => void,
): Promise<string | null> {

  for (const autoFix of AUTO_FIXES) {
    if (autoFix.test(error)) {
      console.log(`[AutoFix] Matched fix: "${autoFix.name}" for error: ${error.slice(0, 80)}`);
      try {
        const result = await autoFix.fix(error, step, broadcast);
        if (result) {
          console.log(`[AutoFix]  Applied "${autoFix.name}": ${result}`);
          return result;
        }
      } catch (fixErr) {
        console.warn(`[AutoFix] Fix "${autoFix.name}" threw:`, (fixErr as Error).message);
      }
    }
  }

  return null;
}