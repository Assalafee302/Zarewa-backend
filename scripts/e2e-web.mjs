/**
 * Single process for Playwright: API first, then Vite from the frontend package.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';
import { backendRoot, resolveViteCli } from './frontendPaths.mjs';

const root = backendRoot;
process.chdir(root);

const apiPort = process.env.E2E_API_PORT || process.env.PORT || '8788';
const env = {
  ...process.env,
  PORT: apiPort,
  E2E_API_PORT: apiPort,
};
// Local Playwright stack: default to XAMPP-style MySQL (empty root password) unless CI or explicitly disabled.
// Force local credentials — do not inherit Hostinger/.env remote user (cannot CREATE DATABASE zarewa_e2e).
// ZAREWA_LOCAL_XAMPP=1 makes loadProjectEnv() re-apply local MySQL after .env/.env.local overwrite.
if (!process.env.CI && process.env.ZAREWA_MYSQL_LOCAL !== '0') {
  env.ZAREWA_LOCAL_XAMPP = '1';
  env.ZAREWA_MYSQL_HOST = '127.0.0.1';
  env.ZAREWA_MYSQL_PORT = '3306';
  env.ZAREWA_MYSQL_USER = 'root';
  env.ZAREWA_MYSQL_PASSWORD = '';
}
// Playwright UI is http://127.0.0.1 — Secure cookies from .env would never persist in the browser.
env.COOKIE_SECURE = '0';
env.ZAREWA_COOKIE_DOMAIN = '';

function waitHealth(url, maxMs) {
  const deadline = Date.now() + maxMs;
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(`Timeout waiting for ${url}`));
          return;
        }
        setTimeout(ping, 250);
      });
    };
    ping();
  });
}

const apiPortStr = String(env.PORT || '8788');
const api = spawn(process.execPath, ['server/playwrightServer.js'], {
  cwd: root,
  env: {
    ...env,
    // Playwright stack must seed default demo users (admin, sales.staff, …) for login helpers.
    ZAREWA_ALLOW_SEEDED_USERS: '1',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

await waitHealth(`http://127.0.0.1:${apiPortStr}/api/health`, 120_000);

const { viteCli, frontendRoot } = resolveViteCli();
const uiPort = String(process.env.E2E_UI_PORT || '5180');
const vite = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', uiPort], {
  cwd: frontendRoot,
  env: {
    ...env,
    NODE_ENV: 'development',
    VITE_OFFICE_DESK_V2: process.env.VITE_OFFICE_DESK_V2 || '1',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

function shutdown() {
  try {
    api.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  try {
    vite.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

api.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  if (code && code !== 0) process.exit(code);
});

vite.on('exit', (code) => {
  shutdown();
  process.exit(code ?? 0);
});
