// StopFailure event channel: the authoritative, scrape-free overload trigger.
//
// Claude Code's `StopFailure` hook fires only when a turn ends in an API error, with a
// typed `error` (matcher-filtered to overloaded/server_error). The hook runs as a CHILD
// of claude, so it inherits the env the launcher stamped onto claude — including
// CLAUDE_AUTO_RETRY_SESSION. It writes a marker keyed by that session id; the launcher,
// which already knows its own session id, reads it directly. No session-id plumbing from
// Claude Code's payload is needed.
//
// Markers are short-lived (consumed on action, ignored past eventMaxAge) so a stale
// failure can't be replayed on a later run.

import { mkdir, writeFile, readFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeKey } from './pane-key.js';

export const EVENTS_DIR = join(homedir(), '.claude-auto-retry', 'events');

// Error types the event path treats as a *transient overload* (seconds-scale backoff).
// NOTE: `rate_limit` is deliberately EXCLUDED. For a subscription it is the session/usage
// limit — an HOURS-scale wait until a printed reset time, not a seconds-scale retry.
// Routing it here made the monitor fire futile "Continue" retries into a session-limited
// session and fight the (correct) scraper usage-wait path. Session/usage limits are owned
// by the scraper usage path (it reliably reads the persistent "…resets <time>" banner and
// waits); a genuinely transient API 429 is caught by the overload scraper's "temporarily
// limiting requests" pattern — but only while the scraper is active (it is disabled once
// eventMode latches), so API-key sessions in event mode currently get no retry for that
// case. A known, accepted gap: rare, and strictly better than misrouting session limits.
// Permanent errors (auth/billing/invalid) never retry.
const RETRYABLE = new Set(['overloaded', 'server_error']);

export function isRetryableError(errorType) {
  return typeof errorType === 'string' && RETRYABLE.has(errorType.toLowerCase());
}

// Keep the marker filename to a safe charset (session keys are free-form strings).
function fileFor(sessionKey, dir) {
  return join(dir, `${sanitizeKey(sessionKey)}.json`);
}

// Hook side: write a marker for the session. Atomic (tmp + rename) so the launcher never
// reads a half-written file.
export async function writeStopFailureEvent(sessionKey, payload, dir = EVENTS_DIR) {
  if (!sessionKey) return null;
  const error = typeof payload?.error === 'string' ? payload.error : 'unknown';
  await mkdir(dir, { recursive: true });
  const file = fileFor(sessionKey, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ session: String(sessionKey), error, session_id: payload?.session_id ?? null, ts: Date.now() });
  await writeFile(tmp, body);
  await rename(tmp, file);
  return file;
}

// Launcher side: return a fresh marker for the session, or null (absent / unparseable / stale).
export async function readStopFailureEvent(sessionKey, maxAgeMs, dir = EVENTS_DIR) {
  if (!sessionKey) return null;
  try {
    const ev = JSON.parse(await readFile(fileFor(sessionKey, dir), 'utf-8'));
    if (typeof ev.ts !== 'number' || Date.now() - ev.ts > maxAgeMs) return null;
    return ev;
  } catch { return null; }
}

export async function clearStopFailureEvent(sessionKey, dir = EVENTS_DIR) {
  try { await unlink(fileFor(sessionKey, dir)); } catch { /* already gone */ }
}
