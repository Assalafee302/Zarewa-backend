import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, '..', 'debug-d59a2b.log');
const SESSION_ID = 'd59a2b';
const ENDPOINT = 'http://127.0.0.1:7800/ingest/0d232d42-7e4c-4aa0-b25b-38b428c3d629';

export function debugAgentLog(payload) {
  const entry = {
    sessionId: SESSION_ID,
    timestamp: Date.now(),
    ...payload,
  };
  try {
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* ignore */
  }
  fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': SESSION_ID,
    },
    body: JSON.stringify(entry),
  }).catch(() => {});
}
