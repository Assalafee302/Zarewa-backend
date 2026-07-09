import { describe, expect, it, vi } from 'vitest';
import { appendAuditLog } from './controlOps.js';
import { recordRefundIntegrityDriftAfterProductionChange } from './quotationRecalcOrchestrator.js';

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
