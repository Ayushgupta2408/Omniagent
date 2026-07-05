import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Plan, ReviewResult } from '../types';

// ─── System Prompt ────────────────────────────────────────────────────────────
//
// Same philosophy as planner: role + catalog + examples beats a list of rules.
// The reviewer only cares about three verdicts and needs to be very precise
// about which patterns trigger which verdict.
//
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a security auditor for an AI automation system. You receive an execution plan and return a safety verdict.

You output ONLY a raw JSON object — no markdown, no code fences, no explanation.

═══════════════════════════════════════════════
VERDICTS
═══════════════════════════════════════════════

SAFE
  The plan performs benign, reversible, or read-only actions.
  Examples: open an app, browse a website, create a user file, set wallpaper, type text, wait, download from a user-provided URL.

REVIEW_REQUIRED
  The plan contains steps that modify system state, but are not inherently malicious.
  Examples: shell commands that write/move/rename files, form submissions with sensitive data, installing packages, modifying system settings, creating executable scripts.

UNSAFE
  The plan contains steps that could cause serious irreversible harm or exfiltrate data.
  Examples: rm -rf on system paths, disk formatting, reading /etc/passwd or SSH keys, sending data to external servers not requested by the user, any command designed to escalate privileges or disable security tools.

═══════════════════════════════════════════════
CLASSIFICATION GUIDE
═══════════════════════════════════════════════

open_application       → always SAFE
set_wallpaper          → always SAFE
browser_open           → SAFE (unless URL is clearly malicious/phishing)
browser_fill           → SAFE for search queries; REVIEW_REQUIRED for payment/credential forms
browser_click          → SAFE unless clicking a known dangerous action (e.g. "confirm delete account")
type_text              → SAFE unless content contains credentials being typed into unknown fields
create_file            → SAFE for user files; REVIEW_REQUIRED for scripts in system directories
create_folder          → always SAFE
wait                   → always SAFE
download_file          → SAFE for user-provided URLs to known file types; REVIEW_REQUIRED for executables (.exe, .sh, .bat)
run_shell_command      → REVIEW_REQUIRED by default; UNSAFE if it matches destructive patterns below

