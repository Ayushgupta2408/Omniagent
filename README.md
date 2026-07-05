# NEXUS — AI Automation Agent

NEXUS is a local AI agent that automates tasks on your computer by understanding plain English. You describe what you want, it figures out the steps and does it.

It can browse the web, control desktop apps, manage files, send WhatsApp messages, and more — all without you touching a browser or writing any code.

![NEXUS Interface](docs/screenshot.png)

---

## What it can do

- **Web automation** — search Bing, open articles, scrape results, fill forms
- **File operations** — create files, run Python/Node scripts, open in VSCode or Notepad
- **Desktop apps** — open and control native Windows apps
- **WhatsApp** — send messages, make voice/video calls, read chats
- **Wallpaper** — set desktop wallpaper from a search query or local file
- **Excel/Word** — generate spreadsheets and documents from live data
- **Research** — search a topic, read multiple articles, summarize into a report

Some example prompts that work out of the box:

```
Search for the latest AI news and make an Excel sheet with summaries
Open Spotify and search for lofi hip hop
Send a WhatsApp message to John saying I'm running late
Create a Python web scraper and open it in VSCode
Set my wallpaper to a cyberpunk city at night
Find Python developer jobs in Bangalore on LinkedIn and save to Excel
```

---

## How it works

You type a task → an AI (Groq by default, free) converts it into a step-by-step plan → a safety reviewer checks the plan → you approve → NEXUS executes each step and shows you live progress.

If a step fails mid-execution, NEXUS automatically replans from the current state and tries a different approach instead of giving up.

---

## Prerequisites

- **Node.js** 18 or higher
- **Python** 3.8 or higher
- A free **Groq API key** — get one at [console.groq.com](https://console.groq.com) (no credit card needed)

---

## Setup

**1. Clone the repo**
```bash
git clone https://github.com/yourusername/nexus.git
cd nexus
```

**2. Install dependencies**
```bash
# Backend
cd server && npm install

# Frontend
cd ../web && npm install
```

**3. Install Playwright (browser automation)**
```bash
cd ../server
npx playwright install chromium
```

**4. Set up your API key**
```bash
cp .env.example .env
```

Open `server/.env` and fill in your Groq key:
```
AI_PROVIDER=groq
GROQ_API_KEY=your_key_here
```

**5. (Optional) Set up WhatsApp**

Only needed if you want WhatsApp features. Run this once and scan the QR code with your phone:
```bash
cd server && npm run auth
```

---

## Running NEXUS

Open two terminals:

**Terminal 1 — Backend**
```bash
cd server
npm run dev
```

**Terminal 2 — Frontend**
```bash
cd web
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Project structure

```
nexus/
├── server/                  # Node.js + TypeScript backend
│   ├── src/
│   │   ├── ai/
│   │   │   ├── planner.ts       # Converts prompts → execution plans
│   │   │   ├── reviewer.ts      # Safety review before execution
│   │   │   └── examples/        # Few-shot examples for the planner
│   │   ├── executor/
│   │   │   ├── stepExecutor.ts  # Runs each step
│   │   │   ├── Browserengine.ts # 5-tier browser automation
│   │   │   ├── desktopEngine.ts # Native app automation
│   │   │   └── whatsappClient.ts
│   │   └── utils/
│   │       ├── memory.ts        # Persistent task memory
│   │       ├── autoFix.ts       # Auto-repairs failed scripts
│   │       └── selectorMemory.ts # Remembers working CSS selectors
│   └── scripts/
│       └── desktop_agent.py     # Python layer for native UI automation
│
├── web/                     # Next.js frontend
│   ├── app/page.tsx             # Main UI
│   └── components/
│       ├── PlanDisplay.tsx      # Shows the execution plan + live progress
│       ├── ActivityLog.tsx      # Real-time activity feed
│       └── PromptInput.tsx      # Task input
│
└── electron/                # Desktop wrapper (optional)
```

---

## Switching AI providers

NEXUS works with Groq (free), Anthropic, or OpenAI. Change the provider in your `.env`:

```bash
# Groq (free, recommended)
AI_PROVIDER=groq
GROQ_API_KEY=your_key_here
GROQ_MODEL=llama-3.3-70b-versatile

# Anthropic
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_key_here

# OpenAI
AI_PROVIDER=openai
OPENAI_API_KEY=your_key_here
```

---

## Memory

After each task, NEXUS saves a one-line summary to `~/nexus-logs/MEMORY.md`. On the next task, it reads this file so it knows your history and preferences. You can open and edit this file anytime — it's just plain Markdown.

---

## Known limitations

- Browser automation works on most sites but some heavily protected sites (LinkedIn login pages, Google search) may block it
- WhatsApp requires a one-time QR scan setup and your phone must stay connected
- Desktop app automation (`app_click`, `app_type`) is Windows-only
- Very long research tasks (15+ steps) can occasionally hit Groq's free tier rate limits — just wait 60 seconds and try again

---

## Logs

Execution logs are saved to `~/nexus-logs/`:
- `executions.jsonl` — full history of every task run
- `MEMORY.md` — human-readable summary of recent tasks
- `selector-memory.json` — cached CSS selectors that have worked before (makes repeat tasks faster)

---

## Built with

- [Next.js](https://nextjs.org) — frontend
- [Express](https://expressjs.com) + [WebSocket](https://github.com/websockets/ws) — backend
- [Playwright](https://playwright.dev) — browser automation
- [Groq](https://groq.com) — AI inference (free tier)
- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) — WhatsApp integration
- [Electron](https://www.electronjs.org) — optional desktop wrapper

---

## License

MIT