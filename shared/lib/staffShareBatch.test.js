import { describe, expect, it } from 'vitest';
import {
  groupStaffShareBatches,
  normalizeStaffShareBatchThresholdNgn,
  refundTargetGoesToStaffBatch,
  splitRefundOwedForStaffBatch,
  staffShareBatchedRefusal,
  staffShareWeekKey,
} from './staffShareBatch.js';

const opts = { quoteCustomerId: 'CUS-1', thresholdNgn: 5000 };

describe('staff share batch (A7)', () => {
  it('batches staff splits under the threshold only', () => {
    expect(refundTargetGoesToStaffBatch({ partyKind: 'associated_staff', partyId: 'AS-1', amountNgn: 4999 }, opts)).toBe(true);
    expect(refundTargetGoesToStaffBatch({ partyKind: 'associated_staff', partyId: 'AS-1', amountNgn: 5000 }, opts)).toBe(false);
    expect(refundTargetGoesToStaffBatch({ partyKind: 'customer', partyId: 'CUS-STAFF', amountNgn: 3000 }, opts)).toBe(true);
    expect(refundTargetGoesToStaffBatch({ partyKind: 'customer', partyId: 'CUS-1', amountNgn: 3000 }, opts)).toBe(false);
  });

  it('threshold is configurable', () => {
    expect(refundTargetGoesToStaffBatch({ partyKind: 'associated_staff', amountNgn: 7000 }, { ...opts, thresholdNgn: 10000 })).toBe(true);
    expect(normalizeStaffShareBatchThresholdNgn('abc')).toBe(5000);
    expect(normalizeStaffShareBatchThresholdNgn(0)).toBe(0);
  });

  it('splits what is owed on one refund; the batch is ready once the customer is paid', () => {
    const owed = [
      { partyKind: 'customer', partyId: 'CUS-1', amountNgn: 50000, owedNgn: 50000 },
      { partyKind: 'associated_staff', partyId: 'AS-1', amountNgn: 4000, owedNgn: 4000 },
    ];
    const s = splitRefundOwedForStaffBatch(owed, opts);
    expect(s).toMatchObject({ batchedOwedNgn: 4000, individualOwedNgn: 50000, batchReady: false });
    expect(splitRefundOwedForStaffBatch(owed.slice(1), opts).batchReady).toBe(true);
  });

  it('refusal says how much can be paid individually', () => {
    const r = staffShareBatchedRefusal({ refundId: 'RF-1', requestedNgn: 54000, individualOwedNgn: 50000, batchedOwedNgn: 4000 });
    expect(r.code).toBe('REFUND_STAFF_SHARE_BATCHED');
    expect(r.error).toMatch(/Only ₦50,000/);
  });

  it('week key is the Monday of the week', () => {
    expect(staffShareWeekKey('2026-10-17')).toBe('2026-10-12'); // Saturday
    expect(staffShareWeekKey('2026-10-12')).toBe('2026-10-12'); // Monday
    expect(staffShareWeekKey('2026-10-18')).toBe('2026-10-12'); // Sunday
    expect(staffShareWeekKey('x')).toBe('');
  });

  it('groups one batch per staff member', () => {
    const groups = groupStaffShareBatches([
      { refundId: 'RF-1', partyKind: 'associated_staff', partyId: 'AS-1', partyName: 'Ali', owedNgn: 4000, ready: true },
      { refundId: 'RF-2', partyKind: 'associated_staff', partyId: 'AS-1', partyName: 'Ali', owedNgn: 2500, ready: true },
      { refundId: 'RF-3', partyKind: 'associated_staff', partyId: 'AS-1', partyName: 'Ali', owedNgn: 1000, ready: false },
      { refundId: 'RF-4', partyKind: 'associated_staff', partyId: 'AS-2', partyName: 'Bala', owedNgn: 3000, ready: true },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ partyName: 'Ali', readyNgn: 6500, waitingNgn: 1000 });
    expect(groups[0].readyLines).toHaveLength(2);
  });
});
