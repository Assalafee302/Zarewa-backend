import { describe, expect, it } from 'vitest';
import {
  actorConflictsWithTouches,
  casesPastReviewDate,
  investigationCaseFreezes,
  investigationCasesToCsv,
  investigationHoldMessage,
  investigationMoneySummary,
  investigationTotals,
  isInvestigationOpenStatus,
  openSuspenseExpectedNgn,
  userMayManageInvestigations,
  userMayViewInvestigationCase,
  userMayWriteOffInvestigation,
} from './investigationRegister.js';

describe('investigation register rules', () => {
  it('allows only MD, Head of Accounts, and Operations Manager', () => {
    expect(userMayManageInvestigations({ roleKey: 'md' })).toBe(true);
    expect(userMayManageInvestigations({ roleKey: 'head_of_accounts' })).toBe(true);
    expect(userMayManageInvestigations({ roleKey: 'operations_manager' })).toBe(true);
    expect(userMayManageInvestigations({ roleKey: 'finance_manager', jobTitle: 'Head of Accounts' })).toBe(true);
    expect(userMayManageInvestigations({ roleKey: 'cashier' })).toBe(false);
    expect(userMayManageInvestigations({ roleKey: 'sales_manager' })).toBe(false);
    expect(userMayManageInvestigations({ roleKey: 'finance_manager' })).toBe(false);
    expect(userMayManageInvestigations({ permissions: ['investigation.manage'] })).toBe(true);
  });

  it('write-off is MD only', () => {
    expect(userMayWriteOffInvestigation({ roleKey: 'md' })).toBe(true);
    expect(userMayWriteOffInvestigation({ roleKey: 'operations_manager' })).toBe(false);
    expect(userMayWriteOffInvestigation({ roleKey: 'head_of_accounts' })).toBe(false);
    expect(userMayWriteOffInvestigation({ permissions: ['*'] })).toBe(true);
  });

  it('suspense expected is suspended minus recovered on open cases only', () => {
    const cases = [
      { status: 'open', suspendedNgn: 1_000_000, recoveredNgn: 0, amountAtRiskNgn: 2_115_600 },
      { status: 'under_review', suspendedNgn: 264_420, recoveredNgn: 10_000, amountAtRiskNgn: 264_420 },
      { status: 'open', suspendedNgn: 0, recoveredNgn: 0, amountAtRiskNgn: 625_472 },
      { status: 'cleared', suspendedNgn: 50_000, recoveredNgn: 0, amountAtRiskNgn: 50_000 },
    ];
    expect(openSuspenseExpectedNgn(cases)).toBe(1_254_420);
    expect(investigationTotals(cases).openCases).toBe(3);
    expect(investigationTotals(cases).amountAtRiskNgn).toBe(2_115_600 + 264_420 + 625_472);
  });

  it('lists cases past the review date', () => {
    const late = casesPastReviewDate(
      [
        { status: 'open', reviewDate: '2026-10-17' },
        { status: 'open', reviewDate: '2026-10-20' },
        { status: 'cleared', reviewDate: '2026-10-01' },
      ],
      '2026-10-18'
    );
    expect(late).toHaveLength(1);
    expect(late[0].reviewDate).toBe('2026-10-17');
  });

  it('exports csv', () => {
    const csv = investigationCasesToCsv([
      {
        id: 'INV-KD-26-0001',
        title: 'Yusuf, "unbacked"',
        caseType: 'unbacked_receipt',
        status: 'open',
        amountAtRiskNgn: 100,
        recoveredNgn: 0,
        suspendedNgn: 100,
        ownerUserId: 'USR-1',
        reviewDate: '2026-10-17',
        branchId: 'BR-KD',
      },
    ]);
    expect(csv.split('\n')[0]).toContain('amount_at_risk_ngn');
    expect(csv).toContain('"Yusuf, ""unbacked"""');
  });

  it('freezes an open platform case until the MD lifts the hold', () => {
    expect(isInvestigationOpenStatus('Open')).toBe(true);
    expect(isInvestigationOpenStatus('Reported')).toBe(false);
    expect(isInvestigationOpenStatus('Closed')).toBe(false);
    expect(investigationCaseFreezes('Open', 1)).toBe(true);
    expect(investigationCaseFreezes('Open', 0)).toBe(false);
    expect(investigationCaseFreezes('open', null)).toBe(true);
    expect(investigationHoldMessage('INV-KD-26-0001')).toBe('Under investigation: INV-KD-26-0001');
  });

  it('hides a case from anyone who is not the MD, the case officer, or a member', () => {
    const access = { caseOfficerUserId: 'USR-OM', ownerUserId: '', memberUserIds: ['USR-CASH'] };
    expect(userMayViewInvestigationCase({ id: 'USR-MD', roleKey: 'md' }, access)).toBe(true);
    expect(userMayViewInvestigationCase({ id: 'USR-OM', roleKey: 'operations_manager' }, access)).toBe(true);
    expect(userMayViewInvestigationCase({ id: 'USR-CASH', roleKey: 'cashier' }, access)).toBe(true);
    expect(userMayViewInvestigationCase({ id: 'USR-SALES', roleKey: 'sales' }, access)).toBe(false);
  });

  it('treats a name or user id on a linked record as a conflict', () => {
    const touches = [
      { userId: 'USR-BM', name: 'Aminu Bello', field: 'approved_by' },
      { name: 'Front Desk', field: 'created_by' },
    ];
    expect(actorConflictsWithTouches({ id: 'USR-BM', displayName: 'Someone Else' }, touches)?.field).toBe(
      'approved_by'
    );
    expect(actorConflictsWithTouches({ id: 'USR-OM', displayName: 'Aminu Bello' }, touches)?.field).toBe(
      'approved_by'
    );
    expect(actorConflictsWithTouches({ id: 'USR-OM', displayName: 'Case Officer' }, touches)).toBeNull();
  });

  it('sums Yusuf exposure as goods released plus money paid out', () => {
    const money = investigationMoneySummary({
      goodsReleasedNgn: 971_400 + 1_071_000,
      moneyPaidOutNgn: 51_000 + 40_600,
      recoveredNgn: 0,
      writtenOffNgn: 0,
    });
    expect(money.goodsReleasedNgn).toBe(2_042_400);
    expect(money.moneyPaidOutNgn).toBe(91_600);
    expect(money.exposureNgn).toBe(2_134_000);
    expect(money.stillAtStakeNgn).toBe(2_134_000);
  });
});
