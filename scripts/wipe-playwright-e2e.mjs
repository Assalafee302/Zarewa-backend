/**
 * Removes the Playwright E2E SQLite file so the next `npm run test:e2e` starts clean.
 * Safe: only deletes `data/playwright.sqlite` (not zarewa.sqlite).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = path.join(root, 'data', 'playwright.sqlite');
const shm = `${db}-shm`;
const wal = `${db}-wal`;

for (const f of [wal, shm, db]) {
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (e) {
    console.error(`[wipe-playwright-e2e] Could not remove ${f}:`, e.message);
    process.exit(1);
  }
}
console.log('[wipe-playwright-e2e] Removed data/playwright.sqlite (and -wal/-shm if present).');
