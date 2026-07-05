/**
 * whatsappClient.ts — NEXUS WhatsApp Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses whatsapp-web.js which reverse-engineered the WhatsApp Web protocol.
 * No browser automation, no bot detection issues.
 *
 * First run: shows QR code in terminal → scan with phone → session saved
 * Every run after: loads saved session, no QR needed
 *
 * Install: npm install whatsapp-web.js qrcode-terminal
 */

import * as path from 'path';
import * as fs from 'fs';

const SESSION_PATH = path.join(process.cwd(), 'whatsapp-session');

let clientInstance: any = null;
let clientReady = false;
let initPromise: Promise<void> | null = null;
 
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Initialize WhatsApp Client ───────────────────────────────────────────────

export async function getWhatsAppClient(): Promise<any> {
  // Already ready — return immediately
  if (clientInstance && clientReady) return clientInstance;

  // Already initializing — wait for it
  if (initPromise) {
    await initPromise;
    return clientInstance;
  }

  initPromise = _initialize();
  await initPromise;
  return clientInstance;
}

async function _initialize(): Promise<void> {
  const { Client, LocalAuth } = await import('whatsapp-web.js');
  const qrcode = await import('qrcode-terminal');

  console.log('[WhatsApp] Initializing client...');

  clientInstance = new Client({
    authStrategy: new LocalAuth({
      dataPath: SESSION_PATH,
    }),
    puppeteer: {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--start-maximized', 
      ],
    },
  });

  // Show QR in terminal on first run
  clientInstance.on('qr', (qr: string) => {
    console.log('\n[WhatsApp] ══════════════════════════════════════════');
    console.log('[WhatsApp] Scan this QR code with your phone:');
    console.log('[WhatsApp] WhatsApp → Settings → Linked Devices → Link a Device');
    console.log('[WhatsApp] ══════════════════════════════════════════\n');
    qrcode.generate(qr, { small: true });
    console.log('\n[WhatsApp] Waiting for scan...');
  });

  clientInstance.on('authenticated', () => {
    console.log('[WhatsApp] ✓ Authenticated — session saved');
  });

  clientInstance.on('auth_failure', (msg: string) => {
    console.error('[WhatsApp] ✗ Auth failed:', msg);
    console.error('[WhatsApp] Delete whatsapp-session/ folder and try again');
    clientReady = false;
  });

  clientInstance.on('disconnected', (reason: string) => {
    console.warn('[WhatsApp] Disconnected:', reason);
    clientReady = false;
    clientInstance = null;
    initPromise = null;
  });

  // Wait for ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('[WhatsApp] Timeout waiting for client ready (60s). Check QR scan.'));
    }, 60_000);

    clientInstance.on('ready', () => {
      clearTimeout(timeout);
      clientReady = true;
      console.log('[WhatsApp] ✓ Client ready — connected to WhatsApp');
      resolve();
    });

    clientInstance.initialize().catch((err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ─── Find a contact by name ───────────────────────────────────────────────────

export async function findContact(client: any, name: string): Promise<any | null> {
  const contacts = await client.getContacts();
  const nameLower = name.toLowerCase().trim();

  // Exact match first
  let match = contacts.find((c: any) =>
    c.name?.toLowerCase() === nameLower ||
    c.pushname?.toLowerCase() === nameLower
  );

  // Partial match fallback
  if (!match) {
    match = contacts.find((c: any) =>
      c.name?.toLowerCase().includes(nameLower) ||
      c.pushname?.toLowerCase().includes(nameLower)
    );
  }

  return match ?? null;
}

// ─── Send a WhatsApp message ──────────────────────────────────────────────────

export async function sendWhatsAppMessage(
  contactName: string,
  message: string,
): Promise<{ success: boolean; message: string; to?: string }> {
  let client: any;

  try {
    client = await getWhatsAppClient();
  } catch (e) {
    throw new Error(
      `WhatsApp client failed to start: ${(e as Error).message}\n` +
      `Make sure you ran: npm install whatsapp-web.js qrcode-terminal`
    );
  }

  // Find contact
  const contact = await findContact(client, contactName);
  if (!contact) {
    // Try searching chats too
    const chats = await client.getChats();
    const chatMatch = chats.find((c: any) =>
      c.name?.toLowerCase().includes(contactName.toLowerCase())
    );

    if (!chatMatch) {
      throw new Error(
        `Contact "${contactName}" not found in WhatsApp.\n` +
        `Make sure the name matches exactly as it appears in your contacts.`
      );
    }

    await chatMatch.sendMessage(message);
    console.log(`[WhatsApp] ✓ Message sent to "${chatMatch.name}" via chat`);
    return {
      success: true,
      message: `Message sent to ${chatMatch.name}`,
      to: chatMatch.name,
    };
  }

  // Send message
  const chatId = contact.id._serialized;
  await client.sendMessage(chatId, message);

  console.log(`[WhatsApp] ✓ Message "${message}" sent to "${contact.name ?? contact.pushname}"`);
  return {
    success: true,
    message: `Message sent to ${contact.name ?? contact.pushname}`,
    to: contact.name ?? contact.pushname,
  };
}

// ─── Get recent chats ─────────────────────────────────────────────────────────

export async function makeWhatsAppCall(
  contactName: string,
  callType: 'voice' | 'video' = 'voice',
): Promise<{ success: boolean; message: string; to?: string }> {
  console.log(`[WhatsApp] Initiating ${callType} call to "${contactName}"...`);

  const client = await getWhatsAppClient();
  if (!client) throw new Error('WhatsApp client failed to initialize');

  const contact = await findContact(client, contactName);
  let displayName: string;

  if (contact) {
    displayName = contact.name ?? contact.pushname ?? contactName;
  } else {
    const chats = await client.getChats();
    const chatMatch = chats.find((c: any) =>
      c.name?.toLowerCase().includes(contactName.toLowerCase())
    );
    if (!chatMatch) throw new Error(`Contact "${contactName}" not found in WhatsApp.`);
    displayName = chatMatch.name;
  }

  console.log(`[WhatsApp Call] Found: ${displayName}`);

  const page = client.pupPage;
  if (!page) throw new Error('WhatsApp pupPage not available');

  // ── Click the WhatsApp search icon (top of sidebar) ──────────────────────
  // These are the actual WhatsApp Web search triggers — NOT Ctrl+F
  const SEARCH_ICON_SELECTORS = [
    "[data-testid='search']",
    "[data-testid='chat-list-search']",
    "span[data-icon='search']",
    "[aria-label='Search or start new chat']",
    "div[title='Search or start new chat']",
  ];

  let searchOpened = false;
  for (const sel of SEARCH_ICON_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 3000 });
      await page.click(sel);
      searchOpened = true;
      console.log(`[WhatsApp Call] Search opened via: ${sel}`);
      break;
    } catch {}
  }

  if (!searchOpened) {
    // Take screenshot so we can see what state the page is in
    await page.screenshot({ path: 'whatsapp-debug.png' });
    throw new Error('Could not open WhatsApp search. Screenshot saved as whatsapp-debug.png');
  }

  await sleep(800);

  // ── Type contact name ─────────────────────────────────────────────────────
  // Find the actual text input that appears after clicking search
  const SEARCH_INPUT_SELECTORS = [
    "[data-testid='chat-list-search']",
    "div[contenteditable][data-tab='3']",
    "[aria-label='Search input textbox']",
    "input[type='text']",
  ];

  for (const sel of SEARCH_INPUT_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 3000 });
      await page.click(sel);
      break;
    } catch {}
  }

  await sleep(300);
  await page.keyboard.type(contactName, { delay: 80 });
  console.log(`[WhatsApp Call] Typed "${contactName}"`);
  await sleep(2500);

  // ── Click first contact result ────────────────────────────────────────────
  const RESULT_SELECTORS = [
    `[data-testid='cell-frame-container']:has-text("${displayName}")`,
    `[data-testid='cell-frame-container']:has-text("${contactName}")`,
    `span[title="${displayName}"]`,
    `span[title="${contactName}"]`,
    "[data-testid='cell-frame-container']",  // fallback: first result
  ];

  let chatOpened = false;
  for (const sel of RESULT_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 4000 });
      await page.click(sel);
      chatOpened = true;
      console.log(`[WhatsApp Call] Chat opened for "${displayName}"`);
      break;
    } catch {}
  }

  if (!chatOpened) {
    await page.screenshot({ path: 'whatsapp-debug.png' });
    throw new Error(`Contact "${contactName}" not found in search results. Screenshot saved.`);
  }

  await sleep(2000);

  // ── Click call button ─────────────────────────────────────────────────────
  const voiceSelectors = [
    "[data-testid='voice-call-btn']",
    "[aria-label='Voice call']",
    "[title='Voice call']",
    "span[data-icon='voice-call']",
  ];
  const videoSelectors = [
    "[data-testid='video-call-btn']",
    "[aria-label='Video call']",
    "[title='Video call']",
    "span[data-icon='video']",
  ];

  const selectors = callType === 'video' ? videoSelectors : voiceSelectors;
  let callClicked = false;

  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      await page.click(sel);
      callClicked = true;
      console.log(`[WhatsApp Call] ✓ ${callType} call initiated to "${displayName}"`);
      break;
    } catch {}
  }

  if (!callClicked) {
    await page.screenshot({ path: 'whatsapp-call-debug.png' });
    throw new Error(`Could not find ${callType} call button. Screenshot saved as whatsapp-call-debug.png`);
  }

  await sleep(2000);
  return {
    success: true,
    message: `${callType === 'video' ? 'Video' : 'Voice'} call initiated to ${displayName} on WhatsApp`,
    to: displayName,
  };
}