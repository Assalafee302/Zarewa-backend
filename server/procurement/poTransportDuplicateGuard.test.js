import { describe, expect, it } from 'vitest';
import {
  matchingLinkedHaulageRequest,
  poTransportDuplicatePaymentBlock,
} from './poTransportDuplicateGuard.js';

const linked = [
  {
    request_id: 'PREQ-KD-26-0328',
    payee_name: 'Bashir Idris',
    amount_requested_ngn: 240_000,
    paid_amount_ngn: 240_000,
    paid_at_iso: '2026-09-07',
  },
  {
    request_id: 'PREQ-KD-26-0329',
    payee_name: 'Bashir Idris',
    amount_requested_ngn: 50_000,
    paid_amount_ngn: 50_000,
    paid_at_iso: '2026-09-19',
  },
];

describe('matchingLinkedHaulageRequest', () => {
  it('blocks the same payee and amount inside 30 days', () => {
    const hit = matchingLinkedHaulageRequest(linked, {
      payeeName: 'bashir   idris',
      amountNgn: 240_000,
      postedDay: '2026-10-01',
    });
    expect(hit?.request_id).toBe('PREQ-KD-26-0328');
  });

  it('allows a different amount or a payment outside 30 days', () => {
    expect(
      matchingLinkedHaulageRequest(linked, {
        payeeName: 'Bashir Idris',
        amountNgn: 10_000,
        postedDay: '2026-10-01',
      })
    ).toBeNull();
    expect(
      matchingLinkedHaulageRequest(linked, {
        payeeName: 'Bashir Idris',
        amountNgn: 240_000,
        postedDay: '2026-11-15',
      })
    ).toBeNull();
  });
});

describe('poTransportDuplicatePaymentBlock', () => {
  it('reads payment requests whose reference is this PO', () => {
    const db = {
      prepare() {
        return {
          all(poId) {
            expect(poId).toBe('PO-KD-26-0085');
            return linked;
          },
        };
      },
    };
    const block = poTransportDuplicatePaymentBlock(db, 'PO-KD-26-0085', {
      payeeName: 'Bashir Idris',
      amountNgn: 50_000,
      postedDay: '2026-10-01',
    });
    expect(block?.code).toBe('PO_TRANSPORT_DUPLICATE_PAYMENT');
    expect(block?.requestId).toBe('PREQ-KD-26-0329');
  });
});
