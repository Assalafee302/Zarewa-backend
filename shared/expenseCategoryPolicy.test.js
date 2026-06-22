import { describe, expect, it } from 'vitest';
import { EXPENSE_CATEGORY_OPTIONS } from './expenseCategories.js';
import {
  getExpenseCategoryLane,
  groupExpenseCategoriesByLane,
  isExceptionExpenseCategory,
  requiresElevatedApprovalLane,
} from './expenseCategoryLanes.js';
import {
  actorMaySelectExpenseCategory,
  expenseCategoriesForActor,
  isFinanceExceptionExpenseItem,
  resolveExpenseCategoryPolicyLimits,
  validateExpenseCategoryForTreasuryPayout,
  validateCapexTreasuryPayout,
  validateSpecialLaneTreasuryPayout,
  validateExpenseCategorySelection,
} from './expenseCategoryPolicy.js';

describe('expenseCategoryLanes', () => {
  it('maps production categories', () => {
    expect(getExpenseCategoryLane('Fuel & lubricant')).toBe('production');
    expect(getExpenseCategoryLane('Maintenance')).toBe('production');
  });

  it('maps exception and revenue', () => {
    expect(isExceptionExpenseCategory('Others')).toBe(true);
    expect(getExpenseCategoryLane('Sales')).toBe('revenue');
    expect(requiresElevatedApprovalLane('Chairman withdrawal')).toBe(true);
  });

  it('groups all canonical categories', () => {
    const groups = groupExpenseCategoriesByLane();
    const total = groups.reduce((s, g) => s + g.categories.length, 0);
    expect(total).toBe(EXPENSE_CATEGORY_OPTIONS.length);
  });
});

describe('expenseCategoryPolicy', () => {
  const staff = { roleKey: 'sales_staff', permissions: ['expenses.create'] };
  const finance = { roleKey: 'finance_manager', permissions: ['finance.post', 'finance.approve'] };
  const hasFinancePerm = (p) => finance.permissions.includes(p) || p === '*';

  it('blocks staff from chairman withdrawal', () => {
    expect(actorMaySelectExpenseCategory(staff, 'Chairman withdrawal')).toBe(false);
    expect(actorMaySelectExpenseCategory(finance, 'Chairman withdrawal', hasFinancePerm)).toBe(true);
  });

  it('blocks revenue categories on payment requests', () => {
    const r = validateExpenseCategorySelection({
      actor: finance,
      category: 'Refund',
      amountNgn: 1000,
      description: 'test',
      hasAttachment: true,
    });
    expect(r.ok).toBe(false);
  });

  it('requires justification and attachment for Others', () => {
    const bad = validateExpenseCategorySelection({
      actor: staff,
      category: 'Others',
      amountNgn: 5000,
      description: 'short',
      hasAttachment: false,
    });
    expect(bad.ok).toBe(false);

    const good = validateExpenseCategorySelection({
      actor: staff,
      category: 'Office expenses',
      amountNgn: 5000,
      description: 'Stationery for branch office use this month',
      hasAttachment: false,
    });
    expect(good.ok).toBe(true);
  });

  it('filters revenue from staff picker groups', () => {
    const groups = expenseCategoriesForActor(staff);
    const flat = groups.flatMap((g) => g.categories);
    expect(flat).not.toContain('Sales');
    expect(flat).not.toContain('Refund');
    expect(flat).toContain('Office expenses');
  });

  it('flags finance exception lanes for queue filtering', () => {
    expect(isFinanceExceptionExpenseItem('Others', 'exception')).toBe(true);
    expect(isFinanceExceptionExpenseItem('Chairman withdrawal', 'special')).toBe(true);
    expect(isFinanceExceptionExpenseItem('Office expenses', 'admin')).toBe(false);
  });

  it('resolves org Others limits with sane fallbacks', () => {
    const limits = resolveExpenseCategoryPolicyLimits({
      othersMinJustificationLen: 55,
      othersFinanceReviewThresholdNgn: 75_000,
      ap3UnclassifiedAlertThresholdNgn: 250_000,
      othersBranchCoachThresholdPct: 20,
    });
    expect(limits.othersMinJustificationLen).toBe(55);
    expect(limits.othersFinanceReviewThresholdNgn).toBe(75_000);
    expect(limits.ap3UnclassifiedAlertThresholdNgn).toBe(250_000);
    expect(limits.othersBranchCoachThresholdPct).toBe(20);
    expect(resolveExpenseCategoryPolicyLimits({ othersMinJustificationLen: 3 }).othersMinJustificationLen).toBe(
      40
    );
  });

  it('blocks treasury payout for revenue categories and mis-mapped GL', () => {
    expect(validateExpenseCategoryForTreasuryPayout('Sales').ok).toBe(false);
    expect(validateExpenseCategoryForTreasuryPayout('Refund').ok).toBe(false);
    expect(validateExpenseCategoryForTreasuryPayout('Office expenses').ok).toBe(true);
  });

  it('requires capex attachment and asset description before payout', () => {
    expect(
      validateCapexTreasuryPayout({ assetDescription: 'short', hasAttachment: true }).ok
    ).toBe(false);
    expect(
      validateCapexTreasuryPayout({
        assetDescription: 'New generator for Kaduna plant backup power',
        hasAttachment: false,
      }).ok
    ).toBe(false);
    expect(
      validateCapexTreasuryPayout({
        assetDescription: 'New generator for Kaduna plant backup power',
        hasAttachment: true,
      }).ok
    ).toBe(true);
  });

  it('requires HR loan link for staff loan treasury payout', () => {
    expect(
      validateSpecialLaneTreasuryPayout({ category: 'Staff loan', hasHrLoanLink: false }).ok
    ).toBe(false);
    expect(
      validateSpecialLaneTreasuryPayout({ category: 'Staff loan', hasHrLoanLink: true }).ok
    ).toBe(true);
  });

  it('honours org Others min length on validation', () => {
    const r = validateExpenseCategorySelection({
      actor: staff,
      category: 'Others',
      amountNgn: 5000,
      description: 'This is a long enough explanation for the custom policy minimum length rule.',
      categoryJustification: 'Short',
      hasAttachment: true,
      policyLimits: resolveExpenseCategoryPolicyLimits({ othersMinJustificationLen: 60 }),
    });
    expect(r.ok).toBe(false);
  });

  it('allows Others without attachment when requireAttachment is false', () => {
    const r = validateExpenseCategorySelection({
      actor: staff,
      category: 'Others',
      amountNgn: 5000,
      categoryJustification: 'x'.repeat(40),
      hasAttachment: false,
      requireAttachment: false,
    });
    expect(r.ok).toBe(true);
  });
});
