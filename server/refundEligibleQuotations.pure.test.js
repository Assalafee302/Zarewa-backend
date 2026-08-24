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
                quotation_ref: 'QT-FAST-1',
                amount_ngn: 120_000,
                ledger_entry_id: null,
                finance_reconciliation_saved_at_iso: null,
                bank_received_amount_ngn: null,
                status: 'Confirmed',
              },
            ];
          }
          if (text.includes('FROM ledger_entries')) return [];
          if (text.includes("type = 'OVERPAY_ADVANCE'")) return [];
          if (text.includes('FROM customer_refunds')) {
            // previewRefundRequest loads prior refunds when the fast path is skipped
            return totalRefunded > 0
              ? [
                  {
                    id: 'RF-1',
                    refund_id: 'RF-1',
                    quotation_ref: 'QT-FAST-1',
                    status: 'Paid',
                    amount_ngn: totalRefunded,
                    paid_amount_ngn: totalRefunded,
                    reason_category: JSON.stringify(['Overpayment']),
                    calculation_lines_json: '[]',
                    credit_applied_ngn: 0,
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

  it('excludes cancelled-job quotes once Order cancellation was already claimed', () => {
    const quote = {
      id: 'QT-CANC-PAID',
      customer_id: 'CUS-1',
      customer_name: 'Cancel Customer',
      date_iso: '2026-08-18',
      total_ngn: 50_000,
      paid_ngn: 50_000,
      status: 'Finished',
      refunds_blocked_at_iso: null,
      total_refunded: 50_000,
      lines_json: JSON.stringify({
        products: [{ name: 'Roofing sheet', qty: 20, unitPrice: 2500 }],
        accessories: [],
        services: [],
      }),
    };
    const job = {
      job_id: 'JOB-CANC-PAID',
      quotation_ref: 'QT-CANC-PAID',
      actual_meters: 0,
      status: 'Cancelled',
    };
    const prior = {
      quotation_ref: 'QT-CANC-PAID',
      refund_id: 'RF-CANC-1',
      status: 'Paid',
      amount_ngn: 50_000,
      paid_amount_ngn: 50_000,
      reason_category: JSON.stringify(['Order cancellation']),
      calculation_lines_json: '[]',
      credit_applied_ngn: 0,
    };
    const db = {
      prepare(sql) {
        const text = String(sql);
        return {
          all() {
            if (text.includes('FROM quotations q')) return [quote];
            if (text.includes('FROM sales_receipts')) {
              return [
                {
                  id: 'RCT-CANC-PAID',
                  quotation_ref: 'QT-CANC-PAID',
                  amount_ngn: 50_000,
                  ledger_entry_id: null,
                  finance_reconciliation_saved_at_iso: null,
                  bank_received_amount_ngn: null,
                  status: 'Confirmed',
                },
              ];
            }
            if (text.includes('FROM customer_refunds') && text.includes('IN (')) return [prior];
            if (text.includes('FROM production_jobs') && text.includes('IN (')) return [job];
            if (text.includes('FROM deliveries')) return [];
            if (text.includes('FROM ledger_entries')) return [];
            if (text.includes('FROM customer_refunds')) return [prior];
            if (text.includes('FROM production_jobs')) return [];
            return [];
          },
          get() {
            if (text.includes('FROM customer_refunds')) return { s: 50_000 };
            if (text.includes('FROM production_job_coils')) return { s: 0 };
            if (text.includes('FROM production_jobs') && text.includes('NOT IN')) return undefined;
            if (text.includes('FROM production_jobs')) return { 1: 1 };
            if (text.includes('FROM ledger_entries')) return { s: 0 };
            if (text.includes('FROM quotations')) return quote;
            return undefined;
          },
        };
      },
    };
    // Remaining headroom is 0 after full refund — excluded by remaining floor.
    expect(
      getEligibleRefundQuotations(db, { candidateLimit: 20, resultLimit: 20 })
    ).toHaveLength(0);
  });

  it('excludes cancelled-job quotes when Order cancellation category is already hard-blocked but cash headroom remains', () => {
    const quote = {
      id: 'QT-CANC-PARTIAL',
      customer_id: 'CUS-1',
      customer_name: 'Cancel Partial',
      date_iso: '2026-08-18',
      total_ngn: 50_000,
      paid_ngn: 50_000,
      status: 'Finished',
      refunds_blocked_at_iso: null,
      total_refunded: 20_000,
      lines_json: JSON.stringify({
        products: [{ name: 'Roofing sheet', qty: 20, unitPrice: 2500 }],
        accessories: [],
        services: [],
      }),
    };
    const job = {
      job_id: 'JOB-CANC-PARTIAL',
      quotation_ref: 'QT-CANC-PARTIAL',
      actual_meters: 0,
      status: 'Cancelled',
    };
    const prior = {
      quotation_ref: 'QT-CANC-PARTIAL',
      refund_id: 'RF-CANC-P1',
      status: 'Paid',
      amount_ngn: 20_000,
      paid_amount_ngn: 20_000,
      reason_category: JSON.stringify(['Order cancellation']),
      calculation_lines_json: '[]',
      credit_applied_ngn: 0,
    };
    const db = {
      prepare(sql) {
        const text = String(sql);
        return {
          all() {
            if (text.includes('FROM quotations q')) return [quote];
            if (text.includes('FROM sales_receipts')) {
              return [
                {
                  id: 'RCT-CANC-PARTIAL',
                  quotation_ref: 'QT-CANC-PARTIAL',
                  amount_ngn: 50_000,
                  ledger_entry_id: null,
                  finance_reconciliation_saved_at_iso: null,
                  bank_received_amount_ngn: null,
                  status: 'Confirmed',
                },
              ];
            }
            if (text.includes('FROM customer_refunds') && text.includes('IN (')) return [prior];
            if (text.includes('FROM production_jobs') && text.includes('IN (')) return [job];
            if (text.includes('FROM deliveries')) return [];
            if (text.includes('FROM ledger_entries')) return [];
            if (text.includes('FROM customer_refunds')) return [prior];
            if (text.includes('FROM production_jobs')) return [];
            return [];
          },
          get() {
            if (text.includes('FROM customer_refunds')) return { s: 20_000 };
            if (text.includes('FROM production_job_coils')) return { s: 0 };
            if (text.includes('FROM production_jobs') && text.includes('NOT IN')) return undefined;
            if (text.includes('FROM production_jobs')) return { 1: 1 };
            if (text.includes('FROM ledger_entries')) return { s: 0 };
            if (text.includes('FROM quotations')) return quote;
            return undefined;
          },
        };
      },
    };
    // Old fast path would re-list Order cancellation for remaining ₦30k; hard-block drops it.
    expect(
      getEligibleRefundQuotations(db, { candidateLimit: 20, resultLimit: 20 })
    ).toHaveLength(0);
  });

  it('lists a finished under-produced quotation without a full preview', () => {
    const quote = {
      id: 'QT-UNPR-1',
      customer_id: 'CUS-1',
      customer_name: 'Unproduced Customer',
      date_iso: '2026-08-18',
      total_ngn: 100_000,
      paid_ngn: 100_000,
      status: 'Finished',
      refunds_blocked_at_iso: null,
      total_refunded: 0,
      lines_json: JSON.stringify({
        products: [{ name: 'Roofing sheet', qty: 50, unitPrice: 2000 }],
        accessories: [],
        services: [],
      }),
    };
    const job = {
      job_id: 'JOB-UNPR-1',
      quotation_ref: 'QT-UNPR-1',
      actual_meters: 20,
      status: 'Completed',
    };
    const db = {
      prepare(sql) {
        const text = String(sql);
        return {
          all() {
            if (text.includes('FROM quotations q')) return [quote];
            if (text.includes('FROM sales_receipts')) {
              return [
                {
                  id: 'RCT-UNPR-1',
                  quotation_ref: 'QT-UNPR-1',
                  amount_ngn: 100_000,
                  ledger_entry_id: null,
                  finance_reconciliation_saved_at_iso: null,
                  bank_received_amount_ngn: null,
                  status: 'Confirmed',
                },
              ];
            }
            if (text.includes('FROM production_jobs') && text.includes('IN (')) return [job];
            if (text.includes('FROM ledger_entries')) return [];
            if (text.includes('FROM customer_refunds')) return [];
            if (text.includes('FROM production_jobs')) return [];
            return [];
          },
          get() {
            if (text.includes('FROM customer_refunds')) return { s: 0 };
            if (text.includes('FROM production_job_coils')) return { s: 0 };
            if (text.includes('FROM production_jobs') && text.includes('NOT IN')) return undefined;
            if (text.includes('FROM production_jobs')) return { 1: 1 };
            if (text.includes('FROM ledger_entries')) return { s: 0 };
            if (text.includes('FROM quotations')) return quote;
            return undefined;
          },
        };
      },
    };

    const rows = getEligibleRefundQuotations(db, {
      candidateLimit: 20,
      resultLimit: 20,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('QT-UNPR-1');
    expect(rows[0].eligible_refund_categories).toEqual(['Unproduced meterage']);
    expect(rows[0].suggested_preview_amount_ngn).toBeGreaterThanOrEqual(1000);
  });
});
