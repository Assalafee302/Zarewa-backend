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
 * Keys in `.env.local` always override `.env` (and override shell for those keys),
 * except when `ZAREWA_LOCAL_XAMPP=1` (start:local-xampp) which re-applies local MySQL after files.
 */
export function loadProjectEnv() {
  const root = repoRootEnvDir();
  const forceLocalXampp = String(process.env.ZAREWA_LOCAL_XAMPP || '').trim() === '1';
  try {
    loadEnvFileQuiet(path.join(root, '.env'));
    const localPath = path.join(root, '.env.local');
    if (fs.existsSync(localPath)) {
      for (const [key, value] of parseEnvLines(fs.readFileSync(localPath, 'utf8'))) {
        process.env[key] = value;
      }
    }
    if (forceLocalXampp) {
      process.env.ZAREWA_MYSQL_HOST = '127.0.0.1';
      process.env.ZAREWA_MYSQL_PORT = '3306';
      process.env.ZAREWA_MYSQL_USER = 'root';
      process.env.ZAREWA_MYSQL_PASSWORD = '';
      process.env.ZAREWA_MYSQL_DATABASE = 'zarewa_db';
      process.env.ZAREWA_COOKIE_DOMAIN = '';
      process.env.COOKIE_SECURE = '0';
      process.env.ZAREWA_COOKIE_SAMESITE = 'lax';
      if (!process.env.ZAREWA_ALLOW_SEEDED_USERS) process.env.ZAREWA_ALLOW_SEEDED_USERS = '1';
    }
  } catch (e) {
    console.warn('[zarewa] Could not load env files:', e?.message || e);
  }
}
