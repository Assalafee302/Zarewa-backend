/**
 * Company-cut retention ledger (credits + balances). No controlOps/writeOps imports
 * so partner-wallet approval can credit without circular deps.
 * @module server/finance/refundCompanyRetentionLedger
 */
import { actorId, actorName } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { allocateHumanId } from '../humanId.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';

export const REFUND_COMPANY_CUT_HOLD_DAYS_DEFAULT = 14;

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function trim(v) {
  return String(v ?? '').trim();
}

export function refundCompanyCutHoldDays() {
  const raw = Number(process.env.ZAREWA_REFUND_COMPANY_CUT_HOLD_DAYS);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 365) return Math.round(raw);
  return REFUND_COMPANY_CUT_HOLD_DAYS_DEFAULT;
}

export function refundCompanyRetentionTablesReady(db) {
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
  const holdDays = refundCompanyCutHoldDays();
  const availableAfterIso = addDaysIso(at, holdDays);
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
    entry: { id, amountNgn: amt, availableAfterIso, holdDays },
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
    requestedByName: trim(r.requested_by_name),
    requestedAtIso: trim(r.requested_at_iso),
    approvedByName: trim(r.approved_by_name),
    approvedAtIso: trim(r.approved_at_iso),
    approvalNote: trim(r.approval_note),
    paidAtIso: trim(r.paid_at_iso),
    rejectedReason: trim(r.rejected_reason),
  };
}

export function getCompanyRetentionSummary(db, branchScope = 'ALL') {
  const tablesReady = refundCompanyRetentionTablesReady(db);
  if (!tablesReady) {
    return {
      ok: true,
      tablesReady: false,
      totalOpenNgn: 0,
      availableNgn: 0,
      heldNgn: 0,
      holdDays: refundCompanyCutHoldDays(),
      credits: [],
      pendingWithdrawals: [],
    };
  }
  const now = new Date().toISOString();
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
      const availableAfterIso = trim(r.available_after_iso);
      const available = !availableAfterIso || availableAfterIso <= now;
      return {
        id: r.id,
        branchId: trim(r.branch_id),
        amountNgn: roundMoney(r.amount_ngn),
        openNgn,
        refundId: trim(r.refund_id || r.source_id),
        availableAfterIso,
        available,
        note: trim(r.note),
        createdAtIso: trim(r.created_at_iso),
      };
    });

  const totalOpenNgn = credits.reduce((s, c) => s + c.openNgn, 0);
  const availableNgn = credits.filter((c) => c.available).reduce((s, c) => s + c.openNgn, 0);
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
    holdDays: refundCompanyCutHoldDays(),
    credits,
    pendingWithdrawals,
  };
}
