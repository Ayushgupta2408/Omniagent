/**
 * memory.ts — NEXUS Persistent Memory
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores a rolling log of every task NEXUS has run in a human-readable
 * Markdown file at ~/nexus-logs/MEMORY.md
 *
 * The memory is injected into the planner's system prompt so the agent
 * knows what you've asked before, what worked, and what your preferences are.
 *
 * File location: ~/nexus-logs/MEMORY.md
 * Max lines kept: 100 (oldest entries are trimmed automatically)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs   from 'fs/promises';
import * as path from 'path';
import * as os   from 'os';

// ─── Config ───────────────────────────────────────────────────────────────────

const MEMORY_DIR  = path.join(os.homedir(), 'nexus-logs');
const MEMORY_FILE = path.join(MEMORY_DIR, 'MEMORY.md');
const MAX_ENTRIES = 100;

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read the full memory file contents.
 * Returns empty string if the file doesn't exist yet (first run).
 */
export async function readMemory(): Promise<string> {
  try {
    return await fs.readFile(MEMORY_FILE, 'utf-8');
  } catch {
    // File doesn't exist yet — that's fine, first run
    return '';
  }
}

// ─── Append ───────────────────────────────────────────────────────────────────

/**
 * Append one task entry to MEMORY.md after execution completes.
 *
 * @param intent    - The plan intent string (e.g. "browser_search")
 * @param summary   - The plan summary sentence
 * @param success   - Whether the task overall succeeded
 * @param stepCount - How many steps were in the plan
 */
export async function appendMemory(
  intent:    string,
  summary:   string,
  success:   boolean,
  stepCount: number,
): Promise<void> {
  try {
    await fs.mkdir(MEMORY_DIR, { recursive: true });

    // Format: "- [15 Jan 25 08:32] ✓ browser_search (3 steps): Open Bing and search..."
    const now  = new Date();
    const date = now.toLocaleDateString('en-GB', {
      day:   '2-digit',
      month: 'short',
      year:  '2-digit',
    });
    const time = now.toLocaleTimeString('en-GB', {
      hour:   '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const icon        = success ? '✓' : '✗';
    const summaryClip = summary.replace(/\n/g, ' ').trim().slice(0, 100);
    const newEntry    = `- [${date} ${time}] ${icon} ${intent} (${stepCount} steps): ${summaryClip}`;

    // Read existing content, strip the header line if present
    const existing = await readMemory();
    const lines = existing
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('<!--'));

    // Add new entry and trim to max
    const updated = [...lines, newEntry].slice(-MAX_ENTRIES);

    const fileContent = [
      '# NEXUS Memory',
      '<!-- Auto-generated. Do not edit manually. -->',
      '<!-- Last ' + MAX_ENTRIES + ' tasks are kept. Oldest entries are trimmed automatically. -->',
      '',
      ...updated,
      '',
    ].join('\n');

    await fs.writeFile(MEMORY_FILE, fileContent, 'utf-8');
    console.log(`[Memory] Saved: "${newEntry.slice(0, 80)}"`);
  } catch (err) {
    // Memory write failure is non-fatal — log and continue
    console.warn('[Memory] Write failed:', (err as Error).message);
  }
}

// ─── Format for prompt injection ─────────────────────────────────────────────

/**
 * Returns the memory formatted as a concise block for injection into
 * the planner system prompt. Only the last 20 entries are included
 * to keep the prompt short.
 *
 * Returns empty string if memory is empty (first run).
 */
export async function getMemoryForPrompt(): Promise<string> {
  const raw = await readMemory();
  if (!raw.trim()) return '';

  const entries = raw
    .split('\n')
    .filter(l => l.startsWith('- ['))
    .slice(-20); // Only last 20 entries in the prompt

  if (entries.length === 0) return '';

  return [
    '═══════════════════════════════════════════════',
    'USER TASK HISTORY (last ' + entries.length + ' tasks — use this to understand preferences):',
    '═══════════════════════════════════════════════',
    ...entries,
    '',
  ].join('\n');
}