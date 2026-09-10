import crypto from 'node:crypto';
import { branchWhere } from './readModel.js';
import { jsonWeakEtag } from './httpEtag.js';

/** @type {ReadonlyArray<[table: string, dateCol: string]>} */
const REVISION_TABLES = [
  ['quotations', 'date_iso'],
  ['sales_receipts', 'date_iso'],
  ['customers', 'last_activity_iso'],
  ['cutting_lists', 'date_iso'],
  ['production_jobs', 'created_at_iso'],
  ['purchase_orders', 'order_date_iso'],
  ['coil_lots', 'received_at_iso'],
  ['ledger_entries', 'at_iso'],
  ['treasury_movements', 'at_iso'],
  ['expenses', 'date'],
  ['payment_requests', 'request_date'],
  ['work_items', 'updated_at_iso'],
];

/**
 * Which desk domains each revision table feeds. A table listed under several domains
 * invalidates all of them: over-refreshing costs bandwidth, under-refreshing shows a
 * clerk stale money, so anything ambiguous belongs in both.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const TABLE_DOMAINS = Object.freeze({
  quotations: ['sales'],
  sales_receipts: ['sales', 'finance'],
  customers: ['sales'],
  cutting_lists: ['sales', 'operations'],
  production_jobs: ['operations'],
  purchase_orders: ['procurement'],
  coil_lots: ['operations', 'procurement'],
  ledger_entries: ['finance'],
  treasury_movements: ['finance'],
  expenses: ['finance'],
  payment_requests: ['finance', 'procurement'],
  work_items: ['sales', 'operations', 'finance', 'procurement'],
});

const REVISION_DOMAIN_KEYS = Object.freeze(['sales', 'operations', 'finance', 'procurement']);

/**
 * Per-domain revisions from the same table fingerprints the global hash is built from.
 * Lets a poll answer "did *my* desk change" instead of "did anything anywhere change" —
 * without this one cashier's receipt makes every connected client re-pull its desk pack.
 * @param {ReadonlyArray<string>} parts `table:count:max` fingerprints, scope entry first
 * @param {string} branchScope
 */
function domainRevisions(parts, branchScope) {
  /** @type {Record<string, string[]>} */
  const byDomain = Object.fromEntries(REVISION_DOMAIN_KEYS.map((d) => [d, [`scope:${branchScope}`]]));
  for (const part of parts) {
    const table = String(part).split(':')[0];
    for (const domain of TABLE_DOMAINS[table] || []) {
      byDomain[domain].push(part);
    }
  }
  return Object.fromEntries(
    REVISION_DOMAIN_KEYS.map((d) => [
      d,
      crypto.createHash('sha256').update(byDomain[d].join('|')).digest('base64url').slice(0, 16),
    ])
  );
}

/**
 * Cheap workspace revision — avoids building full bootstrap on poll when nothing changed.
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
export function buildWorkspaceRevision(db, branchScope = 'ALL') {
  const parts = [`scope:${branchScope}`];
  for (const [table, dateCol] of REVISION_TABLES) {
    try {
      const b = branchWhere(db, table, branchScope);
      const row = db
        .prepare(`SELECT COUNT(*) AS c, MAX(${dateCol}) AS m FROM ${table} WHERE 1=1${b.sql}`)
        .get(...b.args);
      parts.push(`${table}:${row?.c ?? 0}:${row?.m ?? ''}`);
    } catch {
      parts.push(`${table}:na`);
    }
  }
  const revision = crypto.createHash('sha256').update(parts.join('|')).digest('base64url').slice(0, 24);
  return {
    ok: true,
    revision,
    domains: domainRevisions(parts.slice(1), branchScope),
    branchScope,
    checkedAtIso: new Date().toISOString(),
  };
}

/**
 * Async revision — parallel COUNT/MAX via db.async (main-thread pool, no Atomics.wait).
 * Falls back to sync buildWorkspaceRevision when async is unavailable.
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
export async function buildWorkspaceRevisionAsync(db, branchScope = 'ALL') {
  if (!db?.async?.prepare) return buildWorkspaceRevision(db, branchScope);
  const parts = new Array(REVISION_TABLES.length + 1);
  parts[0] = `scope:${branchScope}`;
  await Promise.all(
    REVISION_TABLES.map(async ([table, dateCol], i) => {
      try {
        const b = branchWhere(db, table, branchScope);
        const row = await db.async
          .prepare(`SELECT COUNT(*) AS c, MAX(${dateCol}) AS m FROM ${table} WHERE 1=1${b.sql}`)
          .get(...b.args);
        parts[i + 1] = `${table}:${row?.c ?? 0}:${row?.m ?? ''}`;
      } catch {
        parts[i + 1] = `${table}:na`;
      }
    })
  );
  const revision = crypto.createHash('sha256').update(parts.join('|')).digest('base64url').slice(0, 24);
  return {
    ok: true,
    revision,
    domains: domainRevisions(parts.slice(1), branchScope),
    branchScope,
    checkedAtIso: new Date().toISOString(),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
export function workspaceRevisionEtag(db, branchScope = 'ALL') {
  return jsonWeakEtag(buildWorkspaceRevision(db, branchScope));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
export async function workspaceRevisionEtagAsync(db, branchScope = 'ALL') {
  return jsonWeakEtag(await buildWorkspaceRevisionAsync(db, branchScope));
}
