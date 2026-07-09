import { describe, expect, it } from 'vitest';
import {
  assertQuotationProductionNotBlockedByRefund,
  parseRefundCalculationLinesFromRow,
  validateRefundFinancialGuards,
  validateRefundProductionAlignmentAtPayout,
  quotationHasNonRejectedOrderCancellationRefund,
} from './controlOps.js';

function mockDb(data) {
  return {
    data,
    prepare(sql) {
      const s = String(sql);
      return {
        get(...args) {
          if (s.includes('FROM customer_refunds') && s.includes('reason_category')) {
            const ref = args[0];
            const rows = data.customer_refunds.filter((r) => r.quotation_ref === ref);
            return rows[0] || undefined;
          }
          if (s.includes('COALESCE(SUM(amount_ngn)')) {
            const ref = args[0];
            const rows = data.customer_refunds.filter(
              (r) =>
                r.quotation_ref === ref &&
                !['rejected', 'cancelled'].includes(String(r.status || '').toLowerCase())
            );
            return { s: rows.reduce((sum, r) => sum + (Number(r.amount_ngn) || 0), 0) };
          }
          if (s.includes('FROM quotations WHERE id')) {
            return data.quotations.find((q) => q.id === args[0]);
          }
          if (s.includes('FROM production_jobs')) {
            return data.production_jobs.filter((j) => j.quotation_ref === args[0]);
          }
          if (s.includes('FROM sales_receipts')) return [];
          if (s.includes('FROM ledger_entries')) return { s: 0 };
          return undefined;
        },
        all(...args) {
          if (s.includes('reason_category FROM customer_refunds')) {
            return data.customer_refunds.filter((r) => r.quotation_ref === args[0]);
          }
          if (s.includes('FROM production_jobs')) {
            return data.production_jobs.filter((j) => j.quotation_ref === args[0]);
          }
          if (s.includes('FROM customer_refunds') && s.includes('NOT IN')) {
            return data.customer_refunds.filter((r) => r.quotation_ref === args[0]);
          }
          return [];
        },
      };
    },
  };
}

describe('refundFinancialGuards', () => {
  it('parseRefundCalculationLinesFromRow prefers payload then stored json', () => {
    const row = { calculation_lines_json: JSON.stringify([{ label: 'A', amountNgn: 1000, include: true }]) };
    expect(parseRefundCalculationLinesFromRow(row, [{ label: 'B', amountNgn: 2000 }])).toEqual([
      { label: 'B', amountNgn: 2000 },
    ]);
    expect(parseRefundCalculationLinesFromRow(row, null)[0].amountNgn).toBe(1000);
  });

  it('quotationHasNonRejectedOrderCancellationRefund detects active cancellation refund', () => {
    const db = mockDb({
      customer_refunds: [
        {
          quotation_ref: 'Q1',
          reason_category: JSON.stringify(['Order cancellation']),
          status: 'Pending',
        },
      ],
    });
    expect(quotationHasNonRejectedOrderCancellationRefund(db, 'Q1')).toBe(true);
    expect(assertQuotationProductionNotBlockedByRefund(db, 'Q1').ok).toBe(false);
  });

  it('validateRefundFinancialGuards requires breakdown lines', () => {
    const db = mockDb({ customer_refunds: [], quotations: [], production_jobs: [] });
    const r = validateRefundFinancialGuards(db, {
      quotationRef: 'Q1',
      amountNgn: 5000,
      calculationLines: [],
      phase: 'approve',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUND_BREAKDOWN_REQUIRED');
  });

  it('validateRefundProductionAlignmentAtPayout blocks acknowledge-level issues', () => {
    const db = mockDb({
      quotations: [{ id: 'Q1', lines_json: '{"products":[]}', total_ngn: 100000, paid_ngn: 100000 }],
      production_jobs: [
        { quotation_ref: 'Q1', status: 'completed', planned_meters: 100, actual_meters: 40 },
      ],
      customer_refunds: [],
    });
    const r = validateRefundProductionAlignmentAtPayout(db, 'Q1', ['Order cancellation']);
    expect(r.ok).toBe(false);
  });
});
