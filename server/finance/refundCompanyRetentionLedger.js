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

export function mapWithdrawalRow(r) {
  return {
    id: trim(r.id),
    branchId: trim(r.branch_id),
    amountNgn: roundMoney(r.amount_ngn),
    status: trim(r.status),
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

export function getCompanyRetentionSummary(db, branchScope = 'ALL') {
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
      credits: [],
      pendingWithdrawals: [],
    };
  }
  const { sql, args } = branchScopeSql('e', branchScope);
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
      return {
        id: r.id,
        branchId: trim(r.branch_id),
        amountNgn: roundMoney(r.amount_ngn),
        openNgn,
        refundId: trim(r.refund_id || r.source_id),
        // Legacy column kept; credits are no longer aged — always available re: credit age.
        availableAfterIso: trim(r.available_after_iso) || null,
        available: true,
        note: trim(r.note),
        createdAtIso: trim(r.created_at_iso),
      };
    });

  const totalOpenNgn = credits.reduce((s, c) => s + c.openNgn, 0);
  const cooldown = companyRetentionWithdrawalCooldown(db, branchScope);
  // During inter-withdrawal cooldown the open balance is locked (not withdrawable yet).
  const availableNgn = cooldown.cooldownActive ? 0 : totalOpenNgn;
  const heldNgn = Math.max(0, totalOpenNgn - availableNgn);

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

  return {
    ok: true,
    tablesReady: true,
    totalOpenNgn,
    availableNgn,
    heldNgn,
    holdDays: cooldownDays,
    cooldownDays,
    cooldownActive: cooldown.cooldownActive,
    nextWithdrawalAllowedAtIso: cooldown.nextWithdrawalAllowedAtIso,
    lastWithdrawalPaidAtIso: cooldown.lastWithdrawalPaidAtIso,
    credits,
    pendingWithdrawals,
  };
}
