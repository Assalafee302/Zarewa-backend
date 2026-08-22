import { describe, it, expect } from 'vitest';
import { permissionsForRole } from '../auth.js';
import {
  remainingCashAfterDraw,
  userMayAccessChairmanOffice,
  drawingsTakenNgn,
  equityCreditBalanceNgn,
} from './chairmanOfficeOps.js';

function chairmanActor() {
  return {
    id: 'USR-CHAIRMAN',
    username: 'chairman',
    displayName: 'Chairman',
    roleKey: 'chairman',
    permissions: permissionsForRole('chairman'),
  };
}

describe('chairmanOfficeOps', () => {
  it('remainingCashAfterDraw subtracts pending and requested amounts', () => {
    expect(remainingCashAfterDraw(5_000_000, 1_000_000, 500_000)).toBe(3_500_000);
  });

  it('drawingsTakenNgn uses debit minus credit', () => {
    expect(drawingsTakenNgn({ debitNgn: 200_000, creditNgn: 0 })).toBe(200_000);
    expect(drawingsTakenNgn({ debitNgn: 0, creditNgn: 10_000 })).toBe(0);
  });

  it('equityCreditBalanceNgn uses credit minus debit', () => {
    expect(equityCreditBalanceNgn({ debitNgn: 0, creditNgn: 8_000_000 })).toBe(8_000_000);
  });

  it('gates Chairman Office to chairman, MD, and admin', () => {
    expect(userMayAccessChairmanOffice(chairmanActor())).toBe(true);
    expect(
      userMayAccessChairmanOffice({
        roleKey: 'md',
        permissions: permissionsForRole('md'),
      })
    ).toBe(true);
    expect(
      userMayAccessChairmanOffice({
        roleKey: 'ceo',
        permissions: permissionsForRole('ceo'),
      })
    ).toBe(false);
    expect(
      userMayAccessChairmanOffice({
        roleKey: 'sales_staff',
        permissions: permissionsForRole('sales_staff'),
      })
    ).toBe(false);
  });
});
