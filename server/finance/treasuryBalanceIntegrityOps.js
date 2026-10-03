/**
 * Treasury balance integrity (Phase 2.1). Report-only: never rewrites the stored cache.
 *
 * - computed = opening_balance_ngn + SUM(amount_ngn); stored = treasury_accounts.balance.
 * - Per-account strict switch: only Admin/MD/CEO, only when difference is ₦0, always with a
 *   reason, always audited. Never switched automatically.
 * - "Last non-movement balance change": latest audit event that changed the stored balance
 *   without a movement (typed balance on account save, bulk replace, hard-delete cleanups,
 *   admin data reset). Helps Finance date the drift.
 * - Schema helpers here are additive only (new columns / tables, no UPDATE of history).
 */
import crypto from 'node:crypto';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { roundMoney } from '../ap2ReceivedBasisOps.js';
import { appendAuditLog } from '../controlOps.js';
import { isPrivilegedTreasuryActor, lagosCalendarDay } from '../../shared/lib/isoTimestamp.js';
import { branchDisplaysComputedBalance, getTreasuryPostingPolicy } from './treasuryPostingPolicy.js';
import { resetTreasuryColumnCache, tableColumnSet } from './treasuryMovementWrite.js';
import { investigationSuspenseTieOut } from '../office/investigationOps.js';

const MOVEMENT_COLUMNS = [
  ['created_at_iso', 'TEXT'],
  ['created_by_user_id', 'TEXT'],
  ['source_doc_date', 'TEXT'],
  ['date_override_reason', 'TEXT'],
  ['amount_floor_reason', 'TEXT'],
  ['duplicate_override_reason', 'TEXT'],
  ['idempotency_key', 'TEXT'],
];

const ACCOUNT_COLUMNS = [
  ['strict_cache_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['strict_cache_changed_at_iso', 'TEXT'],
  ['strict_cache_changed_by_user_id', 'TEXT'],
  ['strict_cache_changed_by_name', 'TEXT'],
  ['strict_cache_reason', 'TEXT'],
];

function addMissingColumns(db, table, columns) {
  const have = tableColumnSet(db, table);
  if (!have.size) return 0;
  let added = 0;
  for (const [name, ddl] of columns) {
    if (have.has(name)) continue;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
      added += 1;
    } catch {
      /* concurrent boot / already exists */
    }
  }
  return added;
}

/** Additive schema for Phase 2.1 (snapshot table, movement/account columns, idempotency keys). */
export function ensureTreasuryBalanceIntegritySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS treasury_balance_integrity_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at_iso TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      treasury_account_id INTEGER NOT NULL,
      opening_balance_ngn INTEGER NOT NULL DEFAULT 0,
      movement_sum_ngn INTEGER NOT NULL DEFAULT 0,
      computed_ngn INTEGER NOT NULL DEFAULT 0,
      stored_ngn INTEGER NOT NULL DEFAULT 0,
      difference_ngn INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS treasury_idempotency_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      route_key TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      response_json TEXT,
      created_at_iso TEXT NOT NULL,
      completed_at_iso TEXT
    )
  `);
  for (const sql of [
    `CREATE INDEX IF NOT EXISTS idx_treasury_integrity_ran ON treasury_balance_integrity_runs(ran_at_iso DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_treasury_integrity_acct ON treasury_balance_integrity_runs(treasury_account_id, ran_at_iso DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_treasury_idem_created ON treasury_idempotency_keys(created_at_iso)`,
  ]) {
    try {
      db.exec(sql);
    } catch {
      /* host dialect / already exists */
    }
  }
  resetTreasuryColumnCache(db);
  const added =
    addMissingColumns(db, 'treasury_movements', MOVEMENT_COLUMNS) +
    addMissingColumns(db, 'treasury_accounts', ACCOUNT_COLUMNS);
  resetTreasuryColumnCache(db);
  if (added) {
    try {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_treasury_movements_dup ON treasury_movements(treasury_account_id, amount_ngn, source_id)`
      );
    } catch {
      /* optional */
    }
  }
  return { ok: true, addedColumns: added };
}

/** Stable primary key for one (user, route, client key). */
export function treasuryIdempotencyRowId(userId, routeKey, idemKey) {
  return crypto
    .createHash('sha256')
    .update(`${String(userId)}|${String(routeKey)}|${String(idemKey)}`)
    .digest('hex');
}

function accountRows(db, branchId) {
  const bid = String(branchId || '').trim();
  if (!bid || bid === 'ALL') {
    return db.prepare(`SELECT * FROM treasury_accounts ORDER BY id`).all();
  }
  return db
    .prepare(
      `SELECT * FROM treasury_accounts
       WHERE TRIM(COALESCE(branch_id, '')) = ?
          OR (TRIM(COALESCE(branch_id, '')) = '' AND ? = ?)
       ORDER BY id`
    )
    .all(bid, bid, DEFAULT_BRANCH_ID);
}

