import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

/** Mirrors server/httpApi.js bootstrapPayloadEtag (cheap revision fingerprint). */
function bootstrapPayloadEtag(payload, meta = {}) {
  const mode = meta.mode || payload?.bootstrapMeta?.mode || 'full';
  const fingerprint = {
    kind: 'bootstrap',
    mode,
    revision: meta.revision || '',
    userId: payload?.session?.user?.id ?? '',
    branchScope: payload?.branchScope ?? '',
    workItems: Array.isArray(payload?.unifiedWorkItems) ? payload.unifiedWorkItems.length : 0,
    staffCredit: payload?.staffPurchaseCreditPendingCount ?? 0,
    controls: Array.isArray(payload?.auditLog) ? payload.auditLog.length : 0,
  };
  if (mode === 'full') {
    fingerprint.lens = [
      payload?.customers?.length ?? 0,
      payload?.quotations?.length ?? 0,
      payload?.ledgerEntries?.length ?? 0,
      payload?.receipts?.length ?? 0,
      payload?.productionJobs?.length ?? 0,
      payload?.purchaseOrders?.length ?? 0,
      payload?.expenses?.length ?? 0,
      payload?.treasuryMovements?.length ?? 0,
      payload?.movements?.length ?? 0,
    ];
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('base64url').slice(0, 32);
  return `W/"${hash}"`;
}

describe('bootstrapPayloadEtag', () => {
  it('is stable for the same shell fingerprint and changes when revision changes', () => {
    const a = {
      ok: true,
      bootstrapMeta: { mode: 'shell' },
      session: { user: { id: 1 } },
      branchScope: 'BR-KD',
      unifiedWorkItems: [{ id: 1 }],
      staffPurchaseCreditPendingCount: 0,
    };
    const b = { ...a, unifiedWorkItems: [{ id: 1 }] };
    expect(bootstrapPayloadEtag(a, { revision: 'r1', mode: 'shell' })).toBe(
      bootstrapPayloadEtag(b, { revision: 'r1', mode: 'shell' })
    );
    expect(bootstrapPayloadEtag(a, { revision: 'r1', mode: 'shell' })).not.toBe(
      bootstrapPayloadEtag(a, { revision: 'r2', mode: 'shell' })
    );
  });

  it('full mode changes when major array lengths change', () => {
    const a = { ok: true, customers: [{ id: 'C1' }], quotations: [] };
    const b = { ok: true, customers: [{ id: 'C1' }, { id: 'C2' }], quotations: [] };
    expect(bootstrapPayloadEtag(a, { mode: 'full', revision: 'r1' })).not.toBe(
      bootstrapPayloadEtag(b, { mode: 'full', revision: 'r1' })
    );
  });
});
