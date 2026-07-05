/**
 * browserEngine.ts  — NEXUS Smart Browser Engine v6
 * ─────────────────────────────────────────────────────────────────────────────
 * Week 3 changes applied:
 *
 *   TIER 5 — Vision Fallback (Gemini Flash)
 *     NEW: When all previous tiers fail, take a screenshot of the current page
 *          and send it to Google Gemini 1.5 Flash (FREE — 1500 req/day).
 *          Gemini sees the rendered pixels, not the DOM — recovers cases where:
 *            - Element has no aria-label, placeholder, or accessible name
 *            - Page uses canvas rendering with no DOM structure
 *            - Shadow DOM prevents Playwright from seeing the element
 *            - Heavily obfuscated class names (randomised by bundler)
 *          Requires GEMINI_API_KEY in .env (free at aistudio.google.com)
 *          Falls back gracefully if key is missing — just skips to throw.
 *
 * Week 2 changes (already present):
 *   MEMORY TIER (Tier -1) — selectorMemory integration
 *   FIX 2A — Progressive waits between tier escalations
 *   FIX 2B — Groq selector validation in Tier 2/3
 *
 * Human Typing:
 *   All fill() calls replaced with humanType() for visible character-by-character
 *   typing with randomised per-keystroke delay (40–90ms).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import OpenAI from 'openai';
import { recordSuccess, recordFailure, getBestSelector } from '../utils/selectorMemory';
import { humanType, humanDelay, sleep } from '../utils/humanTyping';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ElementAction = 'fill' | 'click';

export interface ActionResult {
  success:   boolean;
  strategy:  string;
  tier:      number;
  warning?:  string;
}

interface InteractiveElement {
  tag:          string;
  id?:          string;
  name?:        string;
  type?:        string;
  text?:        string;
  ariaLabel?:   string;
  placeholder?: string;
  href?:        string;
  role?:        string;
  classes?:     string;
  visible:      boolean;
  selector:     string;
}

// ─── Groq Client ─────────────────────────────────────────────────────────────

function getGroqClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.GROQ_API_KEY ?? '',
    baseURL: 'https://api.groq.com/openai/v1',
  });
}

async function askGroq(systemPrompt: string, userMessage: string, maxTokens = 400): Promise<string> {
  const client = getGroqClient();
  const response = await client.chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage  },
    ],
    temperature: 0.1,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  });
  return response.choices[0].message.content ?? '{}';
}

// ─── Site-Specific Handlers ──────────────────────────────────────────────────

async function handleGoogleSearchClick(
  page: import('playwright').Page,
  hint: string,
): Promise<ActionResult | null> {
  const url = page.url();
  if (!url.includes('google.com/search') && !url.includes('google.co')) return null;
  if (!hint.includes('h3')) return null;

  let index = 0;
  const nthMatch = hint.match(/nth-child\((\d+)\)/);
  if (nthMatch) index = parseInt(nthMatch[1], 10) - 1;

  try {
    const resultUrls = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a:has(h3)')) as HTMLAnchorElement[];
      return anchors
        .map(a => a.href)
        .filter(href => href && !href.includes('google.com') && href.startsWith('http'));
    });

    if (resultUrls.length > index) {
      const targetUrl = resultUrls[index];
      console.log(`[SiteHandler] Google result ${index}: navigating to ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(1500);
      return { success: true, strategy: `google-direct-nav:${targetUrl}`, tier: 0 };
    }

    const clicked = await page.evaluate((idx: number) => {
      const anchors = Array.from(document.querySelectorAll('a:has(h3)')) as HTMLAnchorElement[];
      const filtered = anchors.filter(a => {
        const href = a.href;
        return href && !href.includes('google.com') && href.startsWith('http');
      });
      if (filtered[idx]) { filtered[idx].click(); return true; }
      return false;
    }, index);

    if (clicked) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await sleep(1500);
      return { success: true, strategy: `google-js-click:index-${index}`, tier: 0 };
    }

    const allLinks = page.locator('a:has(h3)');
    const count = await allLinks.count();
    for (let i = 0, found = 0; i < count && found <= index; i++) {
      const href = await allLinks.nth(i).getAttribute('href').catch(() => '');
      if (!href || href.includes('google.com') || !href.startsWith('http')) continue;
      if (found === index) {
        await allLinks.nth(i).click({ timeout: 5000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await sleep(1500);
        return { success: true, strategy: `google-locator:index-${index}`, tier: 0 };
      }
      found++;
    }
  } catch (e) {
    console.warn('[SiteHandler] Google click failed:', (e as Error).message);
  }

  return null;
}

async function handleLinkedInClick(
  page: import('playwright').Page,
  hint: string,
): Promise<ActionResult | null> {
  const url = page.url();
  if (!url.includes('linkedin.com')) return null;

  let index = 0;
  const nthMatch = hint.match(/nth-child\((\d+)\)/);
  if (nthMatch) index = Math.max(0, parseInt(nthMatch[1], 10) - 1);

  const LINKEDIN_SELECTORS = [
    '.jobs-search-results__list-item',
    '.job-card-container',
    'li.scaffold-layout__list-item',
    '[data-occludable-job-id]',
    '.job-card-list__title',
  ];

  for (const sel of LINKEDIN_SELECTORS) {
    try {
      const items = page.locator(sel);
      const count = await items.count();
      if (count > index) {
        await items.nth(index).click({ timeout: 5000 });
        await sleep(1500);
        return { success: true, strategy: `linkedin:${sel}[${index}]`, tier: 0 };
      }
    } catch { /* try next */ }
  }

  return null;
}

