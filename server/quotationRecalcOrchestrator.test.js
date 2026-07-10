import { describe, expect, it, vi } from 'vitest';
import { appendAuditLog } from './controlOps.js';
import {
  listStaleOpenRefundsForQuotation,
  recordRefundIntegrityDriftAfterProductionChange,
} from './quotationRecalcOrchestrator.js';

vi.mock('./controlOps.js', () => ({
  appendAuditLog: vi.fn(),
  previewRefundRequest: vi.fn(() => ({
    ok: true,
    preview: {
      economicFloor: { maxDefensibleRefundNgn: 50_000 },
    },
  })),
}));

vi.mock('./writeOps.js', () => ({
  reconcileSalesReceiptMirrorsForQuotation: vi.fn(),
}));

describe('quotationRecalcOrchestrator drift', () => {
  it('records audit when open refunds exceed economic floor', () => {
    const db = {
      prepare(sql) {
        const s = String(sql);
        return {
          get: () => undefined,
          all: () =>
            s.includes('customer_refunds')
              ? [{ refund_id: 'R1', status: 'Pending', amount_ngn: 80_000, reason_category: '[]' }]
              : [],
        };
      },
    };
    const r = recordRefundIntegrityDriftAfterProductionChange(db, 'Q1', {
      actor: { id: 'u1' },
      trigger: 'production.complete.coil',
      jobId: 'PJ-1',
    });
    expect(r.drift).toBe(true);
    expect(r.staleRefundWarnings).toHaveLength(1);
    expect(appendAuditLog).toHaveBeenCalled();
  });
});

describe('listStaleOpenRefundsForQuotation', () => {
  it('does not flag a pending refund that fits when excluding itself from prior refunded', () => {
    // cash 1_864_650 − floor 1_693_440 = 171_210 headroom; pending request is exactly that amount.
    const rows = [
      {
        refund_id: 'RF-KD-26-9239',
        status: 'Pending',
        amount_ngn: 171_210,
        reason_category: '["Overpayment","Unproduced meterage"]',
      },
      {
        refund_id: 'RF-KD-26-9237',
        status: 'Rejected',
        amount_ngn: 1_060_170,
        reason_category: '["Order cancellation"]',
      },
    ];
    const db = {
      prepare(sql) {
        const s = String(sql);
        return {
          all: () => {
            if (s.includes("IN ('pending', 'approved')")) {
              return rows.filter((r) => ['pending', 'approved'].includes(String(r.status).toLowerCase()));
            }
            if (s.includes("NOT IN ('rejected', 'cancelled')")) {
              return rows
                .filter((r) => !['rejected', 'cancelled'].includes(String(r.status).toLowerCase()))
                .map((r) => ({ refund_id: r.refund_id, amount_ngn: r.amount_ngn }));
            }
            return [];
          },
        };
      },
    };
    const stale = listStaleOpenRefundsForQuotation(db, 'QT-KD-26-0794', {
      cashInNgn: 1_864_650,
      floorDeliveredValueNgn: 1_693_440,
      priorRefundedNgn: 171_210,
      maxDefensibleRefundNgn: 0, // naive self-inclusive cap — must not drive the per-refund check
    });
    expect(stale).toEqual([]);
  });

  it('flags a pending refund that exceeds headroom after other active refunds', () => {
    const rows = [
      { refund_id: 'RF-A', status: 'Pending', amount_ngn: 100_000, reason_category: '[]' },
      { refund_id: 'RF-B', status: 'Approved', amount_ngn: 80_000, reason_category: '[]' },
    ];
    const db = {
      prepare(sql) {
        const s = String(sql);
        return {
          all: () => {
            if (s.includes("IN ('pending', 'approved')")) return rows;
            if (s.includes("NOT IN ('rejected', 'cancelled')")) {
              return rows.map((r) => ({ refund_id: r.refund_id, amount_ngn: r.amount_ngn }));
            }
            return [];
          },
        };
      },
    };
    // cash − floor = 150_000; RF-A alone has only 70_000 after RF-B.
    const stale = listStaleOpenRefundsForQuotation(db, 'Q1', {
      cashInNgn: 250_000,
      floorDeliveredValueNgn: 100_000,
      priorRefundedNgn: 180_000,
      maxDefensibleRefundNgn: 0,
    });
    expect(stale.map((s) => s.refundId)).toContain('RF-A');
    expect(stale.find((s) => s.refundId === 'RF-A')?.maxDefensibleRefundNgn).toBe(70_000);
  });
});
