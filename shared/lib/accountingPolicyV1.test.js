import { describe, expect, it } from 'vitest';
import {
  policyBalanceLabelText,
  quotationPaymentPolicyPhase,
  quotationPaymentPolicySnapshot,
} from './accountingPolicyV1.js';

describe('accountingPolicyV1', () => {
  const quote = { id: 'QT-1', totalNgn: 1_000_000, paidNgn: 400_000 };
  const completedJobs = [
    { status: 'Completed', quotationRef: 'QT-1', actualMeters: 100, completedAtISO: '2026-05-10' },
  ];

  it('quotationPaymentPolicyPhase is pre_production without completed jobs', () => {
    expect(quotationPaymentPolicyPhase('QT-1', [])).toBe('pre_production');
  });

  it('quotationPaymentPolicyPhase is post_production after completion', () => {
    expect(quotationPaymentPolicyPhase('QT-1', completedJobs)).toBe('post_production');
  });

  it('pre_production snapshot treats paid as deposit and zero receivable', () => {
    const s = quotationPaymentPolicySnapshot(quote, []);
    expect(s.policyPhase).toBe('pre_production');
    expect(s.depositOnAccountNgn).toBe(400_000);
    expect(s.depositPendingNgn).toBe(600_000);
    expect(s.receivableNgn).toBe(0);
    expect(s.balanceLabel).toBe('deposit_pending');
  });

  it('post_production snapshot exposes receivable only', () => {
    const s = quotationPaymentPolicySnapshot(quote, completedJobs);
    expect(s.policyPhase).toBe('post_production');
    expect(s.receivableNgn).toBe(600_000);
    expect(s.depositOnAccountNgn).toBe(0);
    expect(s.amountDueNgn).toBe(600_000);
    expect(s.balanceLabel).toBe('receivable');
  });

  it('policyBalanceLabelText maps labels', () => {
    expect(policyBalanceLabelText('deposit_pending')).toContain('Deposit');
    expect(policyBalanceLabelText('receivable')).toBe('Receivable');
  });
});
