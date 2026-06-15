import { describe, expect, it } from 'vitest';
import {
  productionGateOverrideNoteValid,
  userMayApproveProductionGate,
} from './productionGateAccess.js';

describe('productionGateAccess', () => {
  it('allows branch manager and md', () => {
    expect(userMayApproveProductionGate({ roleKey: 'sales_manager' })).toBe(true);
    expect(userMayApproveProductionGate({ roleKey: 'md' })).toBe(true);
    expect(userMayApproveProductionGate({ roleKey: 'admin' })).toBe(true);
  });

  it('denies sales officer', () => {
    expect(userMayApproveProductionGate({ roleKey: 'sales_staff' })).toBe(false);
  });

  it('validates override note length', () => {
    expect(productionGateOverrideNoteValid('1234567')).toBe(false);
    expect(productionGateOverrideNoteValid('12345678')).toBe(true);
  });
});