async function handleBingClick(
  page: import('playwright').Page,
  hint: string,
): Promise<ActionResult | null> {
  const url = page.url();
  if (!url.includes('bing.com')) return null;

  let index = 0;
  const nthMatch = hint.match(/nth-of-type\((\d+)\)/);
  if (nthMatch) index = Math.max(0, parseInt(nthMatch[1], 10) - 1);

  try {
    const resultUrls = await page.evaluate(() => {
      const isNews = window.location.href.includes('/news/');

      if (isNews) {
        const newsLinks: string[] = [];
        document.querySelectorAll('a.title, a[class*="title"], .news-card a').forEach((el) => {
          const a = el as HTMLAnchorElement;
          if (a.href && !a.href.includes('bing.com') && a.href.startsWith('http')) {
            newsLinks.push(a.href);
          }
        });
        if (newsLinks.length === 0) {
          document.querySelectorAll('.news-card, [class*="newscard"], [class*="NewsCard"]').forEach((card) => {
            const a = card.querySelector('a[href]') as HTMLAnchorElement | null;
            if (a?.href && !a.href.includes('bing.com') && a.href.startsWith('http')) {
              newsLinks.push(a.href);
            }
          });
        }
        return newsLinks;
      }

      const webLinks: string[] = [];
      document.querySelectorAll('li.b_algo h2 a, li.b_algo .b_title a').forEach((el) => {
        const a = el as HTMLAnchorElement;
        if (a.href && !a.href.includes('bing.com') && a.href.startsWith('http')) {
          webLinks.push(a.href);
        }
      });
      if (webLinks.length === 0) {
        document.querySelectorAll('li.b_algo a[href]').forEach((el) => {
          const a = el as HTMLAnchorElement;
          if (a.href && !a.href.includes('bing.com') && a.href.startsWith('http') &&
              (a.textContent ?? '').trim().length > 15) {
            webLinks.push(a.href);
          }
        });
      }
      return webLinks;
    });

    console.log(`[SiteHandler] Bing: found ${resultUrls.length} result URLs, targeting index ${index}`);

    if (resultUrls.length > index) {
      const targetUrl = resultUrls[index];
      console.log(`[SiteHandler] Bing result ${index}: navigating to ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(1500);
      return { success: true, strategy: `bing-direct-nav:${targetUrl}`, tier: 0 };
    }

    const BING_SELECTORS = [
      'li.b_algo h2 a', 'li.b_algo .b_title a',
      'li.b_algo a[href]:not([href*="bing.com"])',
      '.news-card a.title', '.news-card a[href]:not([href*="bing.com"])',
      'a.title[href]:not([href*="bing.com"])', 'h2 a[href]:not([href*="bing.com"])',
    ];

    for (const sel of BING_SELECTORS) {
      try {
        const locs = page.locator(sel);
        const count = await locs.count();
        if (count > index) {
          const href = await locs.nth(index).getAttribute('href');
          if (href && !href.includes('bing.com')) {
            if (href.startsWith('http')) {
              await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            } else {
              await locs.nth(index).click({ timeout: 5000 });
              await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            }
            await sleep(1500);
            return { success: true, strategy: `bing-locator:${sel}[${index}]`, tier: 0 };
          }
        }
      } catch { /* try next */ }
    }

    const clicked = await page.evaluate((idx: number) => {
      const all = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const external = all.filter(a => {
        const rect = a.getBoundingClientRect();
        return a.href.startsWith('http') && !a.href.includes('bing.com') &&
               (a.textContent ?? '').trim().length > 15 &&
               rect.width > 0 && rect.height > 0;
      });
      if (external[idx]) { external[idx].click(); return true; }
      return false;
    }, index);

    if (clicked) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await sleep(1500);
      return { success: true, strategy: `bing-js-click:index-${index}`, tier: 0 };
    }

  } catch (e) {
    console.warn('[SiteHandler] Bing click failed:', (e as Error).message);
  }

  return null;
}

export async function extractAndOpenGoogleResults(
  page: import('playwright').Page,
  count: number = 3,
): Promise<string[]> {
  const urls = await page.evaluate((maxCount: number) => {
    const anchors = Array.from(document.querySelectorAll('a:has(h3)')) as HTMLAnchorElement[];
    return anchors
      .map(a => a.href)
      .filter(href => href && !href.includes('google.com') && href.startsWith('http'))
      .slice(0, maxCount);
  }, count);
  return urls;
}

// ─── DOM Scanner ──────────────────────────────────────────────────────────────

async function scanInteractiveElements(
  page: import('playwright').Page,
): Promise<InteractiveElement[]> {
  return page.evaluate(() => {
    const TAGS = [
      'button', 'a', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="menuitem"]',
      '[role="option"]', '[role="tab"]', '[role="searchbox"]',
    ];
    const elements: InteractiveElement[] = [];
    const seen = new Set<Element>();

    for (const tag of TAGS) {
      for (const el of Array.from(document.querySelectorAll(tag))) {
        if (seen.has(el)) continue;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < window.innerHeight * 2;

        let selector = el.tagName.toLowerCase();
        const id = el.getAttribute('id');
        const name = el.getAttribute('name');
        if (id) selector = `#${id}`;
        else if (name) selector = `${selector}[name="${name}"]`;

        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
        const ariaLabel = el.getAttribute('aria-label') ?? undefined;
        const placeholder = el.getAttribute('placeholder') ?? undefined;
        const href = el.getAttribute('href') ?? undefined;
        const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
        const classes = el.className?.toString().trim().slice(0, 60) ?? undefined;
        const type = el.getAttribute('type') ?? undefined;

        elements.push({
          tag: el.tagName.toLowerCase(),
          id: id ?? undefined, name: name ?? undefined, type,
          text: text || undefined, ariaLabel, placeholder, href, role, classes,
          visible, selector,
        });
      }
    }

    return elements.filter(e => e.visible).slice(0, 120);
  });
}

