/**
 * Local dev: Zarewa API (default :8787) + Vite in one process.
 * Vite runs from the frontend package (`../frontend` or `ZAREWA_FRONTEND_ROOT`).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveViteCli } from './frontendPaths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiEntry = path.join(root, 'server', 'index.js');
const { viteCli, frontendRoot } = resolveViteCli();

const children = [];

function spawnChild(args, opts, label) {
  const child = spawn(process.execPath, args, {
    ...opts,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', (err) => console.error(`[${label}]`, err));
  children.push({ child, label });
  return child;
}

const api = spawnChild(
  [apiEntry],
  {
    cwd: root,
    env: {
      ...process.env,
      ZAREWA_LISTEN_HOST: process.env.ZAREWA_LISTEN_HOST || '0.0.0.0',
    },
  },
  'api'
);
const vite = spawnChild([viteCli, '--host', '0.0.0.0'], { cwd: frontendRoot, env: { ...process.env } }, 'vite');

function shutdown(code = 0) {
  for (const { child, label } of children) {
    if (child.exitCode == null && child.signalCode == null) {
      try {
        child.kill('SIGTERM');
      } catch (e) {
        console.error(`[${label}] kill`, e);
      }
    }
  }
  setTimeout(() => process.exit(code), 500).unref();
}

function onChildExit(which, code, signal) {
  const reason = signal ? `signal ${signal}` : `code ${code}`;
  console.error(`[${which}] exited (${reason}); stopping dev stack.`);
  shutdown(code === 0 || code === null ? 0 : 1);
}

api.on('exit', (code, signal) => onChildExit('api', code, signal));
vite.on('exit', (code, signal) => onChildExit('vite', code, signal));

process.on('SIGINT', () => {
  console.error('\nStopping API + Vite…');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
