import { describe, expect, it } from 'vitest';
import { userMayDecideWorkItem } from './workItems.js';

describe('work item payment-request authority', () => {
  it('allows branch manager to approve payment_request work items', () => {
    const allowed = userMayDecideWorkItem(
      { id: 'bm1', roleKey: 'sales_manager', permissions: [] },
      { documentType: 'payment_request', requiresApproval: true, senderUserId: 'staff1' },
      { outcomeStatus: 'approved' }
    );
    expect(allowed).toBe(true);
  });

  it('keeps finance-only queues restricted', () => {
    const blocked = userMayDecideWorkItem(
      { id: 'bm1', roleKey: 'sales_manager', permissions: [] },
      { documentType: 'bank_recon_exceptions', requiresApproval: true, senderUserId: 'staff1' },
      { outcomeStatus: 'approved' }
    );
    expect(blocked).toBe(false);
  });
});
