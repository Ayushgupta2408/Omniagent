/**
 * authSetup.ts — NEXUS One-Time Login Setup
 * ─────────────────────────────────────────────────────────────────────────────
 * Run once: npm run auth
 * Opens a real Chrome window → you log into any sites you want
 * → saves all cookies/sessions to auth-state.json
 * → every future Nexus run loads that file and is already logged in
 *
 * Usage:
 *   npm run auth
 */

import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';

const AUTH_FILE = path.join(process.cwd(), 'auth-state.json');

async function main() {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║        NEXUS — One-Time Auth Setup             ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  console.log('A browser window will open.');
  console.log('Log into any sites you want Nexus to use:');
  console.log('  → WhatsApp Web  (web.whatsapp.com)');
  console.log('  → Discord       (discord.com/app)');
  console.log('  → Gmail         (mail.google.com)');
  console.log('  → Reddit, X, LinkedIn, etc.');
  console.log('\nTake your time. Log into everything you need.');
  console.log('When done, come back here and press ENTER.\n');

  // Launch real Chrome (channel: chrome) so sites trust it
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const context = await browser.newContext({
    viewport: null, // full window size
  });

  const page = await context.newPage();

  // Open a friendly start page
  await page.goto('https://web.whatsapp.com');

  console.log('✓ Browser opened. Log into your sites now...\n');

  // Wait for user to press Enter
  await waitForEnter('When you are done logging in, press ENTER here to save your session...');

  // Save ALL cookies + localStorage for every site visited
  await context.storageState({ path: AUTH_FILE });

  console.log(`\n✓ Auth state saved to: ${AUTH_FILE}`);

  // Show which sites were saved
  const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  const domains = [...new Set(
    (state.cookies as Array<{ domain: string }>)
      .map(c => c.domain.replace(/^\./, ''))
      .filter((d: string) => !d.includes('google.com') || d === 'mail.google.com')
  )];
  console.log(`✓ Saved sessions for ${state.cookies.length} cookies across domains:`);
  domains.slice(0, 15).forEach((d: string) => console.log(`    • ${d}`));
  if (domains.length > 15) console.log(`    ... and ${domains.length - 15} more`);

  await browser.close();

  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║  Setup complete! Nexus will now use your       ║');
  console.log('║  saved logins for all future tasks.            ║');
  console.log('╚════════════════════════════════════════════════╝\n');
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt + ' ', () => {
      rl.close();
      resolve();
    });
  });
}

main().catch(err => {
  console.error('Auth setup failed:', err.message);
  process.exit(1);
});