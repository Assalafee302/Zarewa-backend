import { describe, expect, it } from 'vitest';
import { isAllowedExpenseCategory, isLoanRepaymentExpenseCategory } from '../expenseCategories.js';
import { getExpenseCategoryLane } from '../expenseCategoryLanes.js';
import { glAccountForExpenseCategory } from './expenseCategoryGlMap.js';
import { ap3CostingHintForCategory } from './ap3CostingClassification.js';
import { classifyBookExpense } from './monthEndDataPack.js';

const BOI = 'Loan repayment — BOI';

describe('Loan repayment — BOI (owner, 19 Oct 2026)', () => {
  it('is an allowed category in the restricted special lane', () => {
    expect(isAllowedExpenseCategory(BOI)).toBe(true);
    expect(getExpenseCategoryLane(BOI)).toBe('special');
    expect(isLoanRepaymentExpenseCategory(BOI)).toBe(true);
    expect(isLoanRepaymentExpenseCategory('Staff loan')).toBe(false);
  });

  it('posts to Loans payable (2600), a liability — not an expense or equity account', () => {
    expect(glAccountForExpenseCategory(BOI)).toEqual({ accountCode: '2600', isEquity: false, isCapex: false });
  });

  it('is not a cost in costing and not an expense in the month-end pack', () => {
    const hint = ap3CostingHintForCategory(BOI);
    expect(hint.bucket).toBe('loan_principal');
    expect(hint.affectsCostPerMetre).toBe(false);
    const book = classifyBookExpense({ category: BOI, description: 'BOI loan repayment 6 Oct' });
    expect(book.loanRepayment).toBe(true);
    expect(book.bucket).toBe('reclassify');
    expect(book.suggested).toMatch(/not an expense/);
  });
});
