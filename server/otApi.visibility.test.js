import { describe, expect, it } from 'vitest';
import { permissionsForRole } from './auth.js';
import { OT_STATUS } from './otOps.js';
import { otVisibleStatusesForUser, userMayViewOtStatus } from './otApi.js';

function userForRole(roleKey) {
  return {
    id: `U-${roleKey}`,
    roleKey,
    permissions: permissionsForRole(roleKey),
  };
}

describe('otApi visibility gates', () => {
  it('cashier sees only approved_by_bm and paid', () => {
    const cashier = userForRole('cashier');
    expect(otVisibleStatusesForUser(cashier)).toEqual([OT_STATUS.APPROVED, OT_STATUS.PAID]);
    expect(userMayViewOtStatus(cashier, OT_STATUS.APPROVED)).toBe(true);
    expect(userMayViewOtStatus(cashier, OT_STATUS.PAID)).toBe(true);
    expect(userMayViewOtStatus(cashier, OT_STATUS.DRAFT)).toBe(false);
    expect(userMayViewOtStatus(cashier, OT_STATUS.PENDING_BM)).toBe(false);
    expect(userMayViewOtStatus(cashier, OT_STATUS.REJECTED)).toBe(false);
  });

  it('ops and BM may list all branch statuses', () => {
    expect(otVisibleStatusesForUser(userForRole('operations_officer'))).toBeNull();
    expect(otVisibleStatusesForUser(userForRole('sales_manager'))).toBeNull();
    expect(userMayViewOtStatus(userForRole('operations_officer'), OT_STATUS.DRAFT)).toBe(true);
    expect(userMayViewOtStatus(userForRole('sales_manager'), OT_STATUS.PENDING_BM)).toBe(true);
  });

  it('finance_manager has no OT access by default', () => {
    const fm = userForRole('finance_manager');
    expect(otVisibleStatusesForUser(fm)).toEqual([]);
    expect(userMayViewOtStatus(fm, OT_STATUS.APPROVED)).toBe(false);
  });

  it('admin * sees all', () => {
    const admin = userForRole('admin');
    expect(otVisibleStatusesForUser(admin)).toBeNull();
  });
});