function movementSumsByAccountId(db) {
  const rows = db
    .prepare(
      `SELECT treasury_account_id AS id, COALESCE(SUM(amount_ngn), 0) AS s
       FROM treasury_movements
       GROUP BY treasury_account_id`
    )
    .all();
  const map = new Map();
  for (const row of rows) map.set(Number(row.id), roundMoney(row.s));
  return map;
}

/**
 * Per-account end-of-day running balance from opening: negative-day count, first negative day,
 * lowest balance and its day.
 * @returns {Map<number, { negativeDayCount: number, firstNegativeDay: string, lowestBalanceNgn: number, lowestBalanceDay: string }>}
 */
function dailyBalanceStatsByAccountId(db, accounts) {
  const openingById = new Map(accounts.map((a) => [Number(a.id), roundMoney(a.opening_balance_ngn)]));
  const rows = db
    .prepare(
      `SELECT treasury_account_id AS id, SUBSTR(posted_at_iso, 1, 10) AS d, COALESCE(SUM(amount_ngn), 0) AS s
       FROM treasury_movements
       GROUP BY treasury_account_id, SUBSTR(posted_at_iso, 1, 10)
       ORDER BY treasury_account_id, d`
    )
    .all();
  const out = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    if (!openingById.has(id)) continue;
    let st = out.get(id);
    if (!st) {
      const opening = openingById.get(id);
      st = { running: opening, negativeDayCount: 0, firstNegativeDay: '', lowestBalanceNgn: opening, lowestBalanceDay: '' };
      out.set(id, st);
    }
    st.running += roundMoney(row.s);
    if (st.running < 0) {
      st.negativeDayCount += 1;
      if (!st.firstNegativeDay) st.firstNegativeDay = String(row.d || '');
    }
    if (st.running < st.lowestBalanceNgn) {
      st.lowestBalanceNgn = st.running;
      st.lowestBalanceDay = String(row.d || '');
    }
  }
  return out;
}

/** Audit actions that changed the stored balance without a treasury movement. */
const NON_MOVEMENT_ACTIONS = {
  'treasury_account.update': 'Typed balance on account save',
  'treasury_account.create': 'Typed balance on account create',
  'treasury.bulk_replace': 'Bulk account replace',
  'treasury.transfer.delete': 'Transfer hard-deleted',
  'receipt.delete': 'Receipt deleted with its cash-book lines',
  'quotation.delete': 'Quotation deleted with its cash-book lines',
  'payment_request.delete_rollout': 'Payment request rollout delete',
  'expense.delete_rollout': 'Expense rollout delete',
  'admin.data_reset': 'Admin data reset',
};

function parseDetails(raw) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Latest non-movement balance change per account.
 * Account-specific events (account save with a typed balance, transfer delete) are matched by id.
 * Events that never recorded an account (receipt/quotation/rollout deletes, bulk replace, data reset)
 * are reported per branch as "account not recorded". Events written after Phase 2.1 carry
 * `treasuryKept: true` (cash-book rows were reversed or untouched) and are skipped.
 * @returns {{ byAccount: Map<number, { atISO: string, action: string, label: string, actor: string }>, unattributed: { atISO: string, action: string, label: string, actor: string } | null }}
 */
