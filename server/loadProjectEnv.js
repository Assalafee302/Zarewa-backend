import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads repo-root `.env` into `process.env` (Node 20+ `process.loadEnvFile`).
 * Does not override variables already set in the environment.
 */
export function loadProjectEnv() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  try {
    if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  } catch (e) {
    console.warn('[zarewa] Could not load .env:', e?.message || e);
  }
}
