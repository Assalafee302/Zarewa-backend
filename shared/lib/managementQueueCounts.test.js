import { describe, expect, it } from 'vitest';
import { getManagementQueueCounts } from './managementQueueCounts.js';

describe('getManagementQueueCounts', () => {
  it('counts Submitted and blank payment requests as pending approval work', () => {
    const counts = getManagementQueueCounts({
      paymentRequests: [
        { approvalStatus: 'Pending' },
        { approvalStatus: 'Submitted' },
        { approvalStatus: '' },
        { approvalStatus: 'Approved', amountRequestedNgn: 10, paidAmountNgn: 0 },
        { approvalStatus: 'Rejected' },
      ],
    });
    expect(counts.pendingExpenses).toBe(3);
  });
});
