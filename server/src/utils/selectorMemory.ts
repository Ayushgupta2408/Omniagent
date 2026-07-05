/**
 * selectorMemory.ts  — NEXUS Selector Memory v1
 * ─────────────────────────────────────────────────────────────────────────────
 * Persists what worked to ~/nexus-logs/selector-memory.json so NEXUS gets
 * faster and more reliable with every task it runs.
 *
 * Concept:
 *   domain → hint → ranked list of selectors that have succeeded/failed
 *
 * On each successful element interaction, recordSuccess() is called.
 * On each attempt, getBestSelector() is tried FIRST (before all tiers).
 * If the remembered selector works → task completes in milliseconds.
 * If it fails (DOM changed) → log the failure, fall through to Tier 0.
 *
 * The ranking is by success rate: successCount / (successCount + failCount).
 * High success rate entries float to the top automatically.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs   from 'fs/promises';
import * as path from 'path';
import * as os   from 'os';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SelectorEntry {
  selector:     string;
  successCount: number;
  failCount:    number;
  lastUsed:     string;   // ISO timestamp
  tier:         number;   // which tier originally discovered this selector
}

// Structure: domain → normalised hint → ranked selector list
type Memory = Record<string, Record<string, SelectorEntry[]>>;

// ─── Config ───────────────────────────────────────────────────────────────────

const MEMORY_FILE = path.join(os.homedir(), 'nexus-logs', 'selector-memory.json');

// Entries with failCount > MAX_FAILS and successRate < MIN_RATE are pruned
const MAX_FAILS    = 5;
const MIN_RATE     = 0.2;  // 20% success rate minimum to keep
const MAX_PER_HINT = 10;   // cap entries per hint to avoid unbounded growth

// ─── In-memory cache ──────────────────────────────────────────────────────────

let memory: Memory  = {};
let loaded          = false;
let dirty           = false;   // true when in-memory state differs from disk

// ─── Load / Save ──────────────────────────────────────────────────────────────

async function load(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await fs.readFile(MEMORY_FILE, 'utf-8');
    memory    = JSON.parse(raw) as Memory;
    console.log(`[SelectorMemory] Loaded ${countEntries()} entries`);
  } catch {
    // File doesn't exist yet — start fresh, that's fine
    memory = {};
  }
  loaded = true;
}

async function save(): Promise<void> {
  if (!dirty) return;
  try {
    await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
    await fs.writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf-8');
    dirty = false;
  } catch (err) {
    console.warn('[SelectorMemory] Save failed:', (err as Error).message);
  }
}

// Debounced save — avoid hammering disk on every interaction
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void save(); }, 1500);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 50);  // fallback for non-URLs
  }
}

/** Normalise hint for consistent keying (lowercase, trimmed) */
function normaliseHint(hint: string): string {
  return hint.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 120);
}

function successRate(e: SelectorEntry): number {
  const total = e.successCount + e.failCount;
  return total === 0 ? 0 : e.successCount / total;
}

function countEntries(): number {
  return Object.values(memory).reduce(
    (sum, hints) => sum + Object.values(hints).reduce((s, arr) => s + arr.length, 0),
    0,
  );
}