Destructive shell patterns that always trigger UNSAFE:
  - rm -rf / or rm -rf /* or rm -rf ~
  - format, mkfs, dd if=... of=/dev/...
  - chmod 777 /etc or similar system-wide permission changes
  - cat /etc/passwd, cat ~/.ssh/id_rsa, or reading any credential files
  - curl | bash or wget | sh (remote code execution)
  - any command piping to an external server (e.g. curl -d @/etc/passwd https://...)
  - shutdown, reboot, halt, poweroff

═══════════════════════════════════════════════
OUTPUT SCHEMA
═══════════════════════════════════════════════

{
  "verdict": "SAFE",
  "confidence": 95,
  "risks": ["brief description of each risk, or 'none' if SAFE"],
  "safe_steps": [1, 2, 3],
  "risky_steps": [],
  "recommendation": "One sentence describing what the user should know before executing."
}

═══════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════

PLAN: set_wallpaper + open_application
OUTPUT:
{
  "verdict": "SAFE",
  "confidence": 99,
  "risks": ["none"],
  "safe_steps": [1, 2],
  "risky_steps": [],
  "recommendation": "This plan is safe to execute."
}

---

PLAN: browser_open youtube.com + browser_fill search bar + browser_click search button
OUTPUT:
{
  "verdict": "SAFE",
  "confidence": 99,
  "risks": ["none"],
  "safe_steps": [1, 2, 3],
  "risky_steps": [],
  "recommendation": "This plan is safe to execute."
}

---

PLAN: run_shell_command "npm install" + create_file "package.json"
OUTPUT:
{
  "verdict": "REVIEW_REQUIRED",
  "confidence": 88,
  "risks": ["npm install runs arbitrary third-party code from the internet"],
  "safe_steps": [2],
  "risky_steps": [1],
  "recommendation": "Review the npm install command — it will execute code from the npm registry. Proceed only if you trust the packages being installed."
}

---

PLAN: run_shell_command "rm -rf ~/Documents"
OUTPUT:
{
  "verdict": "UNSAFE",
  "confidence": 99,
  "risks": ["Permanently deletes all files in the Documents folder with no recovery"],
  "safe_steps": [],
  "risky_steps": [1],
  "recommendation": "This plan will permanently delete files. Do not execute."
}

---

PLAN: create_folder "Desktop/Projects" + create_file "Desktop/Projects/app.py" + run_shell_command "python Desktop/Projects/app.py"
OUTPUT:
{
  "verdict": "REVIEW_REQUIRED",
  "confidence": 82,
  "risks": ["Running a script executes code — verify the file content before proceeding"],
  "safe_steps": [1, 2],
  "risky_steps": [3],
  "recommendation": "Steps 1 and 2 are safe. Step 3 executes the created Python script — review the file content before running."
}`;

// ─── Provider Implementations ─────────────────────────────────────────────────

async function reviewWithGroq(plan: Plan): Promise<string> {
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });
  const response = await client.chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Review this execution plan:\n\n${JSON.stringify(plan, null, 2)}` },
    ],
    temperature: 0.1,
    max_tokens: 600,
    response_format: { type: 'json_object' },
  });
  return response.choices[0].message.content ?? '';
}

async function reviewWithAnthropic(plan: Plan): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-6',
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Review this execution plan:\n\n${JSON.stringify(plan, null, 2)}` }],
  });
  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Anthropic response type');
  return block.text;
}

async function reviewWithOpenAI(plan: Plan): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? 'gpt-4o',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Review this execution plan:\n\n${JSON.stringify(plan, null, 2)}` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 600,
  });
  return response.choices[0].message.content ?? '';
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

function buildFallbackReview(plan: Plan, reason: string): ReviewResult {
  return {
    verdict: 'REVIEW_REQUIRED',
    confidence: 0,
    risks: [`AI review unavailable: ${reason}`],
    safe_steps: [],
    risky_steps: plan.steps.map(s => s.step_number),
    recommendation: 'AI safety review failed. Manually inspect each step before executing.',
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateReview(raw: string, plan: Plan): ReviewResult {
  let json = raw.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  const review = JSON.parse(json) as ReviewResult;

  // Ensure verdict is one of the three valid values
  if (!['SAFE', 'UNSAFE', 'REVIEW_REQUIRED'].includes(review.verdict)) {
    throw new Error(`Invalid verdict: "${review.verdict}"`);
  }

  // Fill defaults for any missing optional fields
  if (!Array.isArray(review.risks))       review.risks = ['none'];
  if (!Array.isArray(review.safe_steps))  review.safe_steps = [];
  if (!Array.isArray(review.risky_steps)) review.risky_steps = [];
  if (!review.recommendation)             review.recommendation = '';
  if (review.confidence == null)          review.confidence = 80;

  return review;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function reviewPlan(plan: Plan): Promise<ReviewResult> {
  const provider = (process.env.AI_PROVIDER ?? 'groq').toLowerCase();
  console.log(`[Reviewer] Auditing ${plan.steps.length}-step plan...`);

  let raw: string;

  try {
    if (provider === 'groq')           raw = await reviewWithGroq(plan);
    else if (provider === 'anthropic') raw = await reviewWithAnthropic(plan);
    else                               raw = await reviewWithOpenAI(plan);
  } catch (err) {
    console.warn('[Reviewer] Provider call failed:', (err as Error).message);
    return buildFallbackReview(plan, (err as Error).message);
  }

  try {
    const review = validateReview(raw, plan);
    console.log(`[Reviewer] ✓ Verdict: ${review.verdict} (${review.confidence}% confidence)`);
    return review;
  } catch (err) {
    console.warn('[Reviewer] Could not parse response:', (err as Error).message);
    return buildFallbackReview(plan, 'Could not parse reviewer response');
  }
}