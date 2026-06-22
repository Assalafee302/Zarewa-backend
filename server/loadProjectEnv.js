import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRootEnvDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function parseEnvLines(raw) {
  /** @type {Array<[string, string]>} */
  const pairs = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    pairs.push([key, value]);
  }
  return pairs;
}

function loadEnvFileQuiet(envPath) {
  if (!fs.existsSync(envPath)) return;
  process.loadEnvFile(envPath);
}

/**
 * Loads repo-root `.env` then `.env.local`.
 * Keys in `.env.local` always override `.env` (and override shell for those keys).
 */
export function loadProjectEnv() {
  const root = repoRootEnvDir();
  try {
    loadEnvFileQuiet(path.join(root, '.env'));
    const localPath = path.join(root, '.env.local');
    if (fs.existsSync(localPath)) {
      for (const [key, value] of parseEnvLines(fs.readFileSync(localPath, 'utf8'))) {
        process.env[key] = value;
      }
    }
  } catch (e) {
    console.warn('[zarewa] Could not load env files:', e?.message || e);
  }
}
