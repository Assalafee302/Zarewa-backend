/**
 * Finance Phase A (A7): weekly staff-share batch for refund staff splits under the threshold,
 * and auto-close of refund remainders of ₦200 or less as "bank fee/rounding".
 * Rules: shared/lib/staffShareBatch.js, shared/lib/payoutRoundingClose.js.
 */
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { actorName } from '../auth.js';
import { appendAuditLog } from '../controlOps.js';
import { payRefundEntry } from '../writeOps.js';
import { payoutRouteBlock, treasuryAccountIsCashOffice } from '../../shared/lib/payoutAccountGuard.js';
import { payoutRemainderOffersRoundingClose } from '../../shared/lib/payoutRoundingClose.js';
import {
  STAFF_SHARE_BATCH_DEFAULT_THRESHOLD_NGN,
  groupStaffShareBatches,
  lagosDayISO,
  normalizeStaffShareBatchThresholdNgn,
  splitRefundOwedForStaffBatch,
  staffShareWeekKey,
} from '../../shared/lib/staffShareBatch.js';
import { payoutLineAccountTypes, refundPayeesAwaitingCash } from './payoutAccountGate.js';
import { refundHasOpenWalletCredit } from './partnerWalletCredit.js';
import { buildRefundSettlementSummary } from '../sales/refundPayoutStatus.js';
import { closeRefundUnpaidRemainder } from '../sales/payoutRoundingCloseOps.js';

export const STAFF_SHARE_BATCH_POLICY_KEY = 'finance.staff_share_batch_threshold_ngn';
export const REFUND_AUTO_ROUNDING_REASON = 'bank fee/rounding';

function clean(v) {
  return String(v ?? '').trim();
}

function money(n) {
  return Math.max(0, Math.round(Number(n) || 0));
}

/** Threshold: env ZAREWA_STAFF_SHARE_BATCH_THRESHOLD_NGN, else org policy, else ₦5,000. */
export function getStaffShareBatchThresholdNgn(db) {
  const env = clean(process.env.ZAREWA_STAFF_SHARE_BATCH_THRESHOLD_NGN);
  if (env) return normalizeStaffShareBatchThresholdNgn(env);
  try {
    const row = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(STAFF_SHARE_BATCH_POLICY_KEY);
    if (row?.value_json != null) return normalizeStaffShareBatchThresholdNgn(JSON.parse(row.value_json));
  } catch {
    /* policy table missing on a partial host */
  }
  return STAFF_SHARE_BATCH_DEFAULT_THRESHOLD_NGN;
}

export function setStaffShareBatchThresholdNgn(db, value, actor) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'Threshold must be a whole naira amount, 0 or more.' };
  const next = normalizeStaffShareBatchThresholdNgn(n);
  const before = getStaffShareBatchThresholdNgn(db);
  const t = new Date().toISOString();
  db.prepare(
    `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
     VALUES (?,?,?,?,?)
     ON CONFLICT(policy_key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at_iso = excluded.updated_at_iso,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_by_display = excluded.updated_by_display`
  ).run(STAFF_SHARE_BATCH_POLICY_KEY, JSON.stringify(next), t, actor?.id ?? null, actorName(actor) || null);
  appendAuditLog(db, {
    actor,
    action: 'finance.staff_share_batch_threshold',
    entityKind: 'org_policy',
    entityId: STAFF_SHARE_BATCH_POLICY_KEY,
    note: `Staff-share batch threshold ₦${before.toLocaleString('en-NG')} → ₦${next.toLocaleString('en-NG')}`,
    details: { before, after: next },
  });
  return { ok: true, thresholdNgn: next };
}

/**
 * Which part of a refund's remaining cash belongs to the weekly staff batch.
 * Refunds on a partner wallet are left alone (the wallet already pays per party).
 */
export function refundStaffBatchState(db, refundRow, thresholdNgn = getStaffShareBatchThresholdNgn(db)) {
  const refundId = clean(refundRow?.refund_id);
  const owed = refundPayeesAwaitingCash(db, refundRow);
  const none = { batched: [], individual: owed, batchedOwedNgn: 0, individualOwedNgn: owed.reduce((s, t) => s + money(t.owedNgn), 0), batchReady: false };
  if (!refundId || thresholdNgn <= 0 || refundHasOpenWalletCredit(db, refundId)) return none;
  return splitRefundOwedForStaffBatch(owed, { quoteCustomerId: clean(refundRow.customer_id), thresholdNgn });
}

