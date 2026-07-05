/**
 * executionLogger.ts  -- NEXUS Execution Logger
 *
 * Logs are saved INSIDE your project folder:
 *   <project-root>/nexus-logs/executions.jsonl
 *
 * __dirname at runtime = server/src/utils
 * Going up 3 levels    = project root (same folder as package.json)
 *
 * Add  nexus-logs/  to .gitignore if you don't want logs committed.
 */

import * as fs   from 'fs/promises';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Paths -- project-relative, NOT os.homedir()
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const LOG_DIR      = path.join(PROJECT_ROOT, 'nexus-logs');
const LOG_FILE     = path.join(LOG_DIR, 'executions.jsonl');

const MAX_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepLog {
  stepNumber:    number;
  capability:    string;
  description:   string;
  success:       boolean;
  strategy?:     string;
  errorMessage?: string;
  durationMs:    number;
  retryCount:    number;
  pageUrl?:      string;
}

export interface ExecutionLog {
  timestamp:      string;
  sessionId:      string;
  prompt:         string;
  intent:         string;
  provider:       string;
  totalSteps:     number;
  steps:          StepLog[];
  overallSuccess: boolean;
  successRate:    number;
  durationMs:     number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

let dirVerified = false;

async function ensureLogDir(): Promise<void> {
  if (dirVerified) return;
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    dirVerified = true;
    console.log('[Logger] Log directory:', LOG_DIR);
    console.log('[Logger] Log file:     ', LOG_FILE);
  } catch (err) {
    console.error('[Logger] FAILED to create log directory:', LOG_DIR, err);
    throw err;
  }
}

async function trimToMaxEntries(): Promise<void> {
  try {
    const raw   = await fs.readFile(LOG_FILE, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length > MAX_ENTRIES) {
      const trimmed = lines.slice(lines.length - MAX_ENTRIES).join('\n') + '\n';
      await fs.writeFile(LOG_FILE, trimmed, 'utf-8');
    }
  } catch {
    // File doesn't exist yet -- first write will create it
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append one execution record to executions.jsonl inside the project folder.
 */
export async function logExecution(entry: ExecutionLog): Promise<void> {
  try {
    await ensureLogDir();
    await trimToMaxEntries();
    await fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
    console.log(
      `[Logger] Logged: ${entry.intent} -- ` +
      `${Math.round(entry.successRate * 100)}% success ` +
      `(${entry.totalSteps} steps, ${entry.durationMs}ms)`
    );
  } catch (err) {
    console.error('[Logger] FAILED to write execution log:', err);
    console.error('[Logger] Attempted path:', LOG_FILE);
  }
}

/**
 * Read all logged executions from disk.
 * Returns an empty array if the file doesn't exist yet.
 */
export async function getExecutionLogs(): Promise<ExecutionLog[]> {
  try {
    const raw = await fs.readFile(LOG_FILE, 'utf-8');
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as ExecutionLog);
  } catch {
    return [];
  }
}

/**
 * Aggregate failure stats across all logged executions.
 * Used by /api/logs and /api/health endpoints.
 */
export async function getFailureStats(): Promise<{
  byCapability: Record<string, number>;
  byDomain:     Record<string, number>;
  totalRuns:    number;
  avgSuccess:   number;
  recentTrend:  number[];
}> {
  const entries = await getExecutionLogs();

  const byCapability: Record<string, number> = {};
  const byDomain:     Record<string, number> = {};

  for (const entry of entries) {
    for (const step of entry.steps) {
      if (!step.success) {
        byCapability[step.capability] = (byCapability[step.capability] ?? 0) + 1;
        if (step.pageUrl) {
          try {
            const domain = new URL(step.pageUrl).hostname;
            byDomain[domain] = (byDomain[domain] ?? 0) + 1;
          } catch { /* skip invalid URLs */ }
        }
      }
    }
  }

  const avgSuccess = entries.length > 0
    ? entries.reduce((sum, e) => sum + e.successRate, 0) / entries.length
    : 0;

  const recentTrend = entries.slice(-10).map(e => Math.round(e.successRate * 100));

  return {
    byCapability,
    byDomain,
    totalRuns:  entries.length,
    avgSuccess: Math.round(avgSuccess * 100) / 100,
    recentTrend,
  };
}