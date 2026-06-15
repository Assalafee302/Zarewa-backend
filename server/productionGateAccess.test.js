import { describe, expect, it } from 'vitest';
import {
  productionGateOverrideDeniedMessage,
  productionGateOverrideEffective,
  productionGateOverrideNoteValid,
  quotationHasRecordedPayment,
  userMayApproveProductionGate,
} from './productionGateAccess.js';

describe('productionGateAccess', () => {
  it('allows branch manager when some payment is recorded', () => {
    expect(userMayApproveProductionGate({ roleKey: 'sales_manager' }, 50_000)).toBe(true);
    expect(userMayApproveProductionGate({ roleKey: 'md' }, 0)).toBe(true);
    expect(userMayApproveProductionGate({ roleKey: 'admin' }, 0)).toBe(true);
  });

  it('denies branch manager at zero payment', () => {
    expect(userMayApproveProductionGate({ roleKey: 'sales_manager' }, 0)).toBe(false);
    expect(userMayApproveProductionGate({ roleKey: 'sales_staff' }, 50_000)).toBe(false);
  });

  it('effective override at zero payment requires md or admin level', () => {
    expect(
      productionGateOverrideEffective({
        manager_production_approved_at_iso: '2026-06-01',
        paid_ngn: 100_000,
        manager_production_approval_level: 'branch_manager',
      })
    ).toBe(true);
    expect(
      productionGateOverrideEffective({
        manager_production_approved_at_iso: '2026-06-01',
        paid_ngn: 0,
        manager_production_approval_level: 'branch_manager',
      })
    ).toBe(false);
    expect(
      productionGateOverrideEffective({
        manager_production_approved_at_iso: '2026-06-01',
        paid_ngn: 0,
        manager_production_approval_level: 'md',
      })
    ).toBe(true);
  });

  it('validates override note length', () => {
    expect(productionGateOverrideNoteValid('short')).toBe(false);
    expect(productionGateOverrideNoteValid('long enough')).toBe(true);
  });

  it('messages distinguish zero payment', () => {
    expect(productionGateOverrideDeniedMessage(0)).toMatch(/Managing Director/i);
    expect(productionGateOverrideDeniedMessage(1)).toMatch(/Branch Manager/i);
    expect(quotationHasRecordedPayment(0)).toBe(false);
    expect(quotationHasRecordedPayment(1)).toBe(true);
  });
});
