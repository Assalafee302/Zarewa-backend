/**
 * Release gate: production build of the SPA (frontend package), full Vitest (backend), Playwright.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveFrontendRoot } from './frontendPaths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npmSpawn = () => ({ cmd: isWin ? 'npm.cmd' : 'npm', shell: isWin });

function run(title, args, opts = {}) {
  console.log(`\n${'='.repeat(72)}\n  ${title}\n${'='.repeat(72)}\n`);
  const { cmd, shell } = npmSpawn();
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    stdio: 'inherit',
    shell,
    env: { ...process.env, FORCE_COLOR: '1', ...opts.env },
  });
  if (r.error) {
    console.error(`\n[verify-complete] FAILED: ${title}\n`, r.error);
    process.exit(1);
  }
  if (r.signal) {
    console.error(`\n[verify-complete] FAILED: ${title} (signal ${r.signal})\n`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n[verify-complete] FAILED: ${title} (exit ${r.status ?? 1})\n`);
    process.exit(r.status ?? 1);
  }
}

const frontendRoot = resolveFrontendRoot();

run('Production build (frontend)', ['run', 'build'], { cwd: frontendRoot });
run('Full test suite (Vitest, backend)', ['run', 'test'], { cwd: root });
run('End-to-end (Playwright, all e2e/)', ['run', 'test:e2e'], { cwd: root });

console.log(`
${'*'.repeat(72)}
  ZAREWA VERIFY COMPLETE — all gates passed (frontend build + backend vitest + playwright)
${'*'.repeat(72)}
`);
