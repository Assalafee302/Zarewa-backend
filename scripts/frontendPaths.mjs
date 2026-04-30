import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Backend package root (parent of `scripts/`). */
export const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * SPA package root (contains `vite.config.js` and `package.json`).
 * Set `ZAREWA_FRONTEND_ROOT` when `frontend/` is not a sibling of `backend/`.
 */
export function resolveFrontendRoot() {
  const fromEnv = String(process.env.ZAREWA_FRONTEND_ROOT || '').trim();
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    if (!fs.existsSync(path.join(abs, 'package.json'))) {
      throw new Error(`ZAREWA_FRONTEND_ROOT=${fromEnv} is not a package root (missing package.json).`);
    }
    return abs;
  }
  const sibling = path.join(backendRoot, '..', 'frontend');
  if (fs.existsSync(path.join(sibling, 'package.json'))) {
    return sibling;
  }
  throw new Error(
    'Could not find the frontend package. Set ZAREWA_FRONTEND_ROOT to its directory, or place it at ../frontend relative to backend/.'
  );
}

/** Vite CLI path and SPA cwd (npm workspaces may hoist `vite` to the repo root). */
export function resolveViteCli() {
  const frontendRoot = resolveFrontendRoot();
  const candidates = [
    path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    path.join(backendRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    path.join(backendRoot, '..', 'node_modules', 'vite', 'bin', 'vite.js'),
  ];
  for (const viteCli of candidates) {
    if (fs.existsSync(viteCli)) {
      return { viteCli, frontendRoot };
    }
  }
  throw new Error(
    'Could not find vite. Run `npm install` from the repository root (workspaces) or install dependencies inside frontend/.'
  );
}
