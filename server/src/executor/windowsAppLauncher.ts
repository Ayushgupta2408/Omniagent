/**
 * windowsAppLauncher.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Fully dynamic Windows app launcher — no hardcoded paths.
 *
 * Strategy chain (tried in order, first success wins):
 *
 *   1. Memory cache         — instant repeat launches
 *   2. Get-StartApps        — covers ALL Store/UWP/Win32 apps visible in Start
 *   3. Registry App Paths   — HKLM + HKCU, covers most traditional installers
 *   4. Start Menu .lnk scan — fuzzy shortcut search, catches stragglers
 *   5. URI scheme           — protocol handlers (whatsapp://, spotify://, etc.)
 *   6. where.exe / PATH     — CLI tools and apps registered in PATH
 *
 * Drop-in replacement for openApplicationWindows() in stepExecutor.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepResult {
  success: boolean;
  message?: string;
  warning?: string;
}

interface AppEntry {
  name: string;           // display name
  launchType: 'appid' | 'exe' | 'uri' | 'lnk' | 'cmd';
  launchValue: string;    // AppUserModelID, exe path, URI, lnk path, or shell cmd
  source: string;         // where we found it (for debugging)
}

// ─── In-Memory Cache ──────────────────────────────────────────────────────────
// Keyed by normalised app name. Survives for the lifetime of the server process.

const appCache = new Map<string, AppEntry>();

function normalise(name: string): string {
  return name.toLowerCase().replace(/[\s\-_]+/g, '');
}

function fuzzyScore(query: string, candidate: string): number {
  const q = normalise(query);
  const c = normalise(candidate);
  if (c === q)              return 100;   // exact
  if (c.startsWith(q))     return 80;    // prefix
  if (c.includes(q))       return 60;    // substring
  if (q.includes(c))       return 50;    // reverse substring
  // character overlap score
  let overlap = 0;
  for (const ch of q) if (c.includes(ch)) overlap++;
  return Math.floor((overlap / Math.max(q.length, 1)) * 30);
}

function bestMatch(query: string, entries: AppEntry[]): AppEntry | null {
  let best: AppEntry | null = null;
  let bestScore = 0;
  for (const e of entries) {
    const score = fuzzyScore(query, e.name);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= 40 ? best : null;   // minimum threshold
}

// ─── Strategy 1: Get-StartApps ───────────────────────────────────────────────
// Returns every app visible in the Windows Start Menu with its AppUserModelID.
// Covers Store (UWP), PWAs, and most Win32 apps that register a Start shortcut.

async function getStartApps(): Promise<AppEntry[]> {
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"`,
      { timeout: 15_000 }
    );
    const raw = JSON.parse(stdout.trim()) as Array<{ Name: string; AppID: string }>;
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr
      .filter(a => a.Name && a.AppID)
      .map(a => ({
        name: a.Name,
        launchType: 'appid',
        launchValue: a.AppID,
        source: 'Get-StartApps',
      } as AppEntry));
  } catch {
    return [];
  }
}

// ─── Strategy 2: Registry App Paths ──────────────────────────────────────────
// HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths
// HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths
// Traditional installers (Chrome, Firefox, VSCode, etc.) all register here.

async function getRegistryAppPaths(): Promise<AppEntry[]> {
  const hives = ['HKLM', 'HKCU'];
  const results: AppEntry[] = [];

  for (const hive of hives) {
    try {
      const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths`;
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "
          $key = 'Registry::${key}'
          if (Test-Path $key) {
            Get-ChildItem $key | ForEach-Object {
              $val = (Get-ItemProperty $_.PSPath).'(default)'
              if ($val) { [PSCustomObject]@{ Name = $_.PSChildName; Path = $val } }
            } | ConvertTo-Json -Compress
          } else { '[]' }
        "`,
        { timeout: 10_000 }
      );
      const trimmed = stdout.trim();
      if (!trimmed || trimmed === '[]') continue;

      const raw = JSON.parse(trimmed) as Array<{ Name: string; Path: string }>;
      const arr = Array.isArray(raw) ? raw : [raw];

      for (const item of arr) {
        if (!item.Name || !item.Path) continue;
        // Name is like "chrome.exe" — strip extension for display
        const displayName = item.Name.replace(/\.exe$/i, '');
        results.push({
          name: displayName,
          launchType: 'exe',
          launchValue: item.Path.replace(/^"|"$/g, ''), // strip surrounding quotes if any
          source: `Registry(${hive})`,
        });
      }
    } catch {
      // hive not available or PowerShell failed — skip silently
    }
  }

  return results;
}

// ─── Strategy 3: Start Menu Shortcut Scan ────────────────────────────────────
// Recursively scans Start Menu folders for .lnk files.
// Catches apps that don't register in App Paths or Get-StartApps.

async function getStartMenuShortcuts(): Promise<AppEntry[]> {
  const username = os.userInfo().username;
  const dirs = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    `C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs`,
    `C:\\Users\\${username}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs`,
  ];

  const results: AppEntry[] = [];

  async function scanDir(dir: string, depth = 0): Promise<void> {
    if (depth > 3) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
          results.push({
            name: entry.name.slice(0, -4), // strip .lnk
            launchType: 'lnk',
            launchValue: fullPath,
            source: 'StartMenu',
          });
        } else if (entry.isDirectory()) {
          await scanDir(fullPath, depth + 1);
        }
      }
    } catch {
      // directory not accessible — skip
    }
  }

  for (const dir of dirs) {
    await scanDir(dir);
  }

  return results;
}

// ─── Strategy 4: URI Scheme Handlers ─────────────────────────────────────────
// Many modern apps register URI handlers in the registry.
// We check HKCU\SOFTWARE\Classes and HKLM\SOFTWARE\Classes for known patterns.

const KNOWN_URI_SCHEMES: Record<string, string> = {
  whatsapp:          'whatsapp://',
  spotify:           'spotify://',
  discord:           'discord://',
  slack:             'slack://',
  zoom:              'zoommtg://',
  teams:             'ms-teams://',
  'microsoft teams': 'ms-teams://',
  skype:             'skype:',
  steam:             'steam://',
  xbox:              'xbox://',
  onenote:           'onenote://',
  outlook:           'outlook://',
  mail:              'ms-outlook://',
  calendar:          'outlookcal://',
  settings:          'ms-settings://',
  store:             'ms-windows-store://',
  maps:              'bingmaps://',
};

function getUriScheme(appName: string): string | null {
  for (const [key, scheme] of Object.entries(KNOWN_URI_SCHEMES)) {
    if (fuzzyScore(appName, key) >= 60) return scheme;
  }
  return null;
}

// ─── Strategy 5: PATH lookup via where.exe ────────────────────────────────────

async function findInPath(appName: string): Promise<AppEntry | null> {
  const variants = [
    appName,
    appName.replace(/\s+/g, ''),
    appName.toLowerCase(),
    appName.toLowerCase().replace(/\s+/g, ''),
    appName.replace(/\s+/g, '-'),
  ];

  for (const v of variants) {
    try {
      const { stdout } = await execAsync(`where "${v}" 2>nul`, { timeout: 5_000 });
      const exePath = stdout.trim().split('\n')[0].trim();
      if (exePath) {
        return {
          name: appName,
          launchType: 'exe',
          launchValue: exePath,
          source: 'PATH(where)',
        };
      }
    } catch { /* not found */ }
  }
  return null;
}

