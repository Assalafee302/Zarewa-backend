/**
 * Company-cut retention ledger (credits + balances). No controlOps/writeOps imports
 * so partner-wallet approval can credit without circular deps.
 *
 * Policy: company-cut credits are available as soon as they settle on the ledger.
 * Withdrawals are rate-limited — another request is allowed only after
 * `cooldownDays` from the last *paid* withdrawal (not from credit age).
 *
 * @module server/finance/refundCompanyRetentionLedger
 */
import { actorId, actorName } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { allocateHumanId } from '../humanId.js';
import { hasColumn, tableExists } from '../ap2ReceivedBasisOps.js';

/** Days after a paid company-cut withdrawal before another may be requested. */
export const REFUND_COMPANY_CUT_WITHDRAWAL_COOLDOWN_DAYS_DEFAULT = 14;
/** @deprecated Use REFUND_COMPANY_CUT_WITHDRAWAL_COOLDOWN_DAYS_DEFAULT */
export const REFUND_COMPANY_CUT_HOLD_DAYS_DEFAULT =
  REFUND_COMPANY_CUT_WITHDRAWAL_COOLDOWN_DAYS_DEFAULT;

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

export const RETENTION_WITHDRAWAL_FREEZE_KEY = 'refund_company_retention.withdrawal_freeze';

function policyTableReady(db) {
  try {
    db.prepare(`SELECT 1 FROM org_policy_kv LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

/** Global on/off for retention withdrawals. Missing key means not frozen. */
export function getRetentionWithdrawalFreeze(db) {
  if (!policyTableReady(db)) return { enabled: false, reason: '' };
  try {
    const row = db
      .prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`)
      .get(RETENTION_WITHDRAWAL_FREEZE_KEY);
    if (!row?.value_json) return { enabled: false, reason: '' };
    const parsed = JSON.parse(String(row.value_json));
    return {
      enabled: parsed?.enabled === true,
      reason: String(parsed?.reason || '').trim(),
    };
  } catch {
    return { enabled: false, reason: '' };
  }
}

export function retentionWithdrawalFreezeBlock(db) {
  const freeze = getRetentionWithdrawalFreeze(db);
  if (!freeze.enabled) return null;
  return {
    ok: false,
    code: 'RETENTION_WITHDRAWAL_FROZEN',
    error: freeze.reason
      ? `Company retention withdrawals are frozen: ${freeze.reason}`
      : 'Company retention withdrawals are frozen.',
  };
}

/** @returns {Map<string, string[]>} refund id → investigation case ids */
export function investigationCaseIdsByRefundId(db) {
  const map = new Map();
  try {
    const rows = db
      .prepare(`SELECT entity_id, case_id FROM investigation_links WHERE entity_type = 'refund'`)
      .all();
    for (const row of rows) {
      const id = String(row.entity_id || '').trim();
      const caseId = String(row.case_id || '').trim();
      if (!id || !caseId) continue;
      if (!map.has(id)) map.set(id, []);
      if (!map.get(id).includes(caseId)) map.get(id).push(caseId);
    }
  } catch {
    /* investigation tables may be absent */
  }
  return map;
}

function trim(v) {
  return String(v ?? '').trim();
}

/**
 * Cooldown between paid company-cut withdrawals (env: ZAREWA_REFUND_COMPANY_CUT_HOLD_DAYS).
 * Kept env name for deploy compatibility; semantics are withdrawal spacing, not credit aging.
 */
export function refundCompanyCutWithdrawalCooldownDays() {
  const raw = Number(process.env.ZAREWA_REFUND_COMPANY_CUT_HOLD_DAYS);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 365) return Math.round(raw);
  return REFUND_COMPANY_CUT_WITHDRAWAL_COOLDOWN_DAYS_DEFAULT;
}

/** @deprecated Use refundCompanyCutWithdrawalCooldownDays */
export function refundCompanyCutHoldDays() {
  return refundCompanyCutWithdrawalCooldownDays();
}

export function refundCompanyRetentionTablesReady(db) {
  if (!tableExists(db, 'refund_company_retention_entries')) return false;
  return hasColumn(db, 'refund_company_retention_entries', 'open_ngn');
}

export function nextRetentionEntryId(db, branchId) {
  return allocateHumanId(db, 'RCR', branchId || DEFAULT_BRANCH_ID, {
    table: 'refund_company_retention_entries',
    idColumn: 'id',
  });
}

function addDaysIso(iso, days) {
  const d = new Date(iso || Date.now());
  if (Number.isNaN(d.getTime())) {
    const fallback = new Date();
    fallback.setUTCDate(fallback.getUTCDate() + days);
    return fallback.toISOString();
  }
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function creditCompanyRetentionFromRefundTx(db, {
  refundId,
  branchId,
  amountNgn,
  actor,
  note,
} = {}) {
  if (!refundCompanyRetentionTablesReady(db)) {
    return { ok: true, skipped: true, reason: 'tables_missing' };
  }
  const rid = trim(refundId);
  const amt = roundMoney(amountNgn);
  if (!rid || amt <= 0) return { ok: true, skipped: true, reason: 'no_amount' };

  const existing = db
    .prepare(
      `SELECT id FROM refund_company_retention_entries
       WHERE entry_type = 'credit' AND source_kind = 'REFUND_COMPANY_CUT' AND source_id = ?`
    )
    .get(rid);
  if (existing?.id) return { ok: true, skipped: true, reason: 'already_credited' };

  const bid = trim(branchId) || DEFAULT_BRANCH_ID;
  const at = new Date().toISOString();
  // Credits are withdrawable immediately; spacing is enforced between paid withdrawals.
  const availableAfterIso = null;
  const id = nextRetentionEntryId(db, bid);
  db.prepare(
    `INSERT INTO refund_company_retention_entries (
       id, branch_id, entry_type, amount_ngn, open_ngn,
       source_kind, source_id, refund_id, available_after_iso,
       withdrawal_id, note, created_at_iso, created_by_user_id, created_by_name
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    bid,
    'credit',
    amt,
    amt,
    'REFUND_COMPANY_CUT',
    rid,
    rid,
    availableAfterIso,
    null,
    note || `Company cut from refund ${rid}`,
    at,
    actorId(actor),
    actorName(actor)
  );

  return {
    ok: true,
    entry: {
      id,
      amountNgn: amt,
      availableAfterIso,
      cooldownDays: refundCompanyCutWithdrawalCooldownDays(),
    },
  };
}

/**
 * Raise an untouched company-cut credit to a higher open balance.
 * Refuses if any of that credit was already withdrawn (open is below the original amount).
 * Does not insert a second credit for the same refund.
 * @param {import('better-sqlite3').Database} db
 * @param {{ refundId: string, nextAmountNgn: number, note?: string }} payload
 */
export function raiseOpenCompanyRetentionCreditTx(db, { refundId, nextAmountNgn, note } = {}) {
  if (!refundCompanyRetentionTablesReady(db)) {
    return { ok: false, error: 'Company retention ledger is not ready.' };
  }
  const rid = trim(refundId);
  const next = roundMoney(nextAmountNgn);
  if (!rid || next <= 0) return { ok: false, error: 'Refund and a positive retention amount are required.' };
  const row = db
    .prepare(
      `SELECT id, amount_ngn, open_ngn, note FROM refund_company_retention_entries
       WHERE entry_type = 'credit' AND source_kind = 'REFUND_COMPANY_CUT' AND source_id = ?`
    )
    .get(rid);
  if (!row?.id) return { ok: false, error: 'No company-cut credit on this refund.' };
  const current = roundMoney(row.amount_ngn);
  const open = roundMoney(row.open_ngn);
  if (open !== current) {
    return { ok: false, error: 'Company cut on this refund was already withdrawn, so it cannot be raised.' };
  }
  if (next < current) {
    return { ok: false, error: 'This path only raises an open company cut. It does not reduce one.' };
  }
  if (next === current) return { ok: true, noOp: true, id: row.id, amountNgn: current, previousAmountNgn: current };
  const extra = String(note || '').trim();
  const merged = extra ? `${String(row.note || '').trim()} — ${extra}`.trim() : String(row.note || '');
  db.prepare(
    `UPDATE refund_company_retention_entries SET amount_ngn = ?, open_ngn = ?, note = ? WHERE id = ?`
  ).run(next, next, merged || null, row.id);
  return { ok: true, id: row.id, previousAmountNgn: current, amountNgn: next };
}

export function voidCompanyRetentionForRefundTx(db, refundId) {
  if (!refundCompanyRetentionTablesReady(db)) return { ok: true, skipped: true };
  const rid = trim(refundId);
  if (!rid) return { ok: true };
  const open = db
    .prepare(
      `SELECT id, amount_ngn, open_ngn FROM refund_company_retention_entries
       WHERE entry_type = 'credit' AND refund_id = ?`
    )
    .all(rid);
  for (const row of open) {
    if (roundMoney(row.open_ngn) < roundMoney(row.amount_ngn)) {
      return {
        ok: false,
        error: 'Cannot cancel: company cut from this refund was already withdrawn.',
      };
    }
  }
  db.prepare(
    `UPDATE refund_company_retention_entries
     SET open_ngn = 0, note = COALESCE(note,'') || ' [voided on refund cancel]'
     WHERE entry_type = 'credit' AND refund_id = ?`
  ).run(rid);
  return { ok: true };
}

function branchScopeSql(alias, branchScope) {
  const scope = trim(branchScope);
  if (!scope || scope === 'ALL') return { sql: '', args: [] };
  return { sql: ` AND trim(IFNULL(${alias}.branch_id, '')) = ?`, args: [scope] };
}

/**
 * Withdrawable company-cut balance.
 * An unpaid request reserves its amount (locked) until it is paid or cancelled.
 * During the post-payout cooldown the whole open balance is locked.
 */
export function companyRetentionAvailability({
  totalOpenNgn = 0,
  reservedNgn = 0,
  cooldownActive = false,
  excludedNgn = 0,
  withdrawalFrozen = false,
} = {}) {
  const open = roundMoney(totalOpenNgn);
  const reserved = Math.max(0, roundMoney(reservedNgn));
  const excluded = Math.max(0, roundMoney(excludedNgn));
  const base = Math.max(0, open - reserved - excluded);
  const availableNgn = cooldownActive || withdrawalFrozen ? 0 : base;
  const heldNgn = Math.max(0, open - availableNgn);
  return {
    availableNgn,
    heldNgn,
    reservedNgn: Math.min(reserved, open),
    excludedNgn: Math.min(excluded, open),
    withdrawalFrozen: Boolean(withdrawalFrozen),
  };
}

export function mapWithdrawalRow(r) {
  const status = trim(r.status);
  return {
    id: trim(r.id),
    branchId: trim(r.branch_id),
    amountNgn: roundMoney(r.amount_ngn),
    status,
    payeeName: trim(r.payee_name),
    payeeBankName: trim(r.payee_bank_name),
    payeeAccountNo: trim(r.payee_account_no),
    note: trim(r.note),
    requestedByUserId: trim(r.requested_by_user_id),
    requestedByName: trim(r.requested_by_name),
    requestedAtIso: trim(r.requested_at_iso),
    approvedByUserId: trim(r.approved_by_user_id),
    approvedByName: trim(r.approved_by_name),
    approvedAtIso: trim(r.approved_at_iso),
    approvalNote: trim(r.approval_note),
    cashConfirmedAtIso: trim(r.cash_confirmed_at_iso),
    cashConfirmed: Boolean(trim(r.cash_confirmed_at_iso)),
    rejectedReason: trim(r.rejected_reason),
    cancelledByName: trim(r.cancelled_by_name),
    cancelledAtIso: trim(r.cancelled_at_iso),
    paidAtIso: trim(r.paid_at_iso),
    paidByName: trim(r.paid_by_name),
    treasuryMovementId: trim(r.treasury_movement_id),
    treasuryAccountId: trim(r.treasury_account_id),
    canCancel: status === 'pending_bm' || status === 'approved',
  };
}

/**
 * Last paid company-cut withdrawal for the branch (or any branch when scope is ALL).
 * @returns {{ paidAtIso: string, id: string } | null}
 */
export function getLastPaidCompanyRetentionWithdrawal(db, branchScope = 'ALL') {
  if (!tableExists(db, 'refund_company_retention_withdrawals')) return null;
  const { sql, args } = branchScopeSql('w', branchScope);
  const row = db
    .prepare(
      `SELECT w.id, w.paid_at_iso
       FROM refund_company_retention_withdrawals w
       WHERE w.status = 'paid' AND w.paid_at_iso IS NOT NULL AND trim(w.paid_at_iso) <> ''${sql}
       ORDER BY w.paid_at_iso DESC
       LIMIT 1`
    )
    .get(...args);
  if (!row?.paid_at_iso) return null;
  return { id: trim(row.id), paidAtIso: trim(row.paid_at_iso) };
}

/**
 * When the next withdrawal may be requested given the last paid one.
 * @returns {{ cooldownActive: boolean, nextWithdrawalAllowedAtIso: string | null, lastWithdrawalPaidAtIso: string | null, lastWithdrawalId: string | null }}
 */
export function companyRetentionWithdrawalCooldown(db, branchScope = 'ALL', nowIso = null) {
  const cooldownDays = refundCompanyCutWithdrawalCooldownDays();
  const last = getLastPaidCompanyRetentionWithdrawal(db, branchScope);
  if (!last?.paidAtIso || cooldownDays <= 0) {
    return {
      cooldownDays,
      cooldownActive: false,
      nextWithdrawalAllowedAtIso: null,
      lastWithdrawalPaidAtIso: last?.paidAtIso || null,
      lastWithdrawalId: last?.id || null,
    };
  }
  const nextAt = addDaysIso(last.paidAtIso, cooldownDays);
  const now = trim(nowIso) || new Date().toISOString();
  return {
    cooldownDays,
    cooldownActive: nextAt > now,
    nextWithdrawalAllowedAtIso: nextAt,
    lastWithdrawalPaidAtIso: last.paidAtIso,
    lastWithdrawalId: last.id,
  };
}

export function getCompanyRetentionSummary(db, branchScope = 'ALL', opts = {}) {
  const cooldownDays = refundCompanyCutWithdrawalCooldownDays();
  const tablesReady = refundCompanyRetentionTablesReady(db);
  if (!tablesReady) {
    return {
      ok: true,
      tablesReady: false,
      totalOpenNgn: 0,
      availableNgn: 0,
      heldNgn: 0,
      holdDays: cooldownDays,
      cooldownDays: cooldownDays,
      cooldownActive: false,
      nextWithdrawalAllowedAtIso: null,
      lastWithdrawalPaidAtIso: null,
      reservedNgn: 0,
      paidOutNgn: 0,
      credits: [],
      pendingWithdrawals: [],
      recentWithdrawals: [],
    };
  }
  const { sql, args } = branchScopeSql('e', branchScope);
  const casesByRefund = investigationCaseIdsByRefundId(db);
  const freeze = getRetentionWithdrawalFreeze(db);
  const credits = db
    .prepare(
      `SELECT e.id, e.branch_id, e.amount_ngn, e.open_ngn, e.refund_id, e.source_id,
              e.available_after_iso, e.note, e.created_at_iso
       FROM refund_company_retention_entries e
       WHERE e.entry_type = 'credit' AND e.open_ngn > 0${sql}
       ORDER BY e.created_at_iso ASC`
    )
    .all(...args)
    .map((r) => {
      const openNgn = roundMoney(r.open_ngn);
      const refundId = trim(r.refund_id || r.source_id);
      const investigationCaseIds = casesByRefund.get(refundId) || [];
      return {
        id: r.id,
        branchId: trim(r.branch_id),
        amountNgn: roundMoney(r.amount_ngn),
        openNgn,
        refundId,
        investigationCaseIds,
        excludedFromWithdrawal: investigationCaseIds.length > 0,
        // Legacy column kept; credits are no longer aged — always available re: credit age.
        availableAfterIso: trim(r.available_after_iso) || null,
        available: investigationCaseIds.length === 0 && !freeze.enabled,
        note: trim(r.note),
        createdAtIso: trim(r.created_at_iso),
      };
    });

  const totalOpenNgn = credits.reduce((s, c) => s + c.openNgn, 0);
  const excludedNgn = credits.reduce((s, c) => s + (c.excludedFromWithdrawal ? c.openNgn : 0), 0);
  const cooldown = companyRetentionWithdrawalCooldown(db, branchScope);

  const { sql: wSql, args: wArgs } = branchScopeSql('w', branchScope);
  const pendingWithdrawals = db
    .prepare(
      `SELECT w.*
       FROM refund_company_retention_withdrawals w
       WHERE w.status IN ('pending_bm', 'approved')${wSql}
       ORDER BY w.requested_at_iso DESC
       LIMIT 50`
    )
    .all(...wArgs)
    .map(mapWithdrawalRow);

  const excludeWithdrawalId = trim(opts.excludeWithdrawalId);
  const reservedRaw = pendingWithdrawals
    .filter((w) => !excludeWithdrawalId || w.id !== excludeWithdrawalId)
    .reduce((s, w) => s + w.amountNgn, 0);
  const availability = companyRetentionAvailability({
    totalOpenNgn,
    reservedNgn: reservedRaw,
    cooldownActive: cooldown.cooldownActive,
    excludedNgn,
    withdrawalFrozen: freeze.enabled,
  });

  const recentWithdrawals = db
    .prepare(
      `SELECT w.*
       FROM refund_company_retention_withdrawals w
       WHERE w.status IN ('paid', 'cancelled', 'rejected')${wSql}
       ORDER BY w.requested_at_iso DESC
       LIMIT 20`
    )
    .all(...wArgs)
    .map(mapWithdrawalRow);

  const paidRow = db
    .prepare(
      `SELECT COALESCE(SUM(w.amount_ngn), 0) AS s
       FROM refund_company_retention_withdrawals w
       WHERE w.status = 'paid'${wSql}`
    )
    .get(...wArgs);

  return {
    ok: true,
    tablesReady: true,
    totalOpenNgn,
    availableNgn: availability.availableNgn,
    heldNgn: availability.heldNgn,
    reservedNgn: availability.reservedNgn,
    excludedNgn: availability.excludedNgn,
    withdrawalFrozen: freeze.enabled,
    withdrawalFreezeReason: freeze.reason,
    paidOutNgn: roundMoney(paidRow?.s),
    holdDays: cooldownDays,
    cooldownDays,
    cooldownActive: cooldown.cooldownActive,
    nextWithdrawalAllowedAtIso: cooldown.nextWithdrawalAllowedAtIso,
    lastWithdrawalPaidAtIso: cooldown.lastWithdrawalPaidAtIso,
    credits,
    pendingWithdrawals,
    recentWithdrawals,
  };
}

/**
 * Paid company-cut withdrawals in a report window, with refund allocations when recorded.
 */
export function listPaidCompanyRetentionWithdrawals(db, branchScope = 'ALL', startDate = '', endDate = '') {
  if (!tableExists(db, 'refund_company_retention_withdrawals')) return [];
  const { sql, args } = branchScopeSql('w', branchScope);
  const start = trim(startDate).slice(0, 10);
  const end = trim(endDate).slice(0, 10);
  let dateSql = '';
  const dateArgs = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    dateSql += ` AND SUBSTR(w.paid_at_iso, 1, 10) >= ?`;
    dateArgs.push(start);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    dateSql += ` AND SUBSTR(w.paid_at_iso, 1, 10) <= ?`;
    dateArgs.push(end);
  }
  const rows = db
    .prepare(
      `SELECT w.*
       FROM refund_company_retention_withdrawals w
       WHERE w.status = 'paid'${sql}${dateSql}
       ORDER BY w.paid_at_iso ASC, w.id ASC`
    )
    .all(...args, ...dateArgs);
  if (!rows.length) return [];

  const allocById = new Map();
  if (tableExists(db, 'refund_company_retention_withdrawal_allocations')) {
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => '?').join(', ');
    const allocs = db
      .prepare(
        `SELECT withdrawal_id, refund_id, amount_ngn
         FROM refund_company_retention_withdrawal_allocations
         WHERE withdrawal_id IN (${ph})`
      )
      .all(...ids);
    for (const a of allocs) {
      const key = trim(a.withdrawal_id);
      const list = allocById.get(key) || [];
      list.push({ refundId: trim(a.refund_id), amountNgn: roundMoney(a.amount_ngn) });
      allocById.set(key, list);
    }
  }

  return rows.map((r) => ({
    ...mapWithdrawalRow(r),
    allocations: allocById.get(trim(r.id)) || [],
  }));
}
