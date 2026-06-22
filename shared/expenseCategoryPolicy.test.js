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
});
