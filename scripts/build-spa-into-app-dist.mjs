/**
 * Hostinger / same-origin deploy: build the Vite SPA and copy it to app/dist
 * so ZAREWA_STATIC_DIR=app/dist is populated.
 *
 * Set ZAREWA_SPA_ROOT to the frontend repo root (folder that contains package.json
 * and produces `dist/` after `npm run build`). Example: ./frontend (git submodule).
 *
 * If ZAREWA_SPA_ROOT is unset, this script no-ops (exit 0) so plain API builds keep working.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');
const appDist = path.join(backendRoot, 'app', 'dist');

const spaRootRaw = String(process.env.ZAREWA_SPA_ROOT || '').trim();
if (!spaRootRaw) {
  console.log(
    '[zarewa] ZAREWA_SPA_ROOT unset — skipping SPA build (set it to your frontend root to fill app/dist).'
  );
  process.exit(0);
}

const spaRoot = path.resolve(backendRoot, spaRootRaw);
const spaPkg = path.join(spaRoot, 'package.json');
if (!fs.existsSync(spaPkg)) {
  console.error(`[zarewa] ZAREWA_SPA_ROOT=${spaRootRaw} resolved to ${spaRoot} — no package.json.`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log(`[zarewa] SPA build: npm ci in ${spaRoot}`);
run('npm', ['ci'], spaRoot);
console.log(`[zarewa] SPA build: npm run build in ${spaRoot}`);
run('npm', ['run', 'build'], spaRoot);

const viteDist = path.join(spaRoot, 'dist');
if (!fs.existsSync(path.join(viteDist, 'index.html'))) {
  console.error(`[zarewa] Expected ${path.join(viteDist, 'index.html')} after frontend build.`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(appDist), { recursive: true });
fs.rmSync(appDist, { recursive: true, force: true });
fs.cpSync(viteDist, appDist, { recursive: true });
console.log(`[zarewa] Copied SPA dist → ${appDist}`);
