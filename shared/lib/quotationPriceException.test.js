import { describe, expect, it } from 'vitest';
import {
  quotationBelowFloorExceptionApproved,
  quotationBelowFloorPendingMdApproval,
  quotationBmPriceExceptionApproved,
  quotationHasPaymentForMdBelowFloorQueue,
  quotationRefundBlockedPendingMdPriceConfirm,
} from './quotationPriceException.js';

describe('quotationPriceException', () => {
  it('MD approval satisfies the below-floor gate', () => {
    expect(
      quotationBelowFloorExceptionApproved({
        mdPriceExceptionApprovedAtISO: '2026-01-01T00:00:00.000Z',
      })
    ).toBe(true);
    expect(quotationBmPriceExceptionApproved({ mdPriceExceptionApprovedAtISO: '2026-01-01' })).toBe(true);
  });

  it('legacy MD confirm still satisfies the gate', () => {
    expect(
      quotationBelowFloorExceptionApproved({
        priceExceptionMdConfirmedAtISO: '2026-02-01',
      })
    ).toBe(true);
  });

  it('BM-only approval no longer satisfies the gate', () => {
    expect(
      quotationBelowFloorExceptionApproved({
        bmPriceExceptionApprovedAtISO: '2026-01-01',
        priceExceptionMdReviewRequired: 1,
      })
    ).toBe(false);
  });

  it('flags pending MD when below floor and not approved', () => {
    const q = {
      priceExceptionMdReviewRequired: 1,
    };
    expect(quotationBelowFloorPendingMdApproval(q)).toBe(true);
    expect(quotationRefundBlockedPendingMdPriceConfirm(q)).toBe(true);
  });

  it('treats any posted receipt as paid for the MD below-floor queue', () => {
    expect(quotationHasPaymentForMdBelowFloorQueue(0)).toBe(false);
    expect(quotationHasPaymentForMdBelowFloorQueue(null)).toBe(false);
    expect(quotationHasPaymentForMdBelowFloorQueue({ paidNgn: 0 })).toBe(false);
    expect(quotationHasPaymentForMdBelowFloorQueue(50_000)).toBe(true);
    expect(quotationHasPaymentForMdBelowFloorQueue({ paid_ngn: 1 })).toBe(true);
  });

  it('MD approval clears pending state', () => {
    const q = {
      priceExceptionMdReviewRequired: 1,
      mdPriceExceptionApprovedAtISO: '2026-02-01',
    };
    expect(quotationBelowFloorPendingMdApproval(q)).toBe(false);
    expect(quotationRefundBlockedPendingMdPriceConfirm(q)).toBe(false);
  });
});