function lastNonMovementChanges(db) {
  const actions = Object.keys(NON_MOVEMENT_ACTIONS);
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT occurred_at_iso, action, entity_id, actor_name, details_json FROM audit_log
         WHERE action IN (${actions.map(() => '?').join(',')})
         ORDER BY occurred_at_iso DESC`
      )
      .all(...actions);
  } catch {
    rows = [];
  }
  const byAccount = new Map();
  let unattributed = null;
  const put = (id, ev) => {
    const n = Number(id);
    if (!n || byAccount.has(n)) return;
    byAccount.set(n, ev);
  };
  for (const row of rows) {
    const action = String(row.action || '');
    const details = parseDetails(row.details_json);
    if (details.treasuryKept === true) continue;
    const ev = {
      atISO: String(row.occurred_at_iso || ''),
      action,
      label: NON_MOVEMENT_ACTIONS[action] || action,
      actor: String(row.actor_name || ''),
    };
    if (action === 'treasury_account.update' || action === 'treasury_account.create') {
      if (!Object.prototype.hasOwnProperty.call(details, 'balance')) continue;
      put(row.entity_id, ev);
    } else if (action === 'treasury.transfer.delete') {
      put(details.fromId, ev);
      put(details.toId, ev);
    } else if (!unattributed) {
      unattributed = ev;
    }
  }
  return { byAccount, unattributed };
}

function strictFields(acc) {
  return {
    strictCacheEnabled: Number(acc.strict_cache_enabled) === 1,
    strictCacheChangedAtISO: acc.strict_cache_changed_at_iso || '',
    strictCacheChangedBy: acc.strict_cache_changed_by_name || '',
    strictCacheReason: acc.strict_cache_reason || '',
  };
}

/**
 * Per-account stored vs computed, strict status, last non-movement change, negative days. Writes nothing.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [branchId]
 */
export function computeTreasuryBalanceIntegrity(db, branchId = 'ALL') {
  const policy = getTreasuryPostingPolicy(db);
  const sums = movementSumsByAccountId(db);
  const rows = accountRows(db, branchId);
  const daily = dailyBalanceStatsByAccountId(db, rows);
  const changes = lastNonMovementChanges(db);
  const accounts = rows.map((acc) => {
    const id = Number(acc.id);
    const opening = roundMoney(acc.opening_balance_ngn);
    const stored = roundMoney(acc.balance);
    const sum = sums.get(id) || 0;
    const computed = roundMoney(opening + sum);
    const accBranch = String(acc.branch_id || '').trim() || DEFAULT_BRANCH_ID;
    const ev = changes.byAccount.get(id) || null;
    const st = daily.get(id);
    return {
      treasuryAccountId: id,
      accountName: acc.name || `#${id}`,
      accountType: acc.type || '',
      bankName: acc.bank_name || '',
      accNo: acc.acc_no || '',
      branchId: accBranch,
      openingBalanceNgn: opening,
      movementSumNgn: sum,
      computedBalanceNgn: computed,
      storedBalanceNgn: stored,
      differenceNgn: roundMoney(stored - computed),
      wouldBecomeNgn: computed,
      rebuildDeltaNgn: roundMoney(computed - stored),
      displayComputed: branchDisplaysComputedBalance(policy, accBranch),
      ...strictFields(acc),
      lastNonMovementChangeAtISO: ev?.atISO || '',
      lastNonMovementChangeKind: ev?.label || '',
      lastNonMovementChangeBy: ev?.actor || '',
      negativeDayCount: st?.negativeDayCount || 0,
      firstNegativeDay: st?.firstNegativeDay || '',
      lowestBalanceNgn: st ? st.lowestBalanceNgn : opening,
      lowestBalanceDay: st?.lowestBalanceDay || '',
    };
  });
  return {
    ok: true,
    branchId: String(branchId || 'ALL'),
    ranAtISO: new Date().toISOString(),
    accounts,
    unattributedNonMovementChange: changes.unattributed
      ? {
          atISO: changes.unattributed.atISO,
          kind: changes.unattributed.label,
          by: changes.unattributed.actor,
          note: 'This event removed cash-book lines without recording which account they were on.',
        }
      : null,
    investigationSuspense: investigationSuspenseTieOut(db),
  };
}

/** Dry-run alias: same numbers a rebuild would apply, without UPDATE. */
export function previewTreasuryBalanceRebuild(db, branchId) {
  const report = computeTreasuryBalanceIntegrity(db, branchId);
  return {
    ...report,
    wroteRows: 0,
    message: 'Dry-run only. Stored balances were not changed.',
  };
}

/**
 * Attach computed fields used by listTreasuryAccounts / bootstrap.
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} accounts
 */
export function attachTreasuryComputedBalances(db, accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (!list.length) return list;
  const policy = getTreasuryPostingPolicy(db);
  const sums = movementSumsByAccountId(db);
  const cols = tableColumnSet(db, 'treasury_accounts');
  const strictById = new Map();
  if (cols.has('strict_cache_enabled')) {
    for (const r of db.prepare(`SELECT id, strict_cache_enabled FROM treasury_accounts`).all()) {
      strictById.set(Number(r.id), Number(r.strict_cache_enabled) === 1);
    }
  }
  return list.map((acc) => {
    const id = Number(acc.id);
    const opening = roundMoney(acc.openingBalanceNgn ?? acc.opening_balance_ngn);
    const stored = roundMoney(acc.storedBalanceNgn ?? acc.balance);
    const movementSumNgn = sums.get(id) || 0;
    const computedBalanceNgn = roundMoney(opening + movementSumNgn);
    const branchId = String(acc.branchId || acc.branch_id || '').trim() || DEFAULT_BRANCH_ID;
    return {
      ...acc,
      storedBalanceNgn: stored,
      movementSumNgn,
      computedBalanceNgn,
      differenceNgn: roundMoney(stored - computedBalanceNgn),
      displayComputed: branchDisplaysComputedBalance(policy, branchId),
      strictCacheEnabled: strictById.get(id) === true,
    };
  });
}