function pruneEntries(entries: SelectorEntry[]): SelectorEntry[] {
  return entries
    .filter(e => {
      if (e.failCount >= MAX_FAILS && successRate(e) < MIN_RATE) return false;
      return true;
    })
    .slice(0, MAX_PER_HINT);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called after a successful element interaction.
 * Increments success count for the selector and re-sorts by success rate.
 */
export async function recordSuccess(
  url:      string,
  hint:     string,
  selector: string,
  tier:     number,
): Promise<void> {
  await load();

  // Skip recording internal/memory strategies to avoid circular references
  if (selector.startsWith('memory:') || !selector) return;

  const domain      = extractDomain(url);
  const normHint    = normaliseHint(hint);

  if (!memory[domain])            memory[domain]            = {};
  if (!memory[domain][normHint])  memory[domain][normHint]  = [];

  const entries  = memory[domain][normHint];
  const existing = entries.find(e => e.selector === selector);

  if (existing) {
    existing.successCount++;
    existing.lastUsed = new Date().toISOString();
    // Update tier if we found a lower-cost path
    if (tier < existing.tier) existing.tier = tier;
  } else {
    entries.push({
      selector,
      successCount: 1,
      failCount:    0,
      lastUsed:     new Date().toISOString(),
      tier,
    });
  }

  // Sort by success rate descending, then by tier ascending (prefer cheaper tiers)
  memory[domain][normHint] = entries
    .sort((a, b) => {
      const rateDiff = successRate(b) - successRate(a);
      if (Math.abs(rateDiff) > 0.05) return rateDiff;
      return a.tier - b.tier;
    })
    .slice(0, MAX_PER_HINT);

  dirty = true;
  scheduleSave();

  console.log(
    `[SelectorMemory] Recorded success: domain="${domain}" hint="${normHint.slice(0, 40)}" ` +
    `selector="${selector.slice(0, 60)}" tier=${tier}`,
  );
}

/**
 * Called after a selector from memory fails (stale/changed).
 * Increments fail count so the entry ranks lower next time.
 */
export async function recordFailure(
  url:      string,
  hint:     string,
  selector: string,
): Promise<void> {
  await load();

  const domain   = extractDomain(url);
  const normHint = normaliseHint(hint);
  const entries  = memory[domain]?.[normHint] ?? [];
  const existing = entries.find(e => e.selector === selector);

  if (existing) {
    existing.failCount++;
    existing.lastUsed = new Date().toISOString();

    // Prune bad entries while we're here
    memory[domain][normHint] = pruneEntries(entries).sort(
      (a, b) => successRate(b) - successRate(a),
    );

    dirty = true;
    scheduleSave();
    console.log(
      `[SelectorMemory] Recorded failure: domain="${domain}" ` +
      `hint="${normHint.slice(0, 40)}" selector="${selector.slice(0, 60)}"`,
    );
  }
}

/**
 * Returns the best remembered selector for this URL+hint combo,
 * or null if nothing has been learned yet.
 */
export async function getBestSelector(
  url:  string,
  hint: string,
): Promise<string | null> {
  await load();

  const domain   = extractDomain(url);
  const normHint = normaliseHint(hint);
  const entries  = memory[domain]?.[normHint] ?? [];

  // Only return selectors that have actually succeeded at least once
  const best = entries.find(e => e.successCount > 0 && successRate(e) >= 0.5);
  if (!best) return null;

  console.log(
    `[SelectorMemory] Found remembered selector for "${normHint.slice(0, 40)}" ` +
    `on ${domain}: "${best.selector.slice(0, 60)}" ` +
    `(${best.successCount}W/${best.failCount}L, tier ${best.tier})`,
  );

  return best.selector;
}

/**
 * Returns full memory stats — used by /api/logs for debugging.
 */
export async function getMemoryStats(): Promise<{
  totalDomains:   number;
  totalHints:     number;
  totalSelectors: number;
  topDomains:     Array<{ domain: string; hints: number }>;
}> {
  await load();

  const domains = Object.keys(memory);
  const totalHints = domains.reduce(
    (sum, d) => sum + Object.keys(memory[d]).length,
    0,
  );
  const totalSelectors = countEntries();

  const topDomains = domains
    .map(d => ({ domain: d, hints: Object.keys(memory[d]).length }))
    .sort((a, b) => b.hints - a.hints)
    .slice(0, 10);

  return { totalDomains: domains.length, totalHints, totalSelectors, topDomains };
}

/**
 * Clear memory for a specific domain (useful if a site redesigns).
 */
export async function clearDomainMemory(url: string): Promise<void> {
  await load();
  const domain = extractDomain(url);
  if (memory[domain]) {
    delete memory[domain];
    dirty = true;
    await save();
    console.log(`[SelectorMemory] Cleared memory for domain: ${domain}`);
  }
}

/** Force immediate flush to disk (call on graceful shutdown). */
export async function flushMemory(): Promise<void> {
  dirty = true;
  await save();
}