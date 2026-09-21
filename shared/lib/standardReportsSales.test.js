import { describe, expect, it } from 'vitest';
import {
  receiptsRegisterReportRows,
  refundCreditApplyReportRows,
  salesBridgeReportRows,
  treasuryAccountLabelByLedgerEntryId,
} from './standardReportsSales.js';

describe('treasuryAccountLabelByLedgerEntryId', () => {
  it('falls back to the account name when no bank name is on record', () => {
    const m = treasuryAccountLabelByLedgerEntryId([
      { sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE-1', accountName: 'Zenith Ops', accountNo: '001' },
    ]);
    expect(m.get('LE-1')).toContain('Zenith');
  });

  it('prefers the bank short code over the internal account name', () => {
    const m = treasuryAccountLabelByLedgerEntryId([
      {
        sourceKind: 'LEDGER_RECEIPT',
        sourceId: 'LE-2',
        accountName: 'Zarewa Ops Account',
        accountNo: '0123456789',
        bankName: 'Guaranty Trust Bank',
      },
    ]);
    expect(m.get('LE-2')).toBe('GTB · 0123456789');
  });
});

describe('receiptsRegisterReportRows', () => {
  it('filters by receipt date', () => {
    const rows = receiptsRegisterReportRows(
      [
        {
          id: 'RC-1',
          dateISO: '2026-03-15',
          customer: 'A',
          amountNgn: 100,
          quotationRef: 'QT-2026-001',
          ledgerEntryId: 'LE-9',
          method: 'Bank',
        },
        { id: 'RC-2', dateISO: '2025-01-01', customer: 'B', amountNgn: 50, quotationRef: 'QT-2', method: 'Cash' },
      ],
      [{ id: 'LE-9', bankReference: 'BR9', paymentMethod: 'Transfer' }],
      [{ sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE-9', accountName: 'GTB', accountNo: 'X' }],
      '2026-03-01',
      '2026-03-31'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].quotationRefDisplay).toBe('2026-001');
    expect(rows[0].bankPaidTo).toContain('GTB');
    expect(rows[0].fundSource).toBe('Bank/Cash');
  });

  it('marks receipts confirmed with refund fund', () => {
    const rows = receiptsRegisterReportRows(
      [
        {
          id: 'RC-CREDIT',
          dateISO: '2026-03-15',
          customer: 'A',
          amountNgn: 0,
          bankReceivedAmountNgn: 0,
          quotationRef: 'QT-2026-002',
          method: 'Bank',
        },
      ],
      [],
      [],
      '2026-03-01',
      '2026-03-31',
      [
        {
          applicationId: 'RCA-1',
          sourceReceiptId: 'RC-CREDIT',
          refundId: 'RF-2026-100',
          amountNgn: 25_000,
          status: 'Credit confirmation',
        },
      ]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].fundSource).toBe('Refund credit');
    expect(rows[0].paymentMethod).toBe('Refund credit');
    expect(rows[0].refundCreditAppliedNgn).toBe(25_000);
    expect(rows[0].fundNote).toMatch(/25,000/);
    expect(rows[0].refundCreditFromRefundIds).toContain('RF-2026-100');
  });
});

describe('refundCreditApplyReportRows', () => {
  it('lists refund-fund applies in period for audit', () => {
    const rows = refundCreditApplyReportRows(
      [
        {
          applicationId: 'RCA-9',
          createdAtISO: '2026-03-20T12:00:00.000Z',
          amountNgn: 12_000,
          refundId: 'RF-9',
          targetQuotationRef: 'QT-2026-050',
          sourceQuotationRef: 'QT-2026-010',
          status: 'Credit confirmation',
        },
        {
          applicationId: 'RCA-OLD',
          createdAtISO: '2025-01-01T12:00:00.000Z',
          amountNgn: 9_000,
          refundId: 'RF-OLD',
          targetQuotationRef: 'QT-OLD',
          status: 'Credit confirmation',
        },
      ],
      '2026-03-01',
      '2026-03-31'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].paymentMethod).toBe('Refund credit');
    expect(rows[0].amountNgn).toBe(12_000);
    expect(rows[0].fundNote).toMatch(/from refund/);
  });
});

describe('salesBridgeReportRows', () => {
  it('tags not produced when no completed job', () => {
    const rows = salesBridgeReportRows(
      [{ dateISO: '2026-02-10', customer: 'C', amountNgn: 1, quotationRef: 'QT-2026-099' }],
      [],
      '2026-02-01',
      '2026-02-28',
      '2026-02-28'
    );
    expect(rows[0].bridgeCategory).toBe('Not_produced_by_period_end');
  });
});