/**
 * Admin/MD switch: strict cache checking for one account.
 * Turning on requires difference = ₦0 at the moment of the switch. Both directions need a reason.
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} accountId
 * @param {{ enabled?: boolean, reason?: string }} payload
 * @param {object|null} actor
 */
export function setTreasuryAccountStrictCache(db, accountId, payload, actor) {
  if (!isPrivilegedTreasuryActor(actor)) {
    return { ok: false, status: 403, error: 'Only Admin or MD can change strict balance checking.' };
  }
  const id = Number(accountId);
  const enabled = payload?.enabled === true;
  const reason = String(payload?.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'A reason is required.' };
  if (!tableColumnSet(db, 'treasury_accounts').has('strict_cache_enabled')) {
    return { ok: false, error: 'Strict balance columns are not migrated yet.' };
  }
  let result = null;
  try {
    db.transaction(() => {
      const acc = db.prepare(`SELECT * FROM treasury_accounts WHERE id = ?`).get(id);
      if (!acc) throw new Error('Treasury account not found.');
      const was = Number(acc.strict_cache_enabled) === 1;
      if (was === enabled) {
        result = { ok: true, noOp: true, strictCacheEnabled: was };
        return;
      }
      const sum = db
        .prepare(`SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements WHERE treasury_account_id = ?`)
        .get(id);
      const computed = roundMoney(acc.opening_balance_ngn) + roundMoney(sum?.s);
      const stored = roundMoney(acc.balance);
      const difference = stored - computed;
      if (enabled && difference !== 0) {
        throw new Error(
          `Cannot switch ${acc.name} to strict: stored ₦${stored.toLocaleString('en-NG')} differs from opening + movements ₦${computed.toLocaleString('en-NG')} by ₦${difference.toLocaleString('en-NG')}.`
        );
      }
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE treasury_accounts
         SET strict_cache_enabled = ?, strict_cache_changed_at_iso = ?, strict_cache_changed_by_user_id = ?,
             strict_cache_changed_by_name = ?, strict_cache_reason = ?
         WHERE id = ?`
      ).run(
        enabled ? 1 : 0,
        now,
        actor?.id != null ? String(actor.id) : null,
        String(actor?.displayName || actor?.username || ''),
        reason,
        id
      );
      appendAuditLog(db, {
        actor,
        action: enabled ? 'treasury_account.strict_cache_on' : 'treasury_account.strict_cache_off',
        entityKind: 'treasury_account',
        entityId: String(id),
        note: reason,
        details: { oldEnabled: was, newEnabled: enabled, storedNgn: stored, computedNgn: computed, differenceNgn: difference, reason },
      });
      result = { ok: true, strictCacheEnabled: enabled, changedAtISO: now };
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return result;
}

/**
 * Persist one snapshot row per account. Additive; never updates treasury_accounts.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [branchId]
 */
export function recordTreasuryBalanceIntegrityRun(db, branchId = 'ALL') {
  ensureTreasuryBalanceIntegritySchema(db);
  const report = computeTreasuryBalanceIntegrity(db, branchId);
  const ins = db.prepare(
    `INSERT INTO treasury_balance_integrity_runs (
      ran_at_iso, branch_id, treasury_account_id, opening_balance_ngn, movement_sum_ngn,
      computed_ngn, stored_ngn, difference_ngn
    ) VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const row of report.accounts) {
    ins.run(
      report.ranAtISO,
      row.branchId,
      row.treasuryAccountId,
      row.openingBalanceNgn,
      row.movementSumNgn,
      row.computedBalanceNgn,
      row.storedBalanceNgn,
      row.differenceNgn
    );
  }
  return report;
}

/**
 * Daily snapshot: writes one run per Lagos calendar day (maintenance ticks every few minutes).
 * @param {import('better-sqlite3').Database} db
 */
export function recordTreasuryBalanceIntegrityRunIfDue(db) {
  ensureTreasuryBalanceIntegritySchema(db);
  const today = lagosCalendarDay();
  const last = db
    .prepare(`SELECT ran_at_iso FROM treasury_balance_integrity_runs ORDER BY ran_at_iso DESC LIMIT 1`)
    .get();
  if (last?.ran_at_iso && lagosCalendarDay(new Date(String(last.ran_at_iso))) === today) {
    return { ok: true, skipped: true };
  }
  return recordTreasuryBalanceIntegrityRun(db, 'ALL');
}

/**
 * HTTP pack for GET /api/treasury/integrity.
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string, persist?: boolean }} [opts]
 */
export function buildTreasuryBalanceIntegrityReport(db, opts = {}) {
  const branchId = String(opts.branchId || 'ALL').trim() || 'ALL';
  if (opts.persist) return recordTreasuryBalanceIntegrityRun(db, branchId);
  return computeTreasuryBalanceIntegrity(db, branchId);
}
