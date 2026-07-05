/**
 * promptExamples.ts  — Dynamic Few-Shot Example Loader
 * ─────────────────────────────────────────────────────────────────────────────
 * Instead of hardcoding request/response pairs in the system prompt, this
 * module:
 *   1. Loads all example JSON files from the ./examples/ directory at startup
 *   2. Scores each example against the user's prompt using keyword overlap
 *   3. Injects only the TOP N most relevant examples into the system prompt
 *
 * To ADD a new example: just drop a JSON file in ./examples/ — no code changes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExampleStep {
  capability: string;
  parameters: Record<string, unknown>;
  safety_risk: 'low' | 'medium' | 'high';
  description?: string;
}

export interface PlanExample {
  category: string;
  request: string;
  keywords: string[];
  steps: ExampleStep[];
  /** injected at load time */
  _filePath?: string;
}

// ─── Load all examples from ./examples/*.json ─────────────────────────────────

let _cache: PlanExample[] | null = null;

export function loadAllExamples(): PlanExample[] {
  if (_cache) return _cache;

  const examplesDir = path.join(__dirname, 'examples');

  if (!fs.existsSync(examplesDir)) {
    console.warn('[Examples] No examples/ directory found — using zero-shot mode');
    _cache = [];
    return _cache;
  }

  const files = fs.readdirSync(examplesDir).filter(f => f.endsWith('.json'));
  const all: PlanExample[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(examplesDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as PlanExample | PlanExample[];
      const examples = Array.isArray(parsed) ? parsed : [parsed];
      examples.forEach(ex => { ex._filePath = file; });
      all.push(...examples);
    } catch (e) {
      console.warn(`[Examples] Failed to load ${file}:`, (e as Error).message);
    }
  }

  console.log(`[Examples] Loaded ${all.length} examples from ${files.length} files`);
  _cache = all;
  return _cache;
}

/** Force-reload examples (useful for hot-reload during development) */
export function reloadExamples(): void {
  _cache = null;
  loadAllExamples();
}

// ─── Relevance Scoring ────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function scoreExample(prompt: string, example: PlanExample): number {
  const promptTokens = new Set(tokenize(prompt));
  let score = 0;

  // Keyword overlap (highest signal)
  for (const keyword of example.keywords) {
    const kwTokens = tokenize(keyword);
    for (const t of kwTokens) {
      if (promptTokens.has(t)) score += 3;
    }
    // Exact phrase match bonus
    if (prompt.toLowerCase().includes(keyword.toLowerCase())) score += 5;
  }

  // Category hint overlap
  const categoryTokens = tokenize(example.category);
  for (const t of categoryTokens) {
    if (promptTokens.has(t)) score += 2;
  }

  // Request text similarity
  const requestTokens = tokenize(example.request);
  for (const t of requestTokens) {
    if (promptTokens.has(t)) score += 1;
  }

  return score;
}

// ─── Select Top N relevant examples ──────────────────────────────────────────

export function selectExamples(prompt: string, topN: number = 3): PlanExample[] {
  const all = loadAllExamples();
  if (all.length === 0) return [];

  const scored = all
    .map(ex => ({ ex, score: scoreExample(prompt, ex) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // Deduplicate by category — don't show two Amazon examples, etc.
  const seenCategories = new Set<string>();
  const selected: PlanExample[] = [];

  for (const { ex } of scored) {
    const baseCategory = ex.category.split('_')[0]; // e.g. "browser_amazon" → "browser"
    if (!seenCategories.has(ex.category)) {
      seenCategories.add(ex.category);
      selected.push(ex);
    }
    if (selected.length >= topN) break;
  }

  // If no matches at all, return the first N as generic fallbacks
  if (selected.length === 0) {
    return all.slice(0, Math.min(topN, all.length));
  }

  return selected;
}

// ─── Format examples as prompt text ──────────────────────────────────────────

function formatStep(step: ExampleStep, index: number): string {
  // For create_file steps, replace long content with a stub to save prompt tokens.
  const params = { ...step.parameters };
  if (step.capability === 'create_file' && typeof params.content === 'string' && params.content.length > 100) {
    params.content = '<WRITE FULL FILE CONTENT HERE — do not leave empty>';
  }
  return JSON.stringify({
    step_number: index + 1,
    capability: step.capability,
    parameters: params,
    safety_risk: step.safety_risk,
    description: step.description ?? `${step.capability.replace(/_/g, ' ')}`,
  }, null, 2);
}

export function formatExamplesForPrompt(examples: PlanExample[]): string {
  if (examples.length === 0) return '';

  const blocks = examples.map(ex => {
    const stepsJson = ex.steps.map((s, i) => formatStep(s, i)).join(',\n    ');
    return `REQUEST: "${ex.request}"
OUTPUT:
{
  "intent": "${ex.category}",
  "confidence": 95,
  "requires_confirmation": false,
  "summary": "Execute: ${ex.request}",
  "steps": [
    ${stepsJson}
  ]
}`;
  });

  return `═══════════════════════════════════════════════
RELEVANT EXAMPLES (selected for this request)
═══════════════════════════════════════════════

${blocks.join('\n\n---\n\n')}`;
}