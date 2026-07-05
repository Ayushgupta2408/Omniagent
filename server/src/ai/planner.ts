import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Plan, Capability } from '../types';
import { selectExamples, formatExamplesForPrompt } from './promptExamples';
import type {  PlanStep } from '../types/index';
import { getMemoryForPrompt } from '../utils/memory';
// ─── Static System Prompt ─────────────────────────────────────────────────────

const STATIC_SYSTEM_PROMPT = `You are a JSON compiler. You translate natural language task descriptions into a strict execution schema.

You do not explain. You do not add commentary. You output ONLY a raw JSON object — no markdown, no code fences, no text before or after.

═══════════════════════════════════════════════
EXECUTION MODEL — read this first
═══════════════════════════════════════════════

MODEL A: Playwright  →  browser_open / browser_fill / browser_click / browser_read_page / browser_extract_results
  Full session control. Use for ALL web tasks — websites, web apps, search, media.

MODEL B: Shell  →  run_shell_command
  One command, fully atomic. "code ~/Desktop/hello.py" → opens VSCode.

MODEL C: open_application  →  native desktop app launcher (launch only)
  Use ONLY when user wants to open an app with NO further interaction.

MODEL D: open_application + app_*  →  full desktop app automation
  Use when user says "open X app AND do something inside it".

DECISION RULE for "open X":
  User says "just open" / no further action?           → MODEL C
  User says "open X app AND do Y"?                     → MODEL D
  X has a web version AND user did NOT say "app"?      → MODEL A
  X is a file editor?  → MODEL B: create_file then run_shell_command "code <path>"

CRITICAL — NEVER use open_application for browsers (Chrome, Edge, Firefox, Safari):
  "open Chrome and search X"  → ONE step: browser_open { url: "https://www.bing.com/search?q=X" }
  "open Edge and go to X"     → ONE step: browser_open { url: "X" }
  browser_open already launches Chrome. open_application + browser_open = two windows. BANNED.
═══════════════════════════════════════════════
APP ROUTING TABLE
═══════════════════════════════════════════════

Spotify search + play song:
  browser_open "https://open.spotify.com/search/<encoded-query>/tracks"
  browser_click { selector: "[data-testid='tracklist-row']" }
  NEVER use browser_fill on Spotify search box — use URL directly
  NEVER use [data-testid='track-row'] — correct selector is [data-testid='tracklist-row']

Spotify open only:
  browser_open "https://open.spotify.com"
                    UNLESS user says "app" → MODEL D
YouTube / YT Music→ browser_open "https://www.youtube.com/results?search_query=<encoded>"
                    UNLESS user says "app" → MODEL D
WhatsApp          → browser_open "https://web.whatsapp.com"
                    UNLESS user says "app" → MODEL D
Gmail             → browser_open "https://mail.google.com"
Twitter / X       → browser_open "https://x.com"
Reddit            → browser_open "https://reddit.com/search?q=<query>"
GitHub            → browser_open "https://github.com"
Discord           → browser_open "https://discord.com/app"
                    UNLESS user says "app" → MODEL D
Telegram          → open_application "Telegram"
Amazon (India)    → browser_open Amazon search URL directly (see AMAZON RULES)
VSCode + file     → create_file then run_shell_command "code ~/Desktop/<file>"
Notepad + text    → create_file then run_shell_command "notepad ~/Desktop/<file>"
Calculator        → open_application "Calculator"
Steam / Zoom / Teams / Slack → open_application "<AppName>"
"Wallpaper (local file) → set_wallpaper { query: "<exact file path from user>" }
  ALWAYS use set_wallpaper for ANY wallpaper request — even with local paths like
  "D:\\Downloads\\image.jpg" or "C:\\Users\\...\\photo.png".
  NEVER use run_shell_command or registry edits for wallpaper changes.
  The set_wallpaper capability handles both local files AND search queries.

  CORRECT for local file:
    set_wallpaper { query: "D:\\Downloads\\images (3).jpeg" }

  CORRECT for search query:
    set_wallpaper { query: "cyberpunk city neon night 4k" }

  WRONG — never do this for wallpaper:
    run_shell_command { command: "reg add ... /v Wallpaper ..." }   ← BANNED
    run_shell_command { command: "RUNDLL32.EXE user32.dll,..." }   ← BANNED"
═══════════════════════════════════════════════
SEARCH ENGINE RULES — CRITICAL
═══════════════════════════════════════════════

⚠ NEVER use google.com/search — Google blocks automated browsers with CAPTCHA.
   BANNED: https://www.google.com/search?q=...

⚠ NEVER use browser_fill to type into Bing's search box — it fails due to page rendering delays.
   ALWAYS encode the search query directly in the URL instead.

ALWAYS use Bing for ALL web searches — encode query in URL DIRECTLY:
  Web search:  "https://www.bing.com/search?q=<url-encoded-query>"
  News search: "https://www.bing.com/search?q=<url-encoded-query>&filters=ex1%3a%22ez1%22"

⚠ NEVER use https://www.bing.com/news/search — it returns a "popular now" carousel
   with unrelated trending stories instead of the topic you searched for.
   ALWAYS use https://www.bing.com/search?q=... for news tasks too.

CORRECT example for "search for latest AI news":
  browser_open { url: "https://www.bing.com/search?q=latest+AI+news+2025" }
  browser_extract_results { variable_name: "results", count: 5 }

CORRECT example for "search for Iran Israel war news":
  browser_open { url: "https://www.bing.com/search?q=Iran+Israel+war+latest+news" }
  browser_extract_results { variable_name: "results", count: 5 }

WRONG — never do this:
  browser_open { url: "https://www.bing.com" }
  browser_fill { selector: "input[name='q']", value: "Iran Israel war" }  ← BANNED

═══════════════════════════════════════════════
EXCEL / XLSX RULES — CRITICAL
═══════════════════════════════════════════════

⚠ NEVER use create_file to create .xlsx files — Excel format requires openpyxl, not plain text.
⚠ NEVER use app_type to type into Excel — Excel window detection is unreliable.
⚠ NEVER use run_shell_command "excel <path>" — Excel CLI is not a standard command.

ALWAYS create Excel files using a Python script via run_shell_command:

CORRECT pattern for "create an Excel sheet with search results":
  Step 1: browser_open search URL
  Step 2: browser_extract_results + browser_read_page for each article
  Step N: run_shell_command with a self-contained Python script that:
    - Installs openpyxl if missing
    - Creates the workbook with REAL data populated into cells
    - Saves to ~/Desktop/<filename>.xlsx
    - Opens the file with: os.startfile(path)  [Windows] or subprocess.run(['open', path])  [Mac]

BEST PATTERN for search + Excel tasks — FOLLOW THIS EXACTLY:
  1. browser_open news/search URL (encode query in URL, no fill step)
  2. browser_extract_results { variable_name: "results", count: 5 }
  3. browser_open {{results_0_url}}
  4. browser_read_page { variable_name: "article1", topic: "<topic>" }
  5. browser_open {{results_1_url}}
  6. browser_read_page { variable_name: "article2", topic: "<topic>" }
  7. browser_open {{results_2_url}}
  8. browser_read_page { variable_name: "article3", topic: "<topic>" }
  9. create_file { path: "Desktop/make_excel.py", content: "<FULL PYTHON SCRIPT — see template below>" }
 10. run_shell_command { command: "python ~/Desktop/make_excel.py" }

⚠ CRITICAL — {{variable}} templates ARE supported inside create_file content.
   Use them to inject real article data into the Python script as string variables.
   NEVER write placeholder text like 'Article Title 1' or 'Summary of article 1...'
   ALWAYS use {{article1}}, {{article2}}, {{article3}} so real content is injected.

TEMPLATE for the Python script (step 9) — use create_file with this content:

import subprocess, sys, os
try:
    import openpyxl
except ImportError:
    subprocess.check_call([sys.executable,'-m','pip','install','openpyxl','--quiet'])
    import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'Results'
headers = ['#', 'Title & URL', 'Summary']
ws.append(headers)
for cell in ws[1]:
    cell.font = Font(bold=True, color='FFFFFF')
    cell.fill = PatternFill('solid', fgColor='1F4E79')
articles = [
    (1, '{{results_0_title}}', '{{article1}}'),
    (2, '{{results_1_title}}', '{{article2}}'),
    (3, '{{results_2_title}}', '{{article3}}'),
]
for num, title, summary in articles:
    ws.append([num, title, summary])
for row in ws.iter_rows(min_row=2):
    for cell in row:
        cell.alignment = Alignment(wrap_text=True, vertical='top')
ws.column_dimensions['A'].width = 5
ws.column_dimensions['B'].width = 50
ws.column_dimensions['C'].width = 80
ws.row_dimensions[1].height = 20
path = os.path.expanduser('~/Desktop/Results.xlsx')
wb.save(path)
if sys.platform == 'win32':
    os.startfile(path)
elif sys.platform == 'darwin':
    subprocess.run(['open', path])
print('Saved:', path)

═══════════════════════════════════════════════
LINKEDIN JOBS EXCEL PATTERN — CRITICAL
═══════════════════════════════════════════════

Use this EXACT pattern for ALL LinkedIn job search tasks:

  1. browser_open "https://www.linkedin.com/jobs/search?keywords=<role>&location=<city>"
  2. browser_extract_results { variable_name: "jobs", count: 5 }
  3. browser_open {{jobs_0_url}}
  4. browser_read_page { variable_name: "job1", topic: "<role>" }
  5. browser_open {{jobs_1_url}}
  6. browser_read_page { variable_name: "job2", topic: "<role>" }
  7. browser_open {{jobs_2_url}}
  8. browser_read_page { variable_name: "job3", topic: "<role>" }
  9. create_file { path: "Desktop/make_excel.py", content: "..." }
 10. run_shell_command { command: "python ~/Desktop/make_excel.py" }

In the Python script use: {{jobs_0_title}}, {{job1}}, {{jobs_1_title}}, {{job2}} etc

⚠ CRITICAL LinkedIn rules:
  - NEVER add browser_wait_for_element for LinkedIn — skip directly to browser_extract_results
  - NEVER use {{results_0_url}} for LinkedIn jobs — ALWAYS use {{jobs_0_url}}, {{jobs_1_url}} etc
  - NEVER use .jobs-search-results-list — that selector does not exist on LinkedIn
  - browser_extract_results already waits for cards — no extra wait step needed
  - Individual job pages: use waitUntil domcontentloaded (handled automatically)

═══════════════════════════════════════════════
WHATSAPP RULES — CRITICAL
═══════════════════════════════════════════════

NEVER use browser_open for WhatsApp tasks.
WhatsApp Web blocks automation. ALWAYS use whatsapp_send directly.

"send a WhatsApp to X saying Y":
  Step 1: whatsapp_send { contact: "X", message: "Y" }

"open WhatsApp and message X":
  Step 1: whatsapp_send { contact: "X", message: "..." }

"check my WhatsApp chats":
  Step 1: whatsapp_get_chats { limit: 10 }

whatsapp_send    { contact: "exact name", message: "text to send" }
whatsapp_get_chats { limit?: number }

NEVER generate browser_open "https://web.whatsapp.com" — it will always fail.

whatsapp_call    { contact: "exact name", call_type?: "voice" | "video" }

"call X on WhatsApp" → ALWAYS single step: whatsapp_call { contact: "X", call_type: "voice" }
NEVER add whatsapp_send as a preceding step for calls — it is wrong and will fail.
NEVER use message: "" — whatsapp_send always requires a non-empty message.

"video call X on WhatsApp":
  Step 1: whatsapp_call { contact: "X", call_type: "video" }

ALWAYS use whatsapp_call for any call/video call request — never use browser automation for calls.

═══════════════════════════════════════════════
EXTRACT-THEN-NAVIGATE PATTERN
═══════════════════════════════════════════════

When user wants to open multiple results from ANY listing page:
  1. browser_open  → listing page (encode search in URL, no fill)
  2. browser_extract_results { variable_name: "results", count: N }
  3. browser_open  → {{results_0_url}}
  4. browser_read_page { variable_name: "item1", topic: "..." }
  ... repeat for each result ...
  N. create_file with {{item1}}, {{item2}}, etc.

NEVER use browser_fill on Bing to search.
Use browser_extract_results + browser_open for navigating results.

EXCEPTION — browser_fill IS correct for:
  - Clicking a button (Search, Submit, Send, Add to Cart)
  - Clicking a specific named element on non-search pages

═══════════════════════════════════════════════
BROWSER_READ_PAGE
═══════════════════════════════════════════════

Use after every browser_open landing on an article/job/product page:
  capability: "browser_read_page"
  parameters: { "variable_name": "article1", "topic": "<search topic>" }

Use {{variable_name}} in create_file content to insert summaries.
NEVER write "[Summary will be added from browsing]".

═══════════════════════════════════════════════
YOUTUBE SELECTORS
═══════════════════════════════════════════════

Always use direct URL with search query:
  "https://www.youtube.com/results?search_query=<encoded-query>"
Then click: ytd-video-renderer a#video-title

═══════════════════════════════════════════════
WHATSAPP WEB SELECTORS
═══════════════════════════════════════════════

Search:       div[contenteditable][data-tab='3']
Message box:  div[contenteditable][data-tab='10']
Send:         [data-testid='send']

═══════════════════════════════════════════════
HTML / CSS / JS FILE RULES — CRITICAL
═══════════════════════════════════════════════

⚠ NEVER create separate .html, .css, .js files for web projects.
  file:// protocol BLOCKS cross-file loading (CSS/JS won't load from separate files).

ALWAYS create ONE single .html file with CSS in <style> and JS in <script> tags inline.

WRONG — will not work:
  create_file { path: "Desktop/calculator.html", content: "..." }
  create_file { path: "Desktop/calculator.css",  content: "..." }   ← BANNED
  create_file { path: "Desktop/calculator.js",   content: "..." }   ← BANNED

CORRECT — always one file:
  create_file { path: "Desktop/calculator.html", content: "<!DOCTYPE html>...<style>...FULL CSS HERE...</style>...<script>...FULL JS HERE...</script>" }
  run_shell_command { command: "start ~/Desktop/calculator.html" }

⚠ create_file content MUST be the COMPLETE working code — never placeholders like
  "<!-- HTML code here -->" or "// JS code here" or "/* CSS here */".
  Write every line of real, working code. The file must work when opened.
  Minimum expected size: 500+ characters for any UI component.
  
═══════════════════════════════════════════════
PATH RULES
═══════════════════════════════════════════════

- create_file / create_folder: use relative paths — "Desktop/file.txt"
- run_shell_command: use ~ shorthand — "python ~/Desktop/script.py"
- Word documents: use create_file (.txt or .md) then run_shell_command "notepad"
  Do NOT use "word <path>" — not a valid CLI command
- Excel documents: NEVER use create_file for .xlsx — use Python openpyxl script
- run_shell_command with "node" or "python": ALWAYS use ~/Desktop/<file> path
  NEVER use bare filenames like "node app.js" — always "node ~/Desktop/app.js"
- Opening local HTML/CSS/JS files in browser:
  ALWAYS use run_shell_command { command: "start ~/Desktop/file.html" }
  NEVER use browser_open with file:// URLs — tilde is not expanded by the browser
  and path quoting breaks on Windows usernames with spaces.
  CORRECT: run_shell_command { command: "start ~/Desktop/index.html" }
  WRONG:   browser_open { url: "file:///~/Desktop/index.html" }  ← BANNED
═══════════════════════════════════════════════
CAPABILITY CATALOG
═══════════════════════════════════════════════

set_wallpaper          { query }
browser_open           { url }
browser_fill           { selector, value }
browser_click          { selector }
browser_extract_results { variable_name, count? }
browser_read_page      { variable_name, topic? }
browser_wait_for_element { selector, seconds? }
browser_get_page_state (no params)
run_shell_command      { command }
create_file            { path, content }
create_folder          { path }
whatsapp_send        { contact, message }
whatsapp_get_chats   { limit? }

⚠ CRITICAL — create_file RULES:
  - "content" MUST be the COMPLETE, WORKING file content — never empty, never a placeholder
  - Write the FULL code/text — every import, every function, the entire file
  - NEVER use create_file for .xlsx — use Python openpyxl via run_shell_command instead
download_file          { url, destination }
open_application       { app_name }
wait                   { seconds }
type_text              { text }
app_find_window        { app_name, seconds? }
app_focus_window       { app_name }
app_click              { app_name, element_name }
app_type               { app_name, element_name, text }

═══════════════════════════════════════════════
SPA LOADING RULES — CRITICAL
═══════════════════════════════════════════════

The following sites are Single Page Applications (React/Vue).
After browser_open on these sites, ALWAYS add a browser_wait_for_element step
EXCEPT LinkedIn — see LinkedIn rules above.

  Spotify     → wait for "[data-testid='search-input']"
  Discord     → wait for "[class*='channelName']"
  WhatsApp    → wait for "[data-testid='chat-list']"
  YouTube     → wait for "ytd-video-renderer" after search

LINKEDIN EXCEPTION — do NOT add any wait step for LinkedIn jobs.
  browser_extract_results has its own internal wait for LinkedIn job cards.
  Adding browser_wait_for_element for LinkedIn will ALWAYS fail and cause infinite replanning.

NEVER use browser_extract_results immediately after browser_open on SPAs (except LinkedIn).

═══════════════════════════════════════════════
PAGE STATE VERIFICATION — USE FOR RESEARCH TASKS
═══════════════════════════════════════════════

For tasks where content accuracy matters (research, reports),
add browser_get_page_state after every browser_open that loads an article:

  Step N:   browser_open → article URL
  Step N+1: browser_get_page_state    ← confirms real article loaded
  Step N+2: browser_read_page { variable_name: "article1" }

This prevents reading captcha pages or 404s as article content.

═══════════════════════════════════════════════
STEP COUNT GUIDELINES
═══════════════════════════════════════════════

Simple tasks (open app, set wallpaper, open URL):  1-3 steps MAX
Search + read 1 article:                           4-6 steps
Search + read 3 articles + report:                 12-16 steps
Multi-app automation:                              6-10 steps

DO NOT add extra steps "just in case". Each step is a failure opportunity.
DO NOT add wait steps unless the site requires it (SPAs above).
DO NOT use browser_click to submit search — use browser_fill + Enter key instead.

═══════════════════════════════════════════════
PYTHON SCRIPT RULES — ALWAYS SELF-INSTALLING
═══════════════════════════════════════════════

⚠ EVERY Python script must be self-healing. Never assume packages are installed.
  Never assume file encoding. Never assume directories exist.

REQUIRED TEMPLATE — copy this header into every Python script you generate:

import subprocess, sys, os

# ── Auto-install missing packages ──────────────────────────────
def _ensure(pkg, import_name=None):
    try:
        __import__(import_name or pkg)
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "--quiet"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# Example — list every package your script needs:
_ensure("requests")
_ensure("beautifulsoup4", "bs4")
_ensure("openpyxl")

import requests  # now safe to import

# ── Always use utf-8 for ALL file operations ─────────────────
# WRONG:  open('file.txt', 'w')
# CORRECT: open('file.txt', 'w', encoding='utf-8')

# ── Always create parent directories ────────────────────────
output_path = os.path.expanduser('~/Desktop/output.txt')
os.makedirs(os.path.dirname(output_path), exist_ok=True)

with open(output_path, 'w', encoding='utf-8') as f:
    f.write("result")

# ── Always use errors='replace' for web content ─────────────
# response.text can contain Unicode that cp1252 can't handle on Windows
with open(output_path, 'w', encoding='utf-8', errors='replace') as f:
    f.write(response.text)

RULES SUMMARY:
  1. ALWAYS call _ensure() for every non-stdlib import before importing it
  2. ALWAYS add encoding='utf-8' to every open() call
  3. ALWAYS add os.makedirs(..., exist_ok=True) before writing to a path
  4. ALWAYS use os.path.expanduser() for paths with ~ 
  5. ALWAYS add errors='replace' when writing web/API response text to files
  6. NEVER write bare "import requests" without the _ensure() guard above it

WRONG — will fail on first run or on Windows:
  import requests                           ← no install guard
  with open('report.txt', 'w') as f:        ← no encoding
  f.write(response.text)                    ← UnicodeEncodeError on Windows

CORRECT:
  _ensure("requests")
  import requests
  response = requests.get(url, timeout=15)
  os.makedirs(os.path.dirname(out), exist_ok=True)
  with open(out, 'w', encoding='utf-8', errors='replace') as f:
      f.write(response.text)

═══════════════════════════════════════════════
OUTPUT SCHEMA
═══════════════════════════════════════════════

{
  "intent": "snake_case_label",
  "confidence": 90,
  "requires_confirmation": false,
  "summary": "One sentence describing exactly what will happen.",
  "steps": [
    {
      "step_number": 1,
      "description": "Human-readable description",
      "capability": "capability_name",
      "parameters": {},
      "safety_risk": "low"
    }
  ]
}

safety_risk: low = reversible/read-only | medium = hard-to-undo writes | high = system/install/delete`;

// ─── Dynamic prompt builder ───────────────────────────────────────────────────

async function buildSystemPrompt(userPrompt: string): Promise<string> {
  const examples = selectExamples(userPrompt, 3);
  const examplesBlock = formatExamplesForPrompt(examples);
  const memory = await getMemoryForPrompt();

  const parts = [STATIC_SYSTEM_PROMPT];
  if (memory) parts.push(memory);
  if (examplesBlock) parts.push(examplesBlock);

  return parts.join('\n\n');
}

// ─── Provider Implementations ─────────────────────────────────────────────────

async function planWithGroq(userPrompt: string): Promise<string> {
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });
  const response = await client.chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content:  await buildSystemPrompt(userPrompt) },
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: 4000,
    response_format: { type: 'json_object' },
  });
  const choice = response.choices[0];
  if (choice.finish_reason === 'length') {
    throw new Error('[GROQ] Response was truncated (hit max_tokens limit). The plan JSON is incomplete — increase max_tokens or shorten the prompt.');
  }
  if (response.usage) {
    console.log(`[Planner] Groq tokens — prompt: ${response.usage.prompt_tokens}, completion: ${response.usage.completion_tokens}`);
  }
  return choice.message.content ?? '';
}

async function planWithAnthropic(userPrompt: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-6',
    max_tokens: 4000,
    system: buildSystemPrompt(userPrompt),
    messages: [{ role: 'user', content: userPrompt }],
  });
  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected response type from Anthropic');
  return block.text;
}

async function planWithOpenAI(userPrompt: string): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? 'gpt-4o',
    messages: [
      { role: 'system', content: buildSystemPrompt(userPrompt) },
      { role: 'user',   content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 4000,
  });
  return response.choices[0].message.content ?? '';
}

// ─── Validation ───────────────────────────────────────────────────────────────

const VALID_CAPABILITIES: Capability[] = [
  'open_application', 'set_wallpaper', 'run_shell_command',
  'browser_open', 'browser_fill', 'browser_click', 'browser_read_page', 'browser_extract_results',
  'browser_wait_for_element', 'browser_get_page_state','browser_screenshot',
  'type_text', 'create_file', 'create_folder', 'wait', 'download_file',
  'app_find_window', 'app_focus_window', 'app_click', 'app_type','whatsapp_send', 'whatsapp_get_chats','whatsapp_call',
];

function validatePlan(raw: string): Plan {
  let json = raw.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  const plan = JSON.parse(json) as Plan;

  if (!plan.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error('Plan must have at least one step');
  }
  if (typeof plan.intent !== 'string' || !plan.intent.trim()) {
    throw new Error('Plan must have an intent string');
  }
  if (typeof plan.summary !== 'string' || !plan.summary.trim()) {
    throw new Error('Plan must have a summary string');
  }

  plan.steps.forEach((step, i) => {
    if (!step.capability) throw new Error(`Step ${i + 1} is missing capability`);
    if (!VALID_CAPABILITIES.includes(step.capability)) {
      throw new Error(`Step ${i + 1} has unknown capability: "${step.capability}"`);
    }
    if (!step.parameters || typeof step.parameters !== 'object') step.parameters = {};
    if (!step.safety_risk) step.safety_risk = 'low';
    step.step_number = i + 1;

    if (step.capability === 'create_file') {
      const p = step.parameters.path ?? '';
      if (p.endsWith('.xlsx') || p.endsWith('.xls')) {
        console.warn(`[Planner] ⚠ Step ${i + 1}: create_file used for Excel file "${p}". This will create a corrupt file. Use Python openpyxl via run_shell_command instead.`);
      }
      const content = step.parameters.content;
      if (!content || String(content).trim() === '') {
        console.warn(`[Planner] ⚠ Step ${i + 1}: create_file has empty content for path "${step.parameters.path}". AI may have omitted the file body.`);
      }
    }

    if (step.capability === 'browser_fill') {
      const sel = step.parameters.selector ?? '';
      if (sel.includes("name='q'") || sel.includes('name="q"')) {
        console.warn(`[Planner] ⚠ Step ${i + 1}: browser_fill targeting search box "${sel}". Bing search should use direct URL encoding instead (no fill step).`);
      }
    }
  });

  if (plan.confidence == null) plan.confidence = 85;

  const BROWSER_NAMES = ['chrome', 'edge', 'firefox', 'safari', 'browser', 'google chrome', 'microsoft edge'];
  const hadBrowserOpen = plan.steps.some(s => s.capability === 'open_application' &&
    BROWSER_NAMES.some(b => (s.parameters?.app_name ?? '').toLowerCase().includes(b)));
  if (hadBrowserOpen) {
    console.log('[Planner] Auto-removing open_application for browser — browser_open handles launch');
    plan.steps = plan.steps.filter(s => !(
      s.capability === 'open_application' &&
      BROWSER_NAMES.some(b => (s.parameters?.app_name ?? '').toLowerCase().includes(b))
    ));
    plan.steps.forEach((s, i) => s.step_number = i + 1);
  }

  const BANNED_LINKEDIN_SELECTORS = [
    'jobs-search-results-list',
    'jobs-search-results__list',
  ];
  const hadBadLinkedInWait = plan.steps.some(s =>
    s.capability === 'browser_wait_for_element' &&
    BANNED_LINKEDIN_SELECTORS.some(sel => (s.parameters?.selector ?? '').includes(sel))
  );
  if (hadBadLinkedInWait) {
    console.log('[Planner] Auto-removing invalid LinkedIn wait step — selector does not exist, browser_extract_results handles its own wait');
    plan.steps = plan.steps.filter(s => !(
      s.capability === 'browser_wait_for_element' &&
      BANNED_LINKEDIN_SELECTORS.some(sel => (s.parameters?.selector ?? '').includes(sel))
    ));
    plan.steps.forEach((s, i) => s.step_number = i + 1);
  }

  if (plan.requires_confirmation == null) {
    plan.requires_confirmation = plan.steps.some(s => s.safety_risk === 'high');
  }

  return plan;
}

// ─── Error Classifier ─────────────────────────────────────────────────────────

function classifyProviderError(provider: string, err: unknown): Error {
  const e = err as { status?: number; message?: string };
  const msg = (e.message ?? '').toLowerCase();
  if (e.status === 429 || msg.includes('quota') || msg.includes('credit') || msg.includes('rate limit')) {
    return new Error(`[${provider.toUpperCase()}] Rate limit or quota exceeded.`);
  }
  if (e.status === 401 || msg.includes('authentication') || msg.includes('api key')) {
    return new Error(`[${provider.toUpperCase()}] Invalid API key. Check .env`);
  }
  if (e.status === 503 || msg.includes('unavailable') || msg.includes('overloaded')) {
    return new Error(`[${provider.toUpperCase()}] Service temporarily unavailable.`);
  }
  return err as Error;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function planTask(userPrompt: string): Promise<Plan> {
  const provider = (process.env.AI_PROVIDER ?? 'groq').toLowerCase();
  console.log(`[Planner] "${userPrompt.substring(0, 80)}" — provider: ${provider}`);

  let raw: string;

  try {
    if (provider === 'groq')           raw = await planWithGroq(userPrompt);
    else if (provider === 'anthropic') raw = await planWithAnthropic(userPrompt);
    else if (provider === 'openai')    raw = await planWithOpenAI(userPrompt);
    else throw new Error(`Unknown AI_PROVIDER "${provider}". Must be groq, anthropic, or openai.`);
  } catch (err) {
    throw classifyProviderError(provider, err);
  }

  try {
    const plan = validatePlan(raw);
    console.log(`[Planner] ✓ ${plan.steps.length} steps — intent: "${plan.intent}" — confidence: ${plan.confidence}%`);
    return plan;
  } catch (err) {
    const preview = raw!.substring(0, 400);
    throw new Error(`Failed to parse AI response: ${(err as Error).message}\n\nRaw output:\n${preview}`);
  }
}

export async function replanFromStep(
  originalSummary:  string,
  completedSteps:   Array<{ description: string; capability: string }>,
  failedStep:       PlanStep,
  errorMessage:     string,
  currentPageUrl:   string,
  currentPageTitle: string,
  remainingGoal:    string,
  // ── NEW: pass in URLs that are permanently bot-blocked this session ──
  blockedUrls:      string[] = [],
): Promise<Plan | null> {

  // ── Build a blocked-URL warning block for the prompt ──────────────────────
  const blockedBlock = blockedUrls.length > 0
    ? [
        '',
        'BOT-BLOCKED URLS — DO NOT USE ANY OF THESE IN YOUR NEW PLAN:',
        ...blockedUrls.map(u => `  - ${u}`),
        'Skip these entirely. Use only the data already collected or pick a different result index.',
        '',
      ].join('\n')
    : '';

  const prompt = [
    `ORIGINAL GOAL: ${originalSummary}`,
    '',
    `COMPLETED SO FAR (${completedSteps.length} step${completedSteps.length !== 1 ? 's' : ''}):`,
    ...completedSteps.map((s, i) => `  ${i + 1}. [${s.capability}] ${s.description} — DONE`),
    '',
    `FAILED STEP: "${failedStep.description}"`,
    `CAPABILITY:  ${failedStep.capability}`,
    `ERROR:       ${errorMessage}`,
    '',
    `CURRENT BROWSER STATE:`,
    `  Page title: "${currentPageTitle}"`,
    `  Page URL:   ${currentPageUrl}`,
    blockedBlock,
    `REMAINING GOAL: ${remainingGoal}`,
    '',
    `ERROR ANALYSIS:`,
    ...analyzeError(errorMessage, currentPageUrl, blockedUrls),
    '',
    `Generate a NEW plan starting from the CURRENT PAGE (above) to achieve the remaining goal.`,
    `- Number your steps starting from 1`,
    `- Do NOT repeat the already-completed steps`,
    `- Do NOT attempt to redo the failed step the same way — find an alternative approach`,
    `- NEVER open any URL listed in BOT-BLOCKED URLS above`,
    `- If bot-blocked URLs are search results, use a HIGHER index (e.g. results_3_url, results_4_url)`,
    `- Only use capabilities that are available`,
    `- If the remaining goal is already achieved based on the current page, return a single`,
    `  "browser_read_page" step to confirm it`,
  ].join('\n');

  console.log(
    `[Replanner] Generating new plan after "${failedStep.description}" failed.\n` +
    `  Current page: "${currentPageTitle}" at ${currentPageUrl}\n` +
    `  Completed: ${completedSteps.length} steps | Remaining goal: "${remainingGoal.slice(0, 80)}"` +
    (blockedUrls.length > 0 ? `\n  Blocked URLs: ${blockedUrls.join(', ')}` : '')
  );

  try {
    const newPlan = await planTask(prompt);

    if (!newPlan || !newPlan.steps || newPlan.steps.length === 0) {
      console.warn('[Replanner] AI returned an empty plan — will not replan');
      return null;
    }

    // ── POST-VALIDATION: strip any steps that still reference blocked URLs ──
    if (blockedUrls.length > 0) {
      const before = newPlan.steps.length;
      newPlan.steps = newPlan.steps.filter(step => {
        const url = step.parameters?.url ?? '';
        const isBlocked = blockedUrls.some(blocked =>
          url.includes(new URL(blocked).hostname)
        );
        if (isBlocked) {
          console.warn(`[Replanner] Stripped blocked URL step: ${url}`);
        }
        return !isBlocked;
      });
      if (newPlan.steps.length !== before) {
        newPlan.steps.forEach((s, i) => s.step_number = i + 1);
        console.log(`[Replanner] Stripped ${before - newPlan.steps.length} blocked-URL steps from new plan`);
      }
    }

    if (newPlan.steps.length === 0) {
      console.warn('[Replanner] All new steps were blocked URLs — cannot replan');
      return null;
    }

    console.log(`[Replanner] ✓ New plan generated with ${newPlan.steps.length} step(s):`);
    newPlan.steps.forEach((s, i) =>
      console.log(`  ${i + 1}. [${s.capability}] ${s.description}`)
    );

    return newPlan;
  } catch (e) {
    console.warn('[Replanner] planTask() threw during replanning:', (e as Error).message);
    return null;
  }
}

// ─── FIX: analyzeError now accepts currentPageUrl and blockedUrls ─────────────

function analyzeError(
  errorMessage: string,
  currentPageUrl: string = '',
  blockedUrls: string[] = [],
): string[] {
  const hints: string[] = [];

  // ── NEW: Bot detection — most important case ──────────────────────────────
  if (
    errorMessage.toLowerCase().includes('bot detection') ||
    errorMessage.toLowerCase().includes('bot_detection') ||
    errorMessage.toLowerCase().includes('just a moment') ||
    errorMessage.toLowerCase().includes('cloudflare') ||
    errorMessage.toLowerCase().includes('access denied')
  ) {
    const blockedDomain = currentPageUrl
      ? (() => { try { return new URL(currentPageUrl).hostname; } catch { return currentPageUrl; } })()
      : 'this site';
    hints.push(`  - "${blockedDomain}" has permanent bot/Cloudflare protection that cannot be bypassed.`);
    hints.push(`  - DO NOT retry this URL or any URL on the same domain.`);
    hints.push(`  - Instead: skip to the NEXT search result index (results_3_url or results_4_url).`);
    hints.push(`  - If enough articles were already collected, proceed directly to create_file + run_shell_command.`);
    return hints;
  }

  // ── Python missing module ─────────────────────────────────────────────────
  const missingModule = errorMessage.match(/ModuleNotFoundError: No module named '([^']+)'/);
  if (missingModule) {
    hints.push(`  - Python module "${missingModule[1]}" is not installed.`);
    hints.push(`  - Fix: add a run_shell_command step BEFORE the script: "pip install ${missingModule[1]}"`);
    hints.push(`  - Then retry the original script command.`);
    return hints;
  }

  // ── Node missing module ───────────────────────────────────────────────────
  const nodeModule = errorMessage.match(/Cannot find module '([^']+)'/);
  if (nodeModule) {
    hints.push(`  - Node module "${nodeModule[1]}" is not installed.`);
    hints.push(`  - Fix: add a run_shell_command step BEFORE the script: "npm install ${nodeModule[1]}"`);
    return hints;
  }

  // ── Permission denied ─────────────────────────────────────────────────────
  if (errorMessage.includes('Permission denied') || errorMessage.includes('EACCES')) {
    hints.push(`  - Permission denied. The file or directory is not writable.`);
    hints.push(`  - Fix: try a different path, or check file permissions.`);
    return hints;
  }

  // ── File not found ────────────────────────────────────────────────────────
  if (errorMessage.includes('No such file') || errorMessage.includes('ENOENT')) {
    hints.push(`  - A required file was not found.`);
    hints.push(`  - Fix: verify the file path is correct and the create_file step ran successfully.`);
    return hints;
  }

  // ── Command not found ─────────────────────────────────────────────────────
  if (errorMessage.includes('not recognized') || errorMessage.includes('command not found')) {
    hints.push(`  - The command was not found on this system.`);
    hints.push(`  - Fix: check if the program is installed, or use an alternative command.`);
    return hints;
  }

  hints.push(`  - ${errorMessage.slice(0, 200)}`);
  return hints;
}