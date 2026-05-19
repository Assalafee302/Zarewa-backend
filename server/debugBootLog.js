import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.resolve(__dirname, '..', 'debug-5f8d6a.log');
const INGEST = 'http://127.0.0.1:7654/ingest/6ebbab48-01cf-4837-9c24-58dbbadc3908';
const SESSION_ID = '5f8d6a';

/** @param {{ hypothesisId?: string, location: string, message: string, data?: Record<string, unknown>, runId?: string }} entry */
export function debugBootLog(entry) {
  const line = JSON.stringify({
    sessionId: SESSION_ID,
    timestamp: Date.now(),
    ...entry,
  });
  // #region agent log
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
  try {
    fetch(INGEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION_ID },
      body: line,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
  // #endregion
}
