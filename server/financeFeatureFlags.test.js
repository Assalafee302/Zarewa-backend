import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  accountingPolicyV1HealthCapabilities,
  financeStrictBlockWouldApply,
  readFinanceFeatureFlags,
} from './financeFeatureFlags.js';

describe('financeFeatureFlags', () => {
  const prev = {};

  beforeEach(() => {
    for (const k of [
      'STRICT_CASHIER_RBAC',
      'ALLOW_ACCOUNTANT_RECEIPT_CONFIRMATION',
      'ENFORCE_DUAL_CONTROL_PAYMENTS',
      'ACCOUNTING_POLICY_V1_LABELS',
      'ACCOUNTING_POLICY_V1_DIAGNOSTICS',
    ]) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it('defaults B3a flags off strict enforcement', () => {
    const f = readFinanceFeatureFlags();
    expect(f.phase).toBe('B3a');
    expect(f.strictCashierRbac).toBe(false);
    expect(f.allowAccountantReceiptConfirmation).toBe(true);
    expect(f.enforceDualControlPayments).toBe(false);
  });

  it('does not block same-user approve/pay when enforcement off', () => {
    expect(financeStrictBlockWouldApply('same_user_approve_pay')).toBe(false);
  });

  it('honours ENFORCE_DUAL_CONTROL_PAYMENTS=1', () => {
    process.env.ENFORCE_DUAL_CONTROL_PAYMENTS = '1';
    expect(financeStrictBlockWouldApply('same_user_approve_pay')).toBe(true);
  });

  it('defaults Policy v1 flags off', () => {
    const f = readFinanceFeatureFlags();
    expect(f.accountingPolicyV1Labels).toBe(false);
    expect(f.accountingPolicyV1Diagnostics).toBe(false);
  });

  it('accountingPolicyV1HealthCapabilities reflects env', () => {
    process.env.ACCOUNTING_POLICY_V1_LABELS = '1';
    const caps = accountingPolicyV1HealthCapabilities(readFinanceFeatureFlags());
    expect(caps.accountingPolicyV1Labels).toBe('v1');
    expect(caps.accountingPolicyV1).toBe('ap1b');
  });
});
