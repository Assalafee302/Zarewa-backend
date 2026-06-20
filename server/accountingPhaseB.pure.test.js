import { describe, expect, it } from 'vitest';
import { monthBounds } from './accountingStatementsOps.js';
import { glAccountForExpenseCategory } from '../shared/lib/expenseCategoryGlMap.js';
import { mapFixedAssetRow } from './accountingPhase2Ops.js';

describe('accounting Phase B (pure)', () => {
  it('monthBounds parses YYYY-MM', () => {
    expect(monthBounds('bad')).toBeNull();
    expect(monthBounds('2026-02')?.end).toBe('2026-02-28');
  });

  it('glAccountForExpenseCategory maps carriage inward to 5050', () => {
    expect(glAccountForExpenseCategory('Carriage inward').accountCode).toBe('5050');
  });

  it('mapFixedAssetRow sets zero depreciation for land', () => {
    const asset = mapFixedAssetRow({
      id: 'FA-LAND',
      name: 'Plot',
      category: 'land',
      branch_id: 'BR-KD',
      acquisition_date_iso: '2024-01-01',
      cost_ngn: 50_000_000,
      salvage_ngn: 0,
      useful_life_months: 600,
      depreciation_method: 'straight_line',
      status: 'active',
      disposal_date_iso: null,
      disposal_proceeds_ngn: 0,
      treasury_reference: '',
      source_expense_id: '',
      notes: '',
      created_at_iso: '',
      updated_at_iso: '',
      created_by_user_id: '',
      updated_by_user_id: '',
    });
    expect(asset.monthlyDepreciationNgn).toBe(0);
  });

  it('mapFixedAssetRow computes straight-line depreciation for plant', () => {
    const asset = mapFixedAssetRow({
      id: 'FA-PLANT',
      name: 'Press',
      category: 'plant',
      branch_id: 'BR-KD',
      acquisition_date_iso: '2024-01-01',
      cost_ngn: 12_000_000,
      salvage_ngn: 0,
      useful_life_months: 120,
      depreciation_method: 'straight_line',
      status: 'active',
      disposal_date_iso: null,
      disposal_proceeds_ngn: 0,
      treasury_reference: '',
      source_expense_id: '',
      notes: '',
      created_at_iso: '',
      updated_at_iso: '',
      created_by_user_id: '',
      updated_by_user_id: '',
    });
    expect(asset.monthlyDepreciationNgn).toBe(100_000);
  });
});