// ─── Accessibility Tree Snapshot ──────────────────────────────────────────────

async function getAccessibilitySnapshot(page: import('playwright').Page): Promise<string> {
  try {
    const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
    if (!snapshot) return '';
    return JSON.stringify(snapshot, null, 2).slice(0, 3000);
  } catch {
    return '';
  }
}

// ─── HTML Chunk Extractor ─────────────────────────────────────────────────────

async function getPageContext(page: import('playwright').Page): Promise<{
  url: string; title: string; html: string;
}> {
  const url   = page.url();
  const title = await page.title().catch(() => '');
  const html  = await page.evaluate(() => {
    const main = document.querySelector('main, #main, #content, [role="main"], body');
    return (main?.innerHTML ?? document.body.innerHTML).slice(0, 4000);
  }).catch(() => '');
  return { url, title, html };
}

// ─── FIX 2B: Element existence validator ─────────────────────────────────────

async function validateElementExists(
  page: import('playwright').Page,
  elementName: string
): Promise<boolean> {
  return page.evaluate((name: string) => {
    const testSelectors = [
      `[aria-label*="${name}" i]`,
      `[placeholder*="${name}" i]`,
      `[title*="${name}" i]`,
            `[name="${name}"]`,
      `[name*="${name}" i]`,
      `button`,
      `input`,
      `a[href]`,
    ];

    for (const sel of testSelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const text = (el.textContent ?? '').toLowerCase();
          const label = (el.getAttribute('aria-label') ?? '').toLowerCase();
          const placeholder = (el.getAttribute('placeholder') ?? '').toLowerCase();
          const nameLower = name.toLowerCase();
          const nameAttr = (el.getAttribute('name') ?? '').toLowerCase();
          if (text.includes(nameLower) || label.includes(nameLower) || placeholder.includes(nameLower) || nameAttr === nameLower || nameAttr.includes(nameLower)) {
            return true;
          }
        }
      }
    }
    return false;
  }, elementName);
}

// ─── URL Param Rewriter ───────────────────────────────────────────────────────

interface UrlRewriteResult {
  possible: boolean;
  newUrl?: string;
  reason?: string;
}