function openRefundRows(db, branchScope) {
  const scoped = branchScope && branchScope !== 'ALL';
  return db
    .prepare(
      `SELECT * FROM customer_refunds
       WHERE status IN ('Approved', 'Partially paid')${scoped ? ' AND branch_id = ?' : ''}
       ORDER BY approval_date ASC, refund_id ASC`
    )
    .all(...(scoped ? [branchScope] : []));
}

function paidThisWeek(db, weekKey, branchId, partyKind, partyId) {
  try {
    return db
      .prepare(
        `SELECT id, total_ngn, paid_at_iso, paid_by_name FROM staff_share_payouts
         WHERE week_key = ? AND branch_id = ? AND party_kind = ? AND party_id = ?`
      )
      .get(weekKey, branchId, partyKind, partyId) || null;
  } catch {
    return null;
  }
}

/** Current week's batches for a branch: one row per staff member with ready and waiting shares. */
export function listStaffShareBatches(db, branchScope = 'ALL', { now = new Date() } = {}) {
  const thresholdNgn = getStaffShareBatchThresholdNgn(db);
  const weekKey = staffShareWeekKey(lagosDayISO(now));
  const lines = [];
  for (const row of openRefundRows(db, branchScope)) {
    const state = refundStaffBatchState(db, row, thresholdNgn);
    for (const t of state.batched) {
      lines.push({
        refundId: clean(row.refund_id),
        branchId: clean(row.branch_id) || DEFAULT_BRANCH_ID,
        partyKind: t.partyKind,
        partyId: clean(t.partyId),
        partyName: t.partyName,
        payeeName: t.payeeName,
        payeeBankName: t.payeeBankName,
        payeeAccountNo: t.payeeAccountNo,
        owedNgn: money(t.owedNgn),
        ready: state.batchReady,
      });
    }
  }
  const batches = groupStaffShareBatches(lines).map((g) => {
    const branchId = g.readyLines[0]?.branchId || g.waitingLines[0]?.branchId || DEFAULT_BRANCH_ID;
    const paid = paidThisWeek(db, weekKey, branchId, g.partyKind, g.partyId);
    return { ...g, branchId, weekKey, paidThisWeek: paid };
  });
  return { ok: true, weekKey, thresholdNgn, batches, lines };
}

/**
 * One payout per staff member per week: pays every ready share in the batch, each posted as a
 * REFUND_PAYOUT line on its own refund under one batch reference.
 */
