/**
 * blockedUrlTracker.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks URLs that have been permanently blocked by bot detection (Cloudflare,
 * etc.) during the current server session.
 *
 * When a BotDetectionError is thrown, the URL is registered here.
 * server.ts reads this list and passes it to replanFromStep() so the
 * replanner never retries the same blocked domain.
 *
 * The set is per-process (resets on server restart), which is fine because
 * bot-blocked sites rarely unblock within a single session.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Session-level set of blocked URLs ─────────────────────────────────────────
const blockedUrls = new Set<string>();

/**
 * Register a URL as permanently bot-blocked for this session.
 * Called by server.ts when it catches a BotDetectionError.
 */
export function markUrlBlocked(url: string): void {
  if (!url) return;
  blockedUrls.add(url);
  console.log(`[BlockedURLs] Marked as bot-blocked: ${url}`);
  console.log(`[BlockedURLs] Total blocked this session: ${blockedUrls.size}`);
}

/**
 * Returns all bot-blocked URLs collected so far this session.
 * Passed to replanFromStep() so the replanner avoids them.
 */
export function getBlockedUrls(): string[] {
  return Array.from(blockedUrls);
}

/**
 * Check if a URL (or its domain) is already known to be bot-blocked.
 * Used to skip retries immediately without waiting 20s.
 */
export function isUrlBlocked(url: string): boolean {
  if (!url) return false;

  // Exact match
  if (blockedUrls.has(url)) return true;

  // Domain match — if aichief.com is blocked, aichief.com/news/2025 is also blocked
  try {
    const incomingDomain = new URL(url).hostname;
    for (const blocked of blockedUrls) {
      try {
        const blockedDomain = new URL(blocked).hostname;
        if (incomingDomain === blockedDomain) return true;
      } catch { /* ignore malformed stored URL */ }
    }
  } catch { /* ignore malformed incoming URL */ }

  return false;
}

/**
 * Clear all blocked URLs (useful for testing or fresh sessions).
 */
export function clearBlockedUrls(): void {
  blockedUrls.clear();
}