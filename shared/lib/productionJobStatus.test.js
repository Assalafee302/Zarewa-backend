import { describe, expect, it } from 'vitest';
import {
  CUTTING_LIST_STATUS_CANCELLED,
  PRODUCTION_JOB_OFF_QUEUE_STATUSES_SQL,
  PRODUCTION_JOB_STATUS,
  isActiveProductionQueueStatus,
  isCancelledNotProducedStatus,
  isInactiveProductionJobStatus,
  isProductionClosedForRefundStatus,
  isReturnedToWaitingStatus,
  quotationLineEditBlockedByProductionStatus,
} from './productionJobStatus.js';

describe('productionJobStatus', () => {
  it('treats Planned and Running as the live register queue', () => {
    expect(isActiveProductionQueueStatus(PRODUCTION_JOB_STATUS.PLANNED)).toBe(true);
    expect(isActiveProductionQueueStatus(PRODUCTION_JOB_STATUS.RUNNING)).toBe(true);
    expect(isActiveProductionQueueStatus(PRODUCTION_JOB_STATUS.CANCELLED)).toBe(false);
    expect(isActiveProductionQueueStatus(PRODUCTION_JOB_STATUS.RETURNED)).toBe(false);
  });

  it('keeps cancel (not produced) distinct from return-to-waiting', () => {
    expect(isCancelledNotProducedStatus('Cancelled')).toBe(true);
    expect(isReturnedToWaitingStatus('Returned')).toBe(true);
    expect(isCancelledNotProducedStatus('Returned')).toBe(false);
    expect(isReturnedToWaitingStatus('Cancelled')).toBe(false);
    expect(CUTTING_LIST_STATUS_CANCELLED).toBe('Cancelled');
  });

  it('closes refunds only for completed or cancelled-not-produced jobs', () => {
    expect(isProductionClosedForRefundStatus('Completed')).toBe(true);
    expect(isProductionClosedForRefundStatus('Cancelled')).toBe(true);
    expect(isProductionClosedForRefundStatus('Returned')).toBe(false);
    expect(isProductionClosedForRefundStatus('Planned')).toBe(false);
  });

  it('blocks sales quotation line edits on the register and after cancel, not after return-to-waiting', () => {
    expect(quotationLineEditBlockedByProductionStatus('Planned')).toBe(true);
    expect(quotationLineEditBlockedByProductionStatus('Running')).toBe(true);
    expect(quotationLineEditBlockedByProductionStatus('Cancelled')).toBe(true);
    expect(quotationLineEditBlockedByProductionStatus('Returned')).toBe(false);
    expect(quotationLineEditBlockedByProductionStatus('Completed')).toBe(false);
    expect(isInactiveProductionJobStatus('Returned')).toBe(true);
  });

  it('treats Returned as off the shop-floor queue so later completed jobs can refund', () => {
    expect(PRODUCTION_JOB_OFF_QUEUE_STATUSES_SQL).toContain('returned');
    expect(PRODUCTION_JOB_OFF_QUEUE_STATUSES_SQL).toContain('cancelled');
    expect(PRODUCTION_JOB_OFF_QUEUE_STATUSES_SQL).toContain('completed');
    expect(isActiveProductionQueueStatus('Returned')).toBe(false);
    expect(isProductionClosedForRefundStatus('Returned')).toBe(false);
  });
});