async function tryUrlParamFallback(
  page: import('playwright').Page,
  intent: string,
  _originalHint: string,
): Promise<UrlRewriteResult> {
  const url = page.url();

  if (url.includes('amazon.')) {
    const currentUrl = new URL(url);
    const k = currentUrl.searchParams.get('k') ?? '';

    const priceMatch = intent.match(/under\s*[₹$£€]?\s*(\d+)/i);
    if (priceMatch) {
      const price = parseInt(priceMatch[1], 10);
      const isIndia = url.includes('amazon.in');
      const maxPricePaise = isIndia ? price * 100 : price * 100;
      const newUrl = `${currentUrl.origin}/s?k=${encodeURIComponent(k)}&rh=p_36%3A-${maxPricePaise}&s=review-rank`;
      return { possible: true, newUrl, reason: `Encoded price filter in URL (max ${price})` };
    }

    if (intent.includes('first') || intent.includes('result') || intent.includes('click product')) {
      const firstProductUrl = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/dp/"]')) as HTMLAnchorElement[];
        const visible = links.filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.top > 0;
        });
        return visible[0]?.href ?? null;
      });
      if (firstProductUrl) {
        return { possible: true, newUrl: firstProductUrl, reason: 'Navigating directly to first product URL' };
      }
    }
  }

  if (url.includes('youtube.com') && intent.includes('search')) {
    const queryMatch = intent.match(/search["\s]+(?:for\s+)?["']?([^"']+)["']?/i);
    if (queryMatch) {
      const newUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(queryMatch[1])}`;
      return { possible: true, newUrl, reason: 'Encoded YouTube search in URL' };
    }
  }

  return { possible: false };
}

// ─── Fuzzy Text Match ─────────────────────────────────────────────────────────

const INTENT_KEYWORDS: Record<string, string[]> = {
  'add to cart':  ['add to cart', 'add to bag', 'add to basket', 'buy now', 'add item'],
  'search':       ['search', 'find', 'go', 'submit', 'look up'],
  'checkout':     ['checkout', 'proceed to checkout', 'buy now', 'place order', 'continue'],
  'next':         ['next', 'continue', 'proceed', 'forward'],
  'submit':       ['submit', 'send', 'go', 'ok', 'confirm'],
  'sign in':      ['sign in', 'log in', 'login', 'continue'],
  'close':        ['close', 'dismiss', 'cancel', 'x'],
  'first result': ['', ' '],
};

function fuzzyScore(hint: string, element: InteractiveElement): number {
  const hintLower = hint.toLowerCase();
  let score = 0;

  let intentKeywords: string[] = [];
  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    if (hintLower.includes(intent) || intent.includes(hintLower)) {
      intentKeywords = keywords;
      break;
    }
  }
  const hintWords = hintLower.split(/[\s\-_#./[\]>]+/).filter(w => w.length > 2);
  const allKeywords = [...new Set([...intentKeywords, ...hintWords])];

  const fields = [
    element.text?.toLowerCase() ?? '',
    element.ariaLabel?.toLowerCase() ?? '',
    element.placeholder?.toLowerCase() ?? '',
    element.id?.toLowerCase() ?? '',
    element.name?.toLowerCase() ?? '',
    element.classes?.toLowerCase() ?? '',
  ];

  for (const keyword of allKeywords) {
    if (!keyword) continue;
    for (const field of fields) {
      if (field.includes(keyword)) score += 2;
      if (field === keyword) score += 3;
    }
  }

  return score;
}

// ─── Tier 1: DOM Fuzzy Scan ───────────────────────────────────────────────────

async function tier1FuzzyDomScan(
  page: import('playwright').Page,
  hint: string,
  action: ElementAction,
  value?: string,
): Promise<ActionResult | null> {
  console.log('[Tier 1] DOM fuzzy scan starting...');

  const elements = await scanInteractiveElements(page);
  if (!elements.length) return null;

  const scored = elements
    .map(el => ({ el, score: fuzzyScore(hint, el) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    console.log('[Tier 1] No fuzzy matches found');
    return null;
  }

  const best = scored[0];
  console.log(`[Tier 1] Best match score=${best.score} selector="${best.el.selector}" text="${best.el.text?.slice(0, 40)}"`);

  if (best.score < 2) {
    console.log('[Tier 1] Score too low, skipping');
    return null;
  }

  try {
    const loc = page.locator(best.el.selector).first();
    await loc.waitFor({ state: 'visible', timeout: 3000 });

    if (action === 'fill' && value !== undefined) {
      // ── HUMAN TYPING: replaced loc.fill() with humanType() ──
       await humanType(loc, value, page);
    } else {
      await loc.click({ timeout: 2000 });
    }

    console.log(`[Tier 1] ✓ Success via fuzzy match: "${best.el.selector}"`);
    return { success: true, strategy: `fuzzy:${best.el.selector}`, tier: 1 };
  } catch {
    try {
      const jsClicked = await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) { el.click(); return true; }
        return false;
      }, best.el.selector);

      if (jsClicked) {
        console.log(`[Tier 1] ✓ Success via JS click: "${best.el.selector}"`);
        return { success: true, strategy: `fuzzy-js:${best.el.selector}`, tier: 1 };
      }
    } catch { /* fall through */ }
  }

  return null;
}

// ─── Tier 2: Accessibility Tree + Groq ───────────────────────────────────────

async function tier2AccessibilityGroq(
  page: import('playwright').Page,
  hint: string,
  action: ElementAction,
  value?: string,
): Promise<ActionResult | null> {
  console.log('[Tier 2] Accessibility tree + Groq starting...');

  const a11yTree = await getAccessibilitySnapshot(page);
  if (!a11yTree) {
    console.log('[Tier 2] No accessibility tree available');
    return null;
  }

  const systemPrompt = `You are a browser automation assistant. Given an accessibility tree of a web page, identify the best element to interact with.

Output ONLY raw JSON. No markdown, no explanation.

Schema:
{
  "found": true/false,
  "elementName": "exact name/label from the tree",
  "elementRole": "button/link/textbox/etc",
  "reasoning": "why this element"
}

If no suitable element found: { "found": false, "reasoning": "why not" }`;

  const userMessage = `I need to ${action} ${value ? `"${value}" into` : ''} the element described as: "${hint}"

Accessibility tree:
${a11yTree}`;

  let raw: string;
  try {
    raw = await askGroq(systemPrompt, userMessage, 300);
  } catch (e) {
    console.warn('[Tier 2] Groq call failed:', (e as Error).message);
    return null;
  }

  let parsed: { found: boolean; elementName?: string; elementRole?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed.found || !parsed.elementName) {
    console.log('[Tier 2] Groq says element not found in a11y tree');
    return null;
  }

  console.log(`[Tier 2] Groq identified: role="${parsed.elementRole}" name="${parsed.elementName}"`);

  const elementExists = await validateElementExists(page, parsed.elementName);
  if (!elementExists) {
    console.log(`[Tier 2] ⚠ Element "${parsed.elementName}" not found in DOM — Groq may have hallucinated. Skipping.`);
    return null;
  }

  const strategies = [
    () => page.getByRole(parsed.elementRole as 'button', { name: parsed.elementName!, exact: false }).first(),
    () => page.getByText(parsed.elementName!, { exact: false }).first(),
    () => page.getByLabel(parsed.elementName!, { exact: false }).first(),
    () => page.getByPlaceholder(parsed.elementName!, { exact: false }).first(),
    () => page.locator(`[aria-label*="${parsed.elementName}" i]`).first(),
  ];

  for (const stratFn of strategies) {
    try {
      const loc = stratFn();
      await loc.waitFor({ state: 'visible', timeout: 2000 });

      if (action === 'fill' && value !== undefined) {
        // ── HUMAN TYPING: replaced loc.fill() with humanType() ──
         await humanType(loc, value, page);
      } else {
        await loc.click({ timeout: 2000 });
      }

      console.log(`[Tier 2] ✓ Success via a11y+Groq: "${parsed.elementName}"`);
      return { success: true, strategy: `a11y-groq:${parsed.elementName}`, tier: 2 };
    } catch { /* try next */ }
  }

  return null;
}

// ─── Tier 3: HTML Context + Groq Re-Plan ─────────────────────────────────────

async function tier3HtmlGroqReplan(
  page: import('playwright').Page,
  hint: string,
  action: ElementAction,
  value?: string,
): Promise<ActionResult | null> {
  console.log('[Tier 3] HTML context + Groq re-plan starting...');

  const { url, title, html } = await getPageContext(page);
  const elements = await scanInteractiveElements(page);

  const elementSummary = elements
    .slice(0, 50)
    .map((el, i) => {
      const parts = [`${i}: <${el.tag}>`];
      if (el.id)          parts.push(`id="${el.id}"`);
      if (el.text)        parts.push(`text="${el.text.slice(0, 40)}"`);
      if (el.ariaLabel)   parts.push(`aria-label="${el.ariaLabel}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.name)        parts.push(`name="${el.name}"`);
      return parts.join(' ');
    })
    .join('\n');

  const systemPrompt = `You are a browser automation expert. You are given information about a live web page and need to identify how to perform an action.

Output ONLY raw JSON. No markdown, no explanation.

Schema:
{
  "approach": "selector | text | role | keyboard | url | skip",
  "selector": "CSS selector if approach=selector",
  "text": "visible text to click if approach=text",
  "role": "ARIA role if approach=role",
  "name": "element name/label if approach=role",
  "key": "keyboard key if approach=keyboard (e.g. Enter)",
  "url": "new URL to navigate to if approach=url",
  "reasoning": "brief explanation"
}

If the action is impossible on this page, use approach=skip.`;

  const userMessage = `Page URL: ${url}
Page title: ${title}

I need to: ${action} ${value ? `"${value}" into` : ''} the element: "${hint}"

Interactive elements on page:
${elementSummary}

Relevant HTML snippet:
${html.slice(0, 2000)}`;

  let raw: string;
  try {
    raw = await askGroq(systemPrompt, userMessage, 400);
  } catch (e) {
    console.warn('[Tier 3] Groq call failed:', (e as Error).message);
    return null;
  }

  let parsed: {
    approach: string;
    selector?: string;
    text?: string;
    role?: string;
    name?: string;
    key?: string;
    url?: string;
    reasoning?: string;
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  console.log(`[Tier 3] Groq approach="${parsed.approach}" reasoning="${parsed.reasoning}"`);

  if (parsed.approach === 'selector' && parsed.selector) {
    const selectorExists = await page.locator(parsed.selector).count().then(c => c > 0).catch(() => false);
    if (!selectorExists) {
      console.log(`[Tier 3] ⚠ Selector "${parsed.selector}" not found in DOM — Groq hallucination. Skipping.`);
      return null;
    }
  }

  try {
    switch (parsed.approach) {
      case 'selector': {
        if (!parsed.selector) return null;
        const loc = page.locator(parsed.selector).first();
        await loc.waitFor({ state: 'visible', timeout: 3000 });
        if (action === 'fill' && value) {
          // ── HUMAN TYPING: replaced loc.fill() with humanType() ──
           await humanType(loc, value, page);
        } else {
          await loc.click({ timeout: 2000 });
        }
        console.log(`[Tier 3] ✓ selector: "${parsed.selector}"`);
        return { success: true, strategy: `replan-selector:${parsed.selector}`, tier: 3 };
      }

      case 'text': {
        if (!parsed.text) return null;
        const loc = page.getByText(parsed.text, { exact: false }).first();
        await loc.waitFor({ state: 'visible', timeout: 3000 });
        if (action === 'fill' && value) {
          // ── HUMAN TYPING: replaced loc.fill() with humanType() ──
           await humanType(loc, value, page);
        } else {
          await loc.click({ timeout: 2000 });
        }
        console.log(`[Tier 3] ✓ text: "${parsed.text}"`);
        return { success: true, strategy: `replan-text:${parsed.text}`, tier: 3 };
      }

      case 'role': {
        if (!parsed.name) return null;
        const loc = page.getByRole((parsed.role ?? 'button') as 'button', { name: parsed.name, exact: false }).first();
        await loc.waitFor({ state: 'visible', timeout: 3000 });
        if (action === 'fill' && value) {
          // ── HUMAN TYPING: replaced loc.fill() with humanType() ──
           await humanType(loc, value, page);
        } else {
          await loc.click({ timeout: 2000 });
        }
        console.log(`[Tier 3] ✓ role="${parsed.role}" name="${parsed.name}"`);
        return { success: true, strategy: `replan-role:${parsed.role}[${parsed.name}]`, tier: 3 };
      }

      case 'keyboard': {
        const key = parsed.key ?? 'Enter';
        await page.keyboard.press(key);
        console.log(`[Tier 3] ✓ keyboard: "${key}"`);
        return { success: true, strategy: `replan-keyboard:${key}`, tier: 3 };
      }

      case 'url': {
        if (!parsed.url) return null;
        await page.goto(parsed.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await sleep(1500);
        console.log(`[Tier 3] ✓ navigate to: "${parsed.url}"`);
        return { success: true, strategy: `replan-url:${parsed.url}`, tier: 3 };
      }

      case 'skip': {
        console.log(`[Tier 3] Groq says skip — ${parsed.reasoning}`);
        return { success: true, strategy: `skip:${parsed.reasoning}`, tier: 3, warning: `Step skipped: ${parsed.reasoning}` };
      }
    }
  } catch (e) {
    console.warn('[Tier 3] Execution of Groq plan failed:', (e as Error).message);
  }

  return null;
}

// ─── Tier 4: URL Param Fallback ───────────────────────────────────────────────

async function tier4UrlFallback(
  page: import('playwright').Page,
  hint: string,
): Promise<ActionResult | null> {
  console.log('[Tier 4] URL param fallback starting...');

  const result = await tryUrlParamFallback(page, hint, hint);

  if (!result.possible || !result.newUrl) {
    console.log('[Tier 4] No URL rewrite applicable');
    return null;
  }

  try {
    await page.goto(result.newUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(1500);
    console.log(`[Tier 4] ✓ URL rewrite: "${result.newUrl}" — ${result.reason}`);
    return { success: true, strategy: `url-rewrite:${result.newUrl}`, tier: 4, warning: result.reason };
  } catch (e) {
    console.warn('[Tier 4] URL navigation failed:', (e as Error).message);
    return null;
  }
}

// ─── Vision Fallback (Gemini Flash) ───────────────────────────────────
//
// WEEK 3: Last resort when all DOM-based tiers fail.
// Takes a screenshot of the current page, sends it to Google Gemini 1.5 Flash
// (FREE — 1500 req/day at aistudio.google.com) which sees the rendered pixels
// and returns the CSS selector for the target element.
//
// Recovers failures that are impossible for DOM-based tiers:
//   - Elements with no aria-label, placeholder, or accessible name
//   - Canvas-rendered UIs with zero DOM structure
//   - Shadow DOM elements Playwright can't pierce
//   - Heavily obfuscated/randomised class names
//
// Requires GEMINI_API_KEY in .env (free, no credit card needed).
// Gracefully skips if key is missing — falls through to the final throw.

async function tier5VisionGemini(
  page: import('playwright').Page,
  hint: string,
  action: ElementAction,
  value?: string,
): Promise<ActionResult | null> {
  console.log('[Tier 5] Vision fallback (Gemini Flash) starting...');

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey || geminiKey === 'your_gemini_api_key_here') {
    console.log('[Tier 5] GEMINI_API_KEY not set — skipping vision fallback.');
    return null;
  }

  let screenshotBase64: string;
  try {
    const buffer = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false });
    screenshotBase64 = buffer.toString('base64');
    console.log(`[Tier 5] Screenshot captured: ${Math.round(screenshotBase64.length / 1024)}KB`);
  } catch (e) {
    console.warn('[Tier 5] Screenshot failed:', (e as Error).message);
    return null;
  }

  const actionDescription = action === 'fill'
    ? `fill "${value}" into`
    : 'click';

  const prompt = [
    `I need to ${actionDescription} the element described as: "${hint}"`,
    `Look at this screenshot of a web page.`,
    `Find the element and return the best CSS selector to target it.`,
    `Rules:`,
    `- Prefer selectors using id, name, aria-label, placeholder, or data-testid attributes`,
    `- If those are not available, use a short class-based selector`,
    `- If the element is a button or link, you can use text content`,
    `- Return ONLY a JSON object, no explanation, no markdown`,
    `Schema:`,
    `{ "found": true, "selector": "CSS selector string", "fallbackText": "visible text on the element if selector might be fragile", "confidence": 0-100, "reasoning": "one sentence" }`,
    `If the element is not visible in the screenshot:`,
    `{ "found": false, "reasoning": "why not visible" }`,
  ].join('\n');

  let geminiResponse: { found: boolean; selector?: string; fallbackText?: string; confidence?: number; reasoning?: string };

  try {
    const geminiModel = process.env.GEMINI_VISION_MODEL ?? 'gemini-1.5-flash';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`;

    const body = {
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/jpeg', data: screenshotBase64 } },
          { text: prompt },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[Tier 5] Gemini API error ${response.status}: ${errorText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!rawText) { console.warn('[Tier 5] Gemini returned empty response'); return null; }

    const cleaned = rawText.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    geminiResponse = JSON.parse(cleaned);
    console.log(`[Tier 5] Gemini response: found=${geminiResponse.found} confidence=${geminiResponse.confidence}%`);

  } catch (e) {
    console.warn('[Tier 5] Gemini call failed:', (e as Error).message);
    return null;
  }

  if (!geminiResponse.found || !geminiResponse.selector) {
    console.log('[Tier 5] Gemini says element not visible in screenshot');
    return null;
  }

  const selectorExists = await page.locator(geminiResponse.selector).count()
    .then(c => c > 0).catch(() => false);

  if (!selectorExists) {
    console.log(`[Tier 5] ⚠ Gemini selector "${geminiResponse.selector}" not found in DOM.`);

    if (geminiResponse.fallbackText) {
      try {
        const loc = page.getByText(geminiResponse.fallbackText, { exact: false }).first();
        await loc.waitFor({ state: 'visible', timeout: 2000 });
        if (action === 'fill' && value) {
          // ── HUMAN TYPING ──
           await humanType(loc, value, page);
        } else {
          await loc.click({ timeout: 2000 });
        }
        return { success: true, strategy: `vision-text:${geminiResponse.fallbackText}`, tier: 5 };
      } catch {
        console.log('[Tier 5] Fallback text also failed');
      }
    }
    return null;
  }

  try {
    const loc = page.locator(geminiResponse.selector).first();
    await loc.waitFor({ state: 'visible', timeout: 3000 });

    if (action === 'fill' && value !== undefined) {
      // ── HUMAN TYPING: replaced loc.fill() with humanType() ──
       await humanType(loc, value, page);
    } else {
      await loc.click({ timeout: 2000 });
    }

    console.log(`[Tier 5] ✓ Vision success: "${geminiResponse.selector}"`);
    return { success: true, strategy: `vision:${geminiResponse.selector}`, tier: 5 };
  } catch (e) {
    console.warn('[Tier 5] Gemini selector interaction failed:', (e as Error).message);

    try {
      const jsClicked = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) { el.click(); return true; }
        return false;
      }, geminiResponse.selector);

      if (jsClicked) {
        return { success: true, strategy: `vision-js:${geminiResponse.selector}`, tier: 5 };
      }
    } catch { /* give up */ }
  }

  return null;
}

// ─── Tier 0: Direct Selector ──────────────────────────────────────────────────

async function tier0Direct(
  page: import('playwright').Page,
  hint: string,
  action: ElementAction,
  value?: string,
): Promise<ActionResult | null> {

  const candidates: Array<{ label: string; loc: import('playwright').Locator }> = [];

  if (page.url().includes('spotify.com')) {
    const spotifySelectors = [
      'input[data-testid="search-input"]',
      'input[placeholder*="Search" i]',
      'input[type="text"]',
      '[role="searchbox"]',
      'input',
    ];
    if (hint.toLowerCase().includes('search') || action === 'fill') {
      for (const sel of spotifySelectors) {
        candidates.push({ label: `spotify:${sel}`, loc: page.locator(sel).first() });
      }
    }
  }

  if (page.url().includes('youtube.com')) {
    if (hint.includes('ytd-channel-renderer') || hint.includes('channel-name')) {
      candidates.push({ label: 'yt-channel', loc: page.locator('ytd-channel-renderer').first() });
      candidates.push({ label: 'yt-channel-link', loc: page.locator('ytd-channel-renderer a').first() });
    }
    if (hint.includes('ytd-video-renderer') || hint.includes('video-title')) {
      candidates.push({ label: 'yt-video', loc: page.locator('ytd-video-renderer a#video-title').first() });
      candidates.push({ label: 'yt-video-2', loc: page.locator('ytd-rich-item-renderer a#video-title-link').first() });
    }
  }

  if (page.url().includes('amazon.')) {
    if (hint.includes('s-search-result') || hint.includes('h2')) {
      candidates.push({
        label: 'amazon-result',
        loc: page.locator("div[data-component-type='s-search-result'] h2 a").first(),
      });
      candidates.push({
        label: 'amazon-result-2',
        loc: page.locator("a.a-link-normal.s-no-outline").first(),
      });
    }
  }

if (!hint.includes('h3:nth-child')) {
  try {
    await page.waitForSelector(hint, { state: 'visible', timeout: 4000 });
    candidates.unshift({ label: `css:${hint}`, loc: page.locator(hint).first() });
  } catch { /* not a valid selector or not present */ }
}

  if (!hint.includes('h3')) {
    candidates.push(
      { label: `role-btn:${hint}`,    loc: page.getByRole('button', { name: hint, exact: false }).first() },
      { label: `role-link:${hint}`,   loc: page.getByRole('link',   { name: hint, exact: false }).first() },
      { label: `aria:${hint}`,        loc: page.locator(`[aria-label*="${hint}" i]`).first() },
      { label: `placeholder:${hint}`, loc: page.getByPlaceholder(hint, { exact: false }).first() },
      { label: `text:${hint}`,        loc: page.getByText(hint, { exact: false }).first() },
    );
  }

  for (const { label, loc } of candidates) {
    try {
      await loc.waitFor({ state: 'visible', timeout: 2000 });
      if (action === 'fill' && value !== undefined) {
        // ── HUMAN TYPING: replaced loc.fill() with humanType() ──
         await humanType(loc, value, page);
      } else {
        await loc.click({ timeout: 1500 });
      }
      console.log(`[Tier 0] ✓ Direct match: "${label}"`);
      return { success: true, strategy: label, tier: 0 };
    } catch { /* try next */ }
  }

  return null;
}

// ─── Main Export: Smart Find & Act ───────────────────────────────────────────
//
// WEEK 3: Tier 5 Vision (Gemini) added as final fallback.
// Full flow:
//   Memory (Tier -1) → Tier 0 → DOM settle → Tier 1 → networkidle →
//   Tier 2 → Tier 3 → Tier 4 → Tier 5 (Vision/Gemini) → throw
//
// After any successful result, recordSuccess() is called so the winning
// selector is remembered for next time.

export async function smartFindAndAct(
  page: import('playwright').Page,
  hint: string,
  action: ElementAction,
  value?: string,
): Promise<ActionResult> {
  console.log(`\n[SmartBrowser] ${action.toUpperCase()} — hint: "${hint.slice(0, 60)}" ${value ? `value: "${value}"` : ''}`);

  try {
    await page.evaluate(() => true);
  } catch {
    throw new Error('Page context is closed — cannot perform action');
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(600);

  const pageUrl = page.url();

  // ── MEMORY TIER (Tier -1) ─────────────────────────────────────────────────

  const rememberedSelector = await getBestSelector(pageUrl, hint);
  if (rememberedSelector) {
    console.log(`[Memory] Trying remembered selector: "${rememberedSelector.slice(0, 60)}"`);
    try {
      const loc = page.locator(rememberedSelector).first();
      await loc.waitFor({ state: 'visible', timeout: 2000 });

      if (action === 'fill' && value !== undefined) {
        // ── HUMAN TYPING: replaced loc.fill() with humanType() ──
         await humanType(loc, value, page);
      } else {
        await loc.click({ timeout: 1500 });
      }

      console.log(`[Memory] ✓ Used remembered selector — bypassed all tiers`);
      const result: ActionResult = { success: true, strategy: `memory:${rememberedSelector}`, tier: -1 };
      await recordSuccess(pageUrl, hint, rememberedSelector, -1);
      return result;
    } catch {
      console.log('[Memory] Remembered selector stale — recording failure and proceeding to Tier 0');
      await recordFailure(pageUrl, hint, rememberedSelector);
    }
  }

  // ── Site-specific handlers ────────────────────────────────────────────────

  if (action === 'click') {
    const googleResult = await handleGoogleSearchClick(page, hint);
    if (googleResult) { await recordSuccess(pageUrl, hint, googleResult.strategy, googleResult.tier); return googleResult; }
  }

  if (action === 'click' && page.url().includes('bing.com')) {
    const bingResult = await handleBingClick(page, hint);
    if (bingResult) { await recordSuccess(pageUrl, hint, bingResult.strategy, bingResult.tier); return bingResult; }
  }

  if (action === 'click' && page.url().includes('linkedin.com')) {
    const linkedinResult = await handleLinkedInClick(page, hint);
    if (linkedinResult) { await recordSuccess(pageUrl, hint, linkedinResult.strategy, linkedinResult.tier); return linkedinResult; }
  }

  // ── Tier 0 ────────────────────────────────────────────────────────────────
  const t0 = await tier0Direct(page, hint, action, value);
  if (t0) { await recordSuccess(pageUrl, hint, t0.strategy, t0.tier); return t0; }

  console.log('[SmartBrowser] Tier 0 failed — waiting 1.5s for DOM to settle...');
  await sleep(1500);
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // ── Tier 1: DOM fuzzy scan ────────────────────────────────────────────────
  const t1 = await tier1FuzzyDomScan(page, hint, action, value);
  if (t1) { await recordSuccess(pageUrl, hint, t1.strategy, t1.tier); return t1; }

  // ── FIX 2A: Progressive wait before Tier 2 ───────────────────────────────
  console.log('[SmartBrowser] Tier 1 failed — waiting for network to settle...');
  await sleep(2000);
  try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}

  // ── Tier 2: Accessibility tree + Groq ────────────────────────────────────
  const t2 = await tier2AccessibilityGroq(page, hint, action, value);
  if (t2) { await recordSuccess(pageUrl, hint, t2.strategy, t2.tier); return t2; }

  // ── FIX 2A: Minimal wait before Tier 3 ───────────────────────────────────
  console.log('[SmartBrowser] Tier 2 failed — full HTML replan...');
  await sleep(500);

  // ── Tier 3: HTML context + Groq re-plan ──────────────────────────────────
  const t3 = await tier3HtmlGroqReplan(page, hint, action, value);
  if (t3) { await recordSuccess(pageUrl, hint, t3.strategy, t3.tier); return t3; }

  // ── Tier 4: URL param fallback ────────────────────────────────────────────
  if (action === 'click') {
    console.log('[SmartBrowser] Tier 3 failed — escalating to Tier 4');
    const t4 = await tier4UrlFallback(page, hint);
    if (t4) { await recordSuccess(pageUrl, hint, t4.strategy, t4.tier); return t4; }
  }

  // ── Tier 5: Vision fallback (Gemini Flash) — WEEK 3 ──────────────────────
  console.log('[SmartBrowser] Tier 4 failed — escalating to Tier 5 (Vision/Gemini)');
  const t5 = await tier5VisionGemini(page, hint, action, value);
  if (t5) { await recordSuccess(pageUrl, hint, t5.strategy, t5.tier); return t5; }

  const currentUrl = page.url();
  throw new Error(
    `All tiers failed for "${hint}" (${action}) on ${currentUrl}.\n` +
    `Tried: memory → direct selector → DOM settle + fuzzy scan → networkidle + accessibility+Groq → HTML+Groq replan → URL fallback → Vision/Gemini.`
  );
}