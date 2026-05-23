import { describe, expect, it } from 'vitest';
import {
  quotationBmPriceExceptionApproved,
  quotationFlaggedForMdPriceReview,
  quotationMdPriceReviewConfirmed,
  quotationRefundBlockedPendingMdPriceConfirm,
} from './quotationPriceException.js';

describe('quotationPriceException', () => {
  it('BM approval allows production gate', () => {
    expect(
      quotationBmPriceExceptionApproved({
        bmPriceExceptionApprovedAtISO: '2026-01-01T00:00:00.000Z',
      })
    ).toBe(true);
  });

  it('flags MD review after BM approve', () => {
    const q = {
      bmPriceExceptionApprovedAtISO: '2026-01-01',
      priceExceptionMdReviewRequired: 1,
    };
    expect(quotationFlaggedForMdPriceReview(q)).toBe(true);
    expect(quotationRefundBlockedPendingMdPriceConfirm(q)).toBe(true);
    expect(quotationMdPriceReviewConfirmed(q)).toBe(false);
  });

  it('MD confirm clears refund block', () => {
    const q = {
      bmPriceExceptionApprovedAtISO: '2026-01-01',
      priceExceptionMdReviewRequired: 1,
      priceExceptionMdConfirmedAtISO: '2026-02-01',
    };
    expect(quotationRefundBlockedPendingMdPriceConfirm(q)).toBe(false);
  });
});
