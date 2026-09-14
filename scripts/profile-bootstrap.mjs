/**
 * Read-only profiler for the workspace bootstrap hot path.
 *
 * Wraps the db handle to count every statement, the rows they return and the
 * time they take, then builds the bootstrap snapshot and reports where the cost
 * actually sits. Useful for sizing the JS↔MySQL bridge overhead, which is
 * invisible in MySQL's own slow query log.
 *
 * Usage:
 *   node scripts/profile-bootstrap.mjs [--runs 3] [--mode full|dashboard|shell] [--top 25]
 */
import { createDatabase } from '../server/db.js';
import { buildBootstrap, buildDashboardBootstrap, buildShellBootstrap } from '../server/bootstrap.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const RUNS = Math.max(1, Number(arg('runs', 3)) || 3);
const MODE = String(arg('mode', 'full'));
const TOP = Math.max(1, Number(arg('top', 25)) || 25);

/** Collapse bind values so repeated shapes group together. */
function fingerprint(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function instrument(db) {
  const stats = new Map();
  let calls = 0;
  let rows = 0;
  let nanos = 0n;
  const realPrepare = db.prepare.bind(db);

  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    const key = fingerprint(sql);
    const wrap = (fn, countRows) => (...args) => {
      const t0 = process.hrtime.bigint();
      const out = fn(...args);
      const dt = process.hrtime.bigint() - t0;
      const n = countRows ? (Array.isArray(out) ? out.length : out ? 1 : 0) : 0;
      calls += 1;
      rows += n;
      nanos += dt;
      const s = stats.get(key) || { key, calls: 0, rows: 0, nanos: 0n };
      s.calls += 1;
      s.rows += n;
      s.nanos += dt;
      stats.set(key, s);
      return out;
    };
    return {
      run: wrap(stmt.run.bind(stmt), false),
      get: wrap(stmt.get.bind(stmt), true),
      all: wrap(stmt.all.bind(stmt), true),
    };
  };

  return {
    reset() {
      stats.clear();
      calls = 0;
      rows = 0;
      nanos = 0n;
    },
    snapshot() {
      return { stats: [...stats.values()], calls, rows, ms: Number(nanos) / 1e6 };
    },
  };
}

function build(db) {
  const opts = {
    user: null,
    session: { authenticated: false, user: null, permissions: [] },
    branchScope: 'ALL',
    skipSideEffects: true,
    skipWorkItemSync: true,
  };
  if (MODE === 'shell') return buildShellBootstrap(db, opts);
  if (MODE === 'dashboard') return buildDashboardBootstrap(db, { ...opts, limit: 600 });
  return buildBootstrap(db, opts);
}

console.log(`[profile] mode=${MODE} runs=${RUNS}`);
const db = createDatabase({ seed: false });
const probe = instrument(db);

/* Warm caches (schema probes, adapted-SQL plans) so steady-state cost is measured. */
build(db);
probe.reset();

const wallTimes = [];
let last = null;
for (let i = 0; i < RUNS; i += 1) {
  const t0 = process.hrtime.bigint();
  const payload = build(db);
  wallTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
  last = payload;
}

const snap = probe.snapshot();
const perRun = (n) => (n / RUNS).toFixed(1);
const wallAvg = wallTimes.reduce((a, b) => a + b, 0) / wallTimes.length;

console.log('');
console.log('=== per bootstrap build ===');
console.log(`wall clock       : ${wallAvg.toFixed(1)} ms  (runs: ${wallTimes.map((t) => t.toFixed(0)).join(', ')})`);
console.log(`db statements    : ${perRun(snap.calls)}`);
console.log(`rows returned    : ${perRun(snap.rows)}`);
console.log(`time inside db   : ${perRun(snap.ms)} ms  (${((snap.ms / RUNS / wallAvg) * 100).toFixed(0)}% of wall)`);
console.log(`time in JS       : ${(wallAvg - snap.ms / RUNS).toFixed(1)} ms`);

const payloadBytes = Buffer.byteLength(JSON.stringify(last ?? {}));
console.log(`payload size     : ${(payloadBytes / 1024 / 1024).toFixed(2)} MB`);

console.log('');
console.log(`=== top ${TOP} statements by total time ===`);
const ranked = snap.stats.sort((a, b) => Number(b.nanos - a.nanos)).slice(0, TOP);
for (const s of ranked) {
  const ms = Number(s.nanos) / 1e6 / RUNS;
  console.log(
    `${ms.toFixed(1).padStart(8)} ms  ${String(s.calls / RUNS).padStart(6)} calls  ${String(
      Math.round(s.rows / RUNS)
    ).padStart(7)} rows   ${s.key}`
  );
}

console.log('');
console.log('=== N+1 suspects (same statement shape run many times) ===');
const repeats = snap.stats
  .filter((s) => s.calls / RUNS >= 10)
  .sort((a, b) => b.calls - a.calls)
  .slice(0, 15);
if (!repeats.length) console.log('(none)');
for (const s of repeats) {
  console.log(
    `${String(Math.round(s.calls / RUNS)).padStart(6)}x  ${(Number(s.nanos) / 1e6 / RUNS)
      .toFixed(1)
      .padStart(8)} ms total   ${s.key}`
  );
}

db.close?.();
process.exit(0);