// ─── Launch an AppEntry ───────────────────────────────────────────────────────

async function launchEntry(entry: AppEntry, appName: string): Promise<void> {
  switch (entry.launchType) {
    case 'appid': {
      // AppUserModelID → launch via shell:AppsFolder
      await execAsync(
        `powershell -NoProfile -Command "Start-Process 'shell:AppsFolder\\${entry.launchValue}' -ErrorAction Stop"`,
        { timeout: 10_000 }
      );
      break;
    }
    case 'exe': {
      // Check the file actually exists before trying to launch
      await fs.access(entry.launchValue); // throws if missing
      await execAsync(`start "" "${entry.launchValue}"`, { timeout: 10_000 });
      break;
    }
    case 'lnk': {
      await fs.access(entry.launchValue);
      await execAsync(`start "" "${entry.launchValue}"`, { timeout: 10_000 });
      break;
    }
    case 'uri': {
      await execAsync(`start "" "${entry.launchValue}"`, { timeout: 10_000 });
      break;
    }
    case 'cmd': {
      await execAsync(entry.launchValue, { timeout: 10_000 });
      break;
    }
  }
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function openApplicationWindows(
  appName: string,
): Promise<StepResult> {
  const cacheKey = normalise(appName);

  // ── 1. Memory cache (instant repeat launches) ─────────────────────────────
  const cached = appCache.get(cacheKey);
  if (cached) {
    try {
      await launchEntry(cached, appName);
      await sleep(800);
      return { success: true, message: `Opened "${appName}" [cached via ${cached.source}]` };
    } catch {
      // Cached entry stale (app was uninstalled?) — remove and re-discover
      appCache.delete(cacheKey);
    }
  }

  // ── 2–5. Discovery phase — run all strategies in parallel ─────────────────
  console.log(`[AppLauncher] Discovering "${appName}"...`);

  const [startApps, registryApps, shortcutApps] = await Promise.all([
    getStartApps(),
    getRegistryAppPaths(),
    getStartMenuShortcuts(),
  ]);

  // Try each strategy pool in priority order
  const pools: [string, AppEntry[]][] = [
    ['Get-StartApps',  startApps],
    ['Registry',       registryApps],
    ['StartMenu',      shortcutApps],
  ];

  for (const [poolName, pool] of pools) {
    const match = bestMatch(appName, pool);
    if (!match) continue;

    console.log(`[AppLauncher] ${poolName} match: "${match.name}" (${match.launchType}: ${match.launchValue.slice(0, 60)})`);

    try {
      await launchEntry(match, appName);
      await sleep(800);
      appCache.set(cacheKey, match); // store for next time
      return {
        success: true,
        message: `Opened "${appName}" via ${match.source} → "${match.name}"`,
      };
    } catch (err) {
      console.warn(`[AppLauncher] ${poolName} launch failed:`, (err as Error).message);
      // Try next pool
    }
  }

  // ── 3. URI scheme fallback ─────────────────────────────────────────────────
  const uri = getUriScheme(appName);
  if (uri) {
    try {
      await execAsync(`start "" "${uri}"`, { timeout: 10_000 });
      await sleep(800);
      const uriEntry: AppEntry = { name: appName, launchType: 'uri', launchValue: uri, source: 'URI' };
      appCache.set(cacheKey, uriEntry);
      return { success: true, message: `Opened "${appName}" via URI scheme (${uri})` };
    } catch (err) {
      console.warn(`[AppLauncher] URI launch failed:`, (err as Error).message);
    }
  }

  // ── 4. PATH lookup ─────────────────────────────────────────────────────────
  const pathEntry = await findInPath(appName);
  if (pathEntry) {
    try {
      await launchEntry(pathEntry, appName);
      await sleep(800);
      appCache.set(cacheKey, pathEntry);
      return { success: true, message: `Opened "${appName}" via PATH` };
    } catch (err) {
      console.warn(`[AppLauncher] PATH launch failed:`, (err as Error).message);
    }
  }

  // ── 5. Last resort: PowerShell Start-Process (searches PATH + known dirs) ──
  const psVariants = [
    appName,
    appName.replace(/\s+/g, ''),
    appName.toLowerCase().replace(/\s+/g, ''),
  ];

  for (const v of psVariants) {
    try {
      await execAsync(
        `powershell -NoProfile -Command "Start-Process '${v}' -ErrorAction Stop"`,
        { timeout: 8_000 }
      );
      await sleep(800);
      return { success: true, message: `Opened "${appName}" via PowerShell Start-Process` };
    } catch { /* try next variant */ }
  }

  // ── All strategies exhausted ───────────────────────────────────────────────
  throw new Error(
    `Could not find or open "${appName}". ` +
    `Tried: Start Menu (${startApps.length} apps), Registry (${registryApps.length} apps), ` +
    `Shortcuts (${shortcutApps.length} files), URI scheme, PATH lookup, PowerShell. ` +
    `Make sure "${appName}" is installed on this device.`
  );
}

// ─── Cache Management (optional, call from your API if needed) ───────────────

export function clearAppCache(): void {
  appCache.clear();
  console.log('[AppLauncher] Cache cleared');
}

export function getCacheStats(): { size: number; entries: string[] } {
  return {
    size: appCache.size,
    entries: Array.from(appCache.entries()).map(([k, v]) => `${k} → ${v.source}:${v.name}`),
  };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}