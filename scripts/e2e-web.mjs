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
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});

await waitHealth(`http://127.0.0.1:${apiPortStr}/api/health`, 120_000);

const { viteCli, frontendRoot } = resolveViteCli();
const uiPort = String(process.env.E2E_UI_PORT || '5180');
const vite = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', uiPort], {
  cwd: frontendRoot,
  env: { ...env, NODE_ENV: 'development' },
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
