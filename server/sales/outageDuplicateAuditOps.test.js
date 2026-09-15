import { describe, expect, it } from 'vitest';
import {
  auditDay,
  findTwinReceiptGroupsOnQuote,
  resolveAuditDateWindow,
  severityForAuditFlags,
} from './outageDuplicateAuditOps.js';

describe('outageDuplicateAuditOps helpers', () => {
  it('resolves date window from days when from/to omitted', () => {
    const { fromDate, toDate } = resolveAuditDateWindow({ days: 7, toDate: '2026-09-15' });
    expect(toDate).toBe('2026-09-15');
    expect(fromDate).toBe('2026-09-09');
  });

  it('swaps inverted from/to dates', () => {
    const { fromDate, toDate } = resolveAuditDateWindow({ fromDate: '2026-09-15', toDate: '2026-09-01' });
    expect(fromDate).toBe('2026-09-01');
    expect(toDate).toBe('2026-09-15');
  });

  it('trims audit day to YYYY-MM-DD', () => {
    expect(auditDay('2026-09-10T18:22:00.000Z')).toBe('2026-09-10');
  });

  it('finds same-amount and overlapping-reference twin groups', () => {
    const groups = findTwinReceiptGroupsOnQuote([
      {
        id: 'LE-A',
        amountNgn: 500_000,
        bankReference: 'TRF-99881',
        status: 'Pending clearance',
      },
      {
        id: 'LE-B',
        amountNgn: 500_000,
        bankReference: 'trf99881',
        status: 'Pending clearance',
      },
      {
        id: 'LE-C',
        amountNgn: 120_000,
        bankReference: 'OTHER',
        status: 'Pending clearance',
      },
    ]);
    expect(groups.some((g) => g.code === 'TWIN_AMOUNT_AND_REFERENCE')).toBe(true);
    expect(groups[0].receiptIds).toEqual(['LE-A', 'LE-B']);
  });

  it('ignores reversed receipts when twinning', () => {
    const groups = findTwinReceiptGroupsOnQuote([
      { id: 'LE-A', amountNgn: 100_000, bankReference: 'X', status: 'Pending clearance' },
      { id: 'LE-B', amountNgn: 100_000, bankReference: 'X', status: 'Reversed' },
    ]);
    expect(groups).toEqual([]);
  });

  it('ranks multi production / cutting list as critical', () => {
    expect(severityForAuditFlags(['multi_production_job'])).toBe('critical');
    expect(severityForAuditFlags(['twin_receipt_pending_confirm'])).toBe('high');
    expect(severityForAuditFlags(['multi_receipt'])).toBe('medium');
  });
});
