import { describe, expect, it } from 'vitest';
import {
  canReadTreasuryMovements,
  canSeePaymentRequests,
  canSeeRefundsList,
  canListTreasuryAccounts,
} from './workspaceAccess.js';

describe('workspaceAccess — cashier desk bootstrap visibility', () => {
  const deskOnlyCashier = { roleKey: 'cashier', permissions: ['cashier.desk.view'] };

  it('includes refunds and payment requests for cashier.desk.view only', () => {
    expect(canSeeRefundsList(deskOnlyCashier)).toBe(true);
    expect(canSeePaymentRequests(deskOnlyCashier)).toBe(true);
    expect(canListTreasuryAccounts(deskOnlyCashier)).toBe(true);
    expect(canReadTreasuryMovements(deskOnlyCashier)).toBe(true);
  });

  it('still excludes users with no finance or desk permissions', () => {
    const viewer = { roleKey: 'viewer', permissions: ['dashboard.view'] };
    expect(canSeeRefundsList(viewer)).toBe(false);
    expect(canSeePaymentRequests(viewer)).toBe(false);
  });
});
