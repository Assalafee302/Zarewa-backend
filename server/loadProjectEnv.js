import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRootEnvDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function loadEnvFileQuiet(envPath, { override = false, presetKeys = null } = {}) {
  if (!fs.existsSync(envPath)) return;
  if (!override) {
    process.loadEnvFile(envPath);
    return;
  }
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || presetKeys?.has(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Loads repo-root `.env` then `.env.local` (local overrides for dev machines).
 * Variables already set in the shell are never overwritten.
 */
export function loadProjectEnv() {
  const root = repoRootEnvDir();
  const presetKeys = new Set(Object.keys(process.env));
  try {
    loadEnvFileQuiet(path.join(root, '.env'));
    loadEnvFileQuiet(path.join(root, '.env.local'), { override: true, presetKeys });
  } catch (e) {
    console.warn('[zarewa] Could not load env files:', e?.message || e);
  }
}
