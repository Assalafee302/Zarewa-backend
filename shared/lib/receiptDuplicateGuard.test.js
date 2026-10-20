import { describe, expect, it } from 'vitest';
import { findReceiptDuplicatesWithinWindow, receiptDuplicateRefusal } from './receiptDuplicateGuard.js';

const base = { customerId: 'CUS-1', quotationRef: 'QT-KD-26-1700', cuttingListIds: ['CL-KD-26-900'], amountNgn: 250000 };
const prior = { id: 'RC-KD-26-0100', ...base, atISO: '2026-10-16T10:00:00.000Z' };

describe('receipt duplicate guard (A2)', () => {
  it('blocks same customer + amount + quotation within 24 h', () => {
    const hits = findReceiptDuplicatesWithinWindow({ ...base, atISO: '2026-10-17T09:00:00.000Z' }, [prior]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'RC-KD-26-0100', matchedOn: 'quotation', hoursApart: 23 });
  });

  it('matches on a shared cutting list when the quotation differs', () => {
    const hits = findReceiptDuplicatesWithinWindow(
      { ...base, quotationRef: 'QT-OTHER', atISO: '2026-10-16T12:00:00.000Z' },
      [prior]
    );
    expect(hits[0]?.matchedOn).toBe('cutting_list');
  });

  it('lets through a different amount, a different customer, >24 h apart, or a reversed receipt', () => {
    const at = '2026-10-16T12:00:00.000Z';
    expect(findReceiptDuplicatesWithinWindow({ ...base, amountNgn: 250001, atISO: at }, [prior])).toEqual([]);
    expect(findReceiptDuplicatesWithinWindow({ ...base, customerId: 'CUS-2', atISO: at }, [prior])).toEqual([]);
    expect(findReceiptDuplicatesWithinWindow({ ...base, atISO: '2026-10-17T10:00:01.000Z' }, [prior])).toEqual([]);
    expect(findReceiptDuplicatesWithinWindow({ ...base, atISO: at }, [{ ...prior, reversed: true }])).toEqual([]);
    expect(
      findReceiptDuplicatesWithinWindow({ ...base, quotationRef: 'QT-X', cuttingListIds: [], atISO: at }, [prior])
    ).toEqual([]);
  });

  it('refusal names the earlier receipt and asks for a BM/OM', () => {
    const r = receiptDuplicateRefusal([{ id: 'RC-1', quotationRef: 'QT-1', matchedOn: 'quotation', hoursApart: 2 }], 250000);
    expect(r.code).toBe('RECEIPT_DUPLICATE_24H');
    expect(r.error).toMatch(/RC-1/);
    expect(r.error).toMatch(/Branch Manager or Operations Manager/);
  });

});
