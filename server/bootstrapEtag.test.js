import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

/** Mirrors server/httpApi.js bootstrapPayloadEtag */
function bootstrapPayloadEtag(payload) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64');
  return `W/"${hash.slice(0, 48)}"`;
}

describe('bootstrapPayloadEtag', () => {
  it('is stable for the same payload and changes when data changes', () => {
    const a = { ok: true, customers: [{ id: 'C1' }] };
    const b = { ok: true, customers: [{ id: 'C1' }] };
    const c = { ok: true, customers: [{ id: 'C2' }] };
    expect(bootstrapPayloadEtag(a)).toBe(bootstrapPayloadEtag(b));
    expect(bootstrapPayloadEtag(a)).not.toBe(bootstrapPayloadEtag(c));
  });
});
