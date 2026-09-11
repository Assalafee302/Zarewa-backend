/**
 * Which commit this process is running, and when it started.
 *
 * Hostinger pulls new files on push but leaves the old Node process serving until
 * someone restarts the app, so "the code is deployed" and "the code is running" are
 * different questions. Without this, a restart that silently failed looks exactly like
 * a successful one from outside — the health probe answers `ok: true` either way.
 *
 * Read from .git directly rather than shelling out to git: no binary dependency, and
 * the liveness module it feeds is meant to stay fast and dependency-free. Resolved once
 * at import, because the commit cannot change without a restart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} gitDir @param {string} ref e.g. refs/heads/main */
function readRef(gitDir, ref) {
  try {
    const direct = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    if (direct) return direct;
  } catch {
    /* packed instead — fall through */
  }
  try {
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha) return sha;
    }
  } catch {
    /* no packed-refs either */
  }
  return '';
}

function resolveCommit() {
  const fromEnv = String(process.env.ZAREWA_COMMIT_SHA || '').trim();
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    const gitDir = path.join(repoRoot, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    // Detached HEAD stores the sha itself; otherwise it points at a ref.
    const sha = head.startsWith('ref:') ? readRef(gitDir, head.slice(4).trim()) : head;
    return sha ? sha.slice(0, 12) : 'unknown';
  } catch {
    // Deployed as a file copy with no .git, or the directory is unreadable.
    return 'unknown';
  }
}

/** Short sha of the running code, or 'unknown' when it cannot be determined. */
export const DEPLOYED_COMMIT = resolveCommit();

/** When this process booted — proves whether a restart actually took effect. */
export const PROCESS_STARTED_AT_ISO = new Date().toISOString();
