/**
 * Serve the Vite production build + API from one Node process, bound for LAN access.
 * Run after the SPA is built (`npm run build` from repo root or `frontend/`).
 * Local / LAN: `npm run serve:built:lan` — not a Hostinger "build" step (that command never exits).
 * If `ZAREWA_STATIC_DIR` is unset, uses `../frontend/dist` when `index.html` exists there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
if (!process.env.ZAREWA_LISTEN_HOST) process.env.ZAREWA_LISTEN_HOST = '0.0.0.0';

if (!process.env.ZAREWA_STATIC_DIR) {
  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sibling = path.join(backendRoot, '..', 'frontend', 'dist');
  if (fs.existsSync(path.join(sibling, 'index.html'))) {
    process.env.ZAREWA_STATIC_DIR = sibling;
  }
}

await import('../server/index.js');