export function payStaffShareBatch(db, payload = {}, actor = null) {
  const partyKind = clean(payload.partyKind);
  const partyId = clean(payload.partyId);
  const treasuryAccountId = Number(payload.treasuryAccountId);
  if (!partyKind || !partyId) return { ok: false, error: 'Say which staff member to pay.' };
  if (!treasuryAccountId) return { ok: false, error: 'Choose the treasury account the batch is paid from.' };
  const listing = listStaffShareBatches(db, payload.branchScope || 'ALL', { now: payload.now || new Date() });
  const batch = listing.batches.find((b) => b.partyKind === partyKind && clean(b.partyId) === partyId);
  if (!batch || !batch.readyLines.length) {
    return { ok: false, code: 'STAFF_SHARE_BATCH_EMPTY', error: 'No staff shares are ready to pay for this person.' };
  }
  if (batch.paidThisWeek) {
    return {
      ok: false,
      code: 'STAFF_SHARE_BATCH_ALREADY_PAID',
      error: `${batch.partyName} was already paid this week's staff-share batch (${batch.paidThisWeek.id}). New shares go in next week's batch.`,
    };
  }
  // D2: from a bank / POS account the staff account is required; from the Cash Office, name + voucher.
  const [accountType] = payoutLineAccountTypes(db, [{ treasuryAccountId }]);
  const cashOffice = treasuryAccountIsCashOffice(accountType);
  const cash = {
    recipientName: clean(payload.cashRecipientName) || batch.partyName,
    voucherReference: clean(payload.voucherReference),
  };
  const accountBlock = payoutRouteBlock({
    accountTypes: [accountType || 'Bank'],
    cash,
    payees: [{ label: batch.partyName, bankName: batch.payeeBankName, accountNo: batch.payeeAccountNo }],
  });
  if (accountBlock) return accountBlock;

  const payoutId = `SSB-${batch.branchId}-${listing.weekKey}-${partyId}`;
  const reference = (cashOffice ? cash.voucherReference : clean(payload.reference)) || payoutId;
  const paid = [];
  const failed = [];
  for (const line of batch.readyLines) {
    const r = payRefundEntry(db, line.refundId, {
      paymentLines: [
        {
          treasuryAccountId,
          amountNgn: line.owedNgn,
          reference,
          note: cashOffice
            ? `Cash Office — paid to ${cash.recipientName}, voucher ${cash.voucherReference} · Weekly staff-share batch ${payoutId}`
            : `Weekly staff-share batch ${payoutId}`,
          ...(payload.dateISO ? { dateISO: payload.dateISO } : {}),
        },
      ],
      paidAtISO: payload.dateISO,
      paymentNote: `Weekly staff-share batch ${payoutId} (${batch.partyName})`,
      payeeName: batch.payeeName || batch.partyName,
      payeeCustomerId: partyKind === 'customer' ? partyId : undefined,
      reference,
      paidBy: actorName(actor) || 'Finance',
      actor,
      workspaceBranchId: payload.workspaceBranchId,
      workspaceViewAll: Boolean(payload.workspaceViewAll),
    });
    if (r.ok) paid.push({ refundId: line.refundId, amountNgn: line.owedNgn });
    else {
      failed.push({ refundId: line.refundId, amountNgn: line.owedNgn, error: r.error || 'Payout failed.' });
      break;
    }
  }
  const totalNgn = paid.reduce((s, l) => s + l.amountNgn, 0);
  if (paid.length) {
    db.prepare(
      `INSERT INTO staff_share_payouts
         (id, week_key, branch_id, party_kind, party_id, party_name, total_ngn, lines_json,
          treasury_account_id, reference, paid_at_iso, paid_by_user_id, paid_by_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      payoutId,
      listing.weekKey,
      batch.branchId,
      partyKind,
      partyId,
      batch.partyName,
      totalNgn,
      JSON.stringify(paid),
      treasuryAccountId,
      reference,
      new Date().toISOString(),
      actor?.id ?? null,
      actorName(actor) || null
    );
    appendAuditLog(db, {
      actor,
      action: 'refund.staff_share_batch_pay',
      entityKind: 'staff_share_payout',
      entityId: payoutId,
      note: `Weekly staff-share batch to ${batch.partyName}: ₦${totalNgn.toLocaleString('en-NG')} over ${paid.length} refund${paid.length === 1 ? '' : 's'}`,
      details: { weekKey: listing.weekKey, partyKind, partyId, paid, failed, treasuryAccountId, reference },
    });
  }
  if (failed.length) {
    return {
      ok: false,
      code: 'STAFF_SHARE_BATCH_PARTIAL',
      error: `Stopped at ${failed[0].refundId}: ${failed[0].error}${paid.length ? ` (${paid.length} share${paid.length === 1 ? '' : 's'} paid, ₦${totalNgn.toLocaleString('en-NG')})` : ''}`,
      payoutId: paid.length ? payoutId : null,
      paid,
      failed,
    };
  }
  return { ok: true, payoutId, weekKey: listing.weekKey, totalNgn, paid };
}

/**
 * A7: after a refund payout, a remainder of ₦200 or less closes as rounding with reason
 * "bank fee/rounding" (audited, no cash moves). Remainders that sit in the staff batch are left alone.
 */
export function autoCloseRefundRoundingRemainder(db, refundId, actor = null) {
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(clean(refundId));
  if (!row) return { ok: true, skipped: 'not_found' };
  const outstanding = money(buildRefundSettlementSummary(db, row).cashOutstandingNgn);
  if (!payoutRemainderOffersRoundingClose(outstanding)) return { ok: true, skipped: 'not_rounding', outstandingNgn: outstanding };
  const state = refundStaffBatchState(db, row);
  if (state.batchedOwedNgn > 0) return { ok: true, skipped: 'staff_batch', outstandingNgn: outstanding };
  return closeRefundUnpaidRemainder(db, refundId, actor, 'rounding', { note: REFUND_AUTO_ROUNDING_REASON, auto: true });
}
