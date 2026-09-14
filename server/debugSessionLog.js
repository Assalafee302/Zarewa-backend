/**
 * Debug-session NDJSON logger (session 513ebb).
 * Dual-writes: ingest HTTP + local files so Node traces survive if ingest is unreachable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_ID = '513ebb';
const INGEST = 'http://127.0.0.1:7632/ingest/fbf0c85d-c7b0-4df0-9ccf-75d17d1b7eef';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_PATHS = [
  path.join(root, 'debug-513ebb.log'),
  path.join(root, '.cursor', 'debug-513ebb.log'),
];

/**
 * @param {{ hypothesisId: string, location: string, message: string, data?: Record<string, unknown>, runId?: string }} p
 */
export function debugSessionLog({ hypothesisId, location, message, data = {}, runId = 'tx-load-debug' }) {
  const payload = {
    sessionId: SESSION_ID,
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  const line = `${JSON.stringify(payload)}\n`;
  for (const file of LOG_PATHS) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      /* never disturb business path */
    }
  }
  try {
    fetch(INGEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION_ID },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}
