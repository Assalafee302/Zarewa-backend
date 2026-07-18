import { describe, expect, it } from 'vitest';
import { getEligibleRefundQuotations } from './controlOps.js';

function overpaymentDb() {
  const quote = {
    id: 'QT-FAST-1',
    customer_id: 'CUS-1',
    customer_name: 'Fast Customer',
    date_iso: '2026-07-18',
    total_ngn: 100_000,
    paid_ngn: 120_000,
    status: 'Finished',
    refunds_blocked_at_iso: null,
    total_refunded: 0,
  };

  return {
    prepare(sql) {
      const text = String(sql);
      return {
        all() {
          if (text.includes('FROM quotations q')) return [quote];
          if (text.includes('FROM sales_receipts')) {
            return [
              {
                id: 'RCT-1',
                amount_ngn: 120_000,
                ledger_entry_id: null,
                finance_reconciliation_saved_at_iso: null,
                bank_received_amount_ngn: null,
                status: 'Confirmed',
              },
            ];
          }
          if (text.includes('SELECT * FROM ledger_entries')) return [];
          if (text.includes("type = 'OVERPAY_ADVANCE'")) return [];
          return [];
        },
        get() {
          if (text.includes('FROM customer_refunds')) return { s: 0 };
          if (text.includes('FROM production_jobs') && text.includes('NOT IN')) return undefined;
          if (text.includes('FROM production_jobs')) return { 1: 1 };
          if (text.includes('FROM ledger_entries')) return { s: 0 };
          return undefined;
        },
      };
    },
  };
}

describe('getEligibleRefundQuotations fast list', () => {
  it('lists an obvious overpayment without running a full preview', () => {
    const rows = getEligibleRefundQuotations(overpaymentDb(), {
      candidateLimit: 20,
      resultLimit: 20,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].eligible_refund_categories).toEqual(['Overpayment']);
    expect(rows[0].suggested_preview_amount_ngn).toBe(20_000);
    expect(rows[0].remaining_ngn).toBe(120_000);
  });
});
