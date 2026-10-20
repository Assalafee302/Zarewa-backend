/**
 * Finance Phase A (A7): refund staff splits under the threshold (default ₦5,000) are not paid one
 * by one. They wait in a weekly staff-share batch and go out as one payout per staff member per week.
 *
 * A refund's paid cash is allocated to the quote customer first, so a staff share joins the batch
 * once every non-batched payee on that refund has been paid; until then it shows as waiting.
 */

export const STAFF_SHARE_BATCH_DEFAULT_THRESHOLD_NGN = 5000;

function money(n) {
  return Math.max(0, Math.round(Number(n) || 0));
}

export function normalizeStaffShareBatchThresholdNgn(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return STAFF_SHARE_BATCH_DEFAULT_THRESHOLD_NGN;
  return Math.min(n, 1_000_000);
}

/** Staff payee = associated staff (driver / installer) or a claiming-staff customer that is not the quote customer. */
export function refundTargetIsStaff(target, quoteCustomerId) {
  if (!target) return false;
  if (target.partyKind === 'associated_staff') return true;
  const qc = String(quoteCustomerId || '').trim();
  return target.partyKind === 'customer' && Boolean(qc) && String(target.partyId || '').trim() !== qc;
}

/** The staff member's whole net share on this refund is under the threshold. */
export function refundTargetGoesToStaffBatch(target, { quoteCustomerId, thresholdNgn }) {
  const share = money(target?.amountNgn);
  return refundTargetIsStaff(target, quoteCustomerId) && share > 0 && share < money(thresholdNgn);
}

/**
 * @param {Array<{ partyKind: string, partyId: string, partyName?: string, amountNgn: number, owedNgn: number }>} owed
 *   payees still owed cash on one refund (customer first)
 * @returns {{ batched: object[], individual: object[], batchedOwedNgn: number, individualOwedNgn: number, batchReady: boolean }}
 */
export function splitRefundOwedForStaffBatch(owed = [], { quoteCustomerId, thresholdNgn }) {
  const batched = [];
  const individual = [];
  for (const t of owed || []) {
    if (refundTargetGoesToStaffBatch(t, { quoteCustomerId, thresholdNgn })) batched.push(t);
    else individual.push(t);
  }
  const batchedOwedNgn = batched.reduce((s, t) => s + money(t.owedNgn), 0);
  const individualOwedNgn = individual.reduce((s, t) => s + money(t.owedNgn), 0);
  return { batched, individual, batchedOwedNgn, individualOwedNgn, batchReady: individualOwedNgn === 0 };
}

/** Refusal for an individual refund payout that would dip into batched staff shares. */
export function staffShareBatchedRefusal({ refundId, requestedNgn, individualOwedNgn, batchedOwedNgn }) {
  const fmt = (n) => `₦${money(n).toLocaleString('en-NG')}`;
  return {
    ok: false,
    code: 'REFUND_STAFF_SHARE_BATCHED',
    error:
      individualOwedNgn > 0
        ? `Only ${fmt(individualOwedNgn)} can be paid on ${refundId} now. ${fmt(batchedOwedNgn)} of staff shares under the batch threshold goes out in the weekly staff-share batch.`
        : `${refundId}: what is left (${fmt(batchedOwedNgn)}) is staff shares under the batch threshold. Pay it from the weekly staff-share batch.`,
    requestedNgn: money(requestedNgn),
    individualOwedNgn: money(individualOwedNgn),
    batchedOwedNgn: money(batchedOwedNgn),
  };
}

/** Monday (YYYY-MM-DD) of the week containing `dayISO`, Lagos calendar day. */
export function staffShareWeekKey(dayISO) {
  const day = String(dayISO || '').slice(0, 10);
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** Lagos (UTC+1) calendar day for an instant. */
export function lagosDayISO(now = new Date()) {
  return new Date(now.getTime() + 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Group batched shares into one batch per staff member.
 * @param {Array<{ refundId: string, partyKind: string, partyId: string, partyName?: string, owedNgn: number, ready: boolean,
 *   payeeName?: string, payeeBankName?: string, payeeAccountNo?: string }>} lines
 */
export function groupStaffShareBatches(lines = []) {
  const map = new Map();
  for (const line of lines || []) {
    const key = `${line.partyKind}::${line.partyId}`;
    const g =
      map.get(key) ||
      {
        key,
        partyKind: line.partyKind,
        partyId: line.partyId,
        partyName: line.partyName || line.payeeName || line.partyId,
        payeeName: line.payeeName || '',
        payeeBankName: line.payeeBankName || '',
        payeeAccountNo: line.payeeAccountNo || '',
        readyLines: [],
        waitingLines: [],
        readyNgn: 0,
        waitingNgn: 0,
      };
    if (line.ready) {
      g.readyLines.push(line);
      g.readyNgn += money(line.owedNgn);
    } else {
      g.waitingLines.push(line);
      g.waitingNgn += money(line.owedNgn);
    }
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => String(a.partyName).localeCompare(String(b.partyName)));
}
