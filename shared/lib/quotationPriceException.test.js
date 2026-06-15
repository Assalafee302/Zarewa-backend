import { describe, expect, it } from 'vitest';
import {
  quotationBelowFloorExceptionApproved,
  quotationBelowFloorPendingMdApproval,
  quotationBmPriceExceptionApproved,
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

  it('MD approval clears pending state', () => {
    const q = {
      priceExceptionMdReviewRequired: 1,
      mdPriceExceptionApprovedAtISO: '2026-02-01',
    };
    expect(quotationBelowFloorPendingMdApproval(q)).toBe(false);
    expect(quotationRefundBlockedPendingMdPriceConfirm(q)).toBe(false);
  });
});
