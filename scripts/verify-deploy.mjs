#!/usr/bin/env node
/**
 * Post-deploy verification for a Hostinger install.
 *
 * Hostinger pulls files on push but leaves the old Node process serving until the app is
 * restarted, so "deployed" and "running" are separate questions. This answers both, then
 * reports the refund credit drift the settlement change records as it runs.
 *
 *   node scripts/verify-deploy.mjs
 *   node scripts/verify-deploy.mjs --url https://api.example.com --logs ~/domains/x/logs
 *
 * Read-only. Nothing here writes to the database or changes application state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const apiUrl = argOf('--url', process.env.ZAREWA_VERIFY_URL || 'https://api.zarewaglobalservices.com');
const logDir = argOf('--logs', process.env.ZAREWA_LOG_DIR || '');

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const info = (m) => console.log(`    ${m}`);

function localCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 12);
  } catch {
    return '';
  }
}

async function checkHealth() {
  console.log(`\nHealth  ${apiUrl}/api/health`);
  let body;
  try {
    const res = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      bad(`Not JSON — HTTP ${res.status}. A Hostinger HTML page here means the Node app is not running.`);
      return null;
    }
  } catch (e) {
    bad(`Unreachable: ${e?.message || e}`);
    return null;
  }

  if (body.ok === true) ok('API is up');
  else bad(`API reports not ok${body.degraded ? ' (degraded — check ZAREWA_MYSQL_* and restart)' : ''}`);
  if (body.bootError) info(`bootError: ${body.bootError}`);

  if (!body.commit) {
    bad('No `commit` field — this build predates the health-probe change, so it is at least that old');
    return body;
  }

  const local = localCommit();
  ok(`running commit ${body.commit}`);
  if (local) {
    if (body.commit.startsWith(local) || local.startsWith(body.commit)) {
      ok('matches this checkout — the restart took');
    } else {
      bad(`this checkout is ${local} — files may be pulled but the app was not restarted`);
      info('Restart the Node app from hPanel, then re-run this.');
    }
  }
  if (body.startedAt) {
    const mins = Math.round((Date.now() - Date.parse(body.startedAt)) / 60000);
    info(`started ${body.startedAt} (${Number.isFinite(mins) ? `${mins} min ago` : 'unknown'})`);
  }
  return body;
}

/**
 * Refunds whose stored counter disagreed with the application ledger. Each line is a
 * refund that drifted before the settlement change landed — the map of historical damage.
 */
function checkCreditDrift() {
  console.log('\nRefund credit drift');
  if (!logDir) {
    info('No --logs directory given, so the drift report is skipped.');
    info('Re-run with: --logs ~/domains/<your-api-domain>/logs');
    return;
  }
  let files;
  try {
    files = fs
      .readdirSync(logDir)
      .filter((f) => f.endsWith('.log') || f.endsWith('.txt'))
      .map((f) => path.join(logDir, f));
  } catch (e) {
    bad(`Cannot read ${logDir}: ${e?.message || e}`);
    return;
  }
  if (!files.length) {
    info(`No log files in ${logDir}`);
    return;
  }

  const seen = new Map();
  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('credit mismatch')) continue;
      const id = /refund (\S+) credit mismatch/.exec(line)?.[1] || 'unknown';
      if (!seen.has(id)) seen.set(id, line.trim());
    }
  }

  if (seen.size === 0) {
    info('No mismatches recorded.');
    info('Expect at least a few if refunds drifted historically. Zero either means the');
    info('data was always clean, or the process restarted recently and has not served');
    info('a refund list yet — open the Finance desk once, then re-run.');
    return;
  }
  ok(`${seen.size} refund${seen.size === 1 ? '' : 's'} drifted`);
  for (const [, line] of [...seen].slice(0, 20)) info(line);
  if (seen.size > 20) info(`… and ${seen.size - 20} more`);
  console.log('');
  info('A handful is expected and already handled — settlement takes the higher figure.');
  info('A large number means a writer is still not recording its applications.');
}

const health = await checkHealth();
checkCreditDrift();

console.log('\nStill needs a person:');
console.log('  · Open Finance → Desk and confirm the oldest receipt is now at the top.');
console.log('  · Confirm the receipt bank dropdown fills immediately (hard-refresh first).');
console.log('');

// exitCode rather than exit(): a hard exit while fetch's handle is still closing trips a
// libuv assertion on Windows, which looks like a crash in a script meant to reassure.
process.exitCode = health?.ok === true ? 0 : 1;
