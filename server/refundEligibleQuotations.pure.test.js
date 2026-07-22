import { describe, expect, it } from 'vitest';
import { getEligibleRefundQuotations } from './controlOps.js';

function overpaymentDb({ totalRefunded = 0 } = {}) {
  const quote = {
    id: 'QT-FAST-1',
    customer_id: 'CUS-1',
    customer_name: 'Fast Customer',
    date_iso: '2026-07-18',
    total_ngn: 100_000,
    paid_ngn: 120_000,
    status: 'Finished',
    refunds_blocked_at_iso: null,
    total_refunded: totalRefunded,
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
          if (text.includes('FROM customer_refunds')) {
            // previewRefundRequest loads prior refunds when the fast path is skipped
            return totalRefunded > 0
              ? [
                  {
                    id: 'RF-1',
                    status: 'Paid',
                    amount_ngn: totalRefunded,
                    reason_category: JSON.stringify(['Overpayment']),
                  },
                ]
              : [];
          }
          if (text.includes('FROM production_jobs')) return [];
          return [];
        },
        get() {
          if (text.includes('FROM customer_refunds') && text.includes('SUM')) {
            return { s: totalRefunded };
          }
          if (text.includes('FROM customer_refunds')) return { s: totalRefunded };
          if (text.includes('FROM production_jobs') && text.includes('NOT IN')) return undefined;
          if (text.includes('FROM production_jobs')) return { 1: 1 };
          if (text.includes('FROM ledger_entries')) return { s: 0 };
          if (text.includes('FROM quotations')) return quote;
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

  it('does not keep an already-refunded overpayment on the pick list via the fast path', () => {
    // cash − quote total still looks like ₦20k overpay, but Overpayment was already refunded.
    // Fast path must not re-list it; without other categories the quote drops out.
    const rows = getEligibleRefundQuotations(overpaymentDb({ totalRefunded: 20_000 }), {
      candidateLimit: 20,
      resultLimit: 20,
    });

    expect(rows).toHaveLength(0);
  });
});
