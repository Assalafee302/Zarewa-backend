/**
 * Immutable human-readable filing references (ZR/...).
 */
import { DEFAULT_BRANCH_ID } from './branches.js';

function nowIso() {
  return new Date().toISOString();
}

function ensureCountersTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reference_counters (
      scope_key TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL DEFAULT 0,
      updated_at_iso TEXT NOT NULL
    );
  `);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string; domain: string; year?: string }} opts
 */
export function issueZarewaFilingReference(db, opts) {
  ensureCountersTable(db);
  const branch = String(opts.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const domain = String(opts.domain || 'GEN')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '')
    .slice(0, 8) || 'GEN';
  const y = String(opts.year || '').trim() || new Date().getUTCFullYear().toString();
  const scopeKey = `${branch}|${domain}|${y}`;
  const t = nowIso();
  let seq = 1;
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO reference_counters (scope_key, last_seq, updated_at_iso) VALUES (?, 0, ?)`
    ).run(scopeKey, t);
    db.prepare(
      `UPDATE reference_counters SET last_seq = last_seq + 1, updated_at_iso = ? WHERE scope_key = ?`
    ).run(t, scopeKey);
    const row = db.prepare(`SELECT last_seq FROM reference_counters WHERE scope_key = ?`).get(scopeKey);
    seq = Math.max(1, Number(row?.last_seq) || 1);
  })();
  return `ZR/${branch}/${domain}/${y}/${String(seq).padStart(5, '0')}`;
}
