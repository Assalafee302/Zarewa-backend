import { describe, expect, it } from 'vitest';
import {
  effectiveRefundOpenCreditNgn,
  payeeAccountRejection,
  payeeAccountRejectionReason,
  refundExceedsOpenCredit,
  refundIdFromSystemMatch,
  statementContainsPayeeAccount,
} from './refundPayeeAccount.js';

describe('refund payee account', () => {
  it('accepts a 10-digit bank account and an 11-digit OPay number', () => {
    expect(payeeAccountRejectionReason('0123456789')).toBe('');
    expect(payeeAccountRejectionReason('08140171674')).toBe('');
  });

  it('TEMP: placeholders pass while ENFORCE_REAL_PAYEE_ACCOUNT is false', () => {
    expect(payeeAccountRejection('')).toBe('');
    expect(payeeAccountRejection('000')).toBe('');
    expect(payeeAccountRejection('87654')).toBe('');
    expect(payeeAccountRejection('sed')).toBe('');
    expect(payeeAccountRejection('1234')).toBe('');
  });

  it('names the exact receiver account that failed validation', () => {
    expect(payeeAccountRejectionReason('')).toMatch(/blank/i);
    expect(payeeAccountRejectionReason('sed')).toMatch(/"sed"/);
    expect(payeeAccountRejectionReason('Ahmed Ibrahim')).toMatch(/"Ahmed Ibrahim"/);
    expect(payeeAccountRejectionReason('1234')).toMatch(/"1234"/);
    expect(payeeAccountRejectionReason('000')).toMatch(/"000"/);
  });

  it('matches the bank line only when the payee account is in the narration', () => {
    expect(statementContainsPayeeAccount('TRF to 3064987728 BAKARI', '3064987728')).toBe(true);
    expect(statementContainsPayeeAccount('Customer refund payout · Aminu', '3064987728')).toBe(false);
  });

  it('reads a refund id from a reconciliation match', () => {
    expect(refundIdFromSystemMatch('matched RF-KD-26-9655 today')).toBe('RF-KD-26-9655');
    expect(refundIdFromSystemMatch('LE-KD-26-1836')).toBe('');
  });

  it('blocks a refund above open credit unless MD approved', () => {
    expect(refundExceedsOpenCredit({ amountNgn: 5000, openCreditNgn: 1000, mdApproved: false })).toMatch(/MD approval/);
    expect(refundExceedsOpenCredit({ amountNgn: 5000, openCreditNgn: 1000, mdApproved: true })).toBe('');
    expect(refundExceedsOpenCredit({ amountNgn: 1000, openCreditNgn: 1000, mdApproved: false })).toBe('');
  });

  it('counts quotation overpay residual as open credit when ledger OVERPAY_ADVANCE is missing', () => {
    expect(
      effectiveRefundOpenCreditNgn({ ledgerOpenCreditNgn: 0, quotationOverpayResidualNgn: 483_050 })
    ).toBe(483_050);
    expect(
      effectiveRefundOpenCreditNgn({ ledgerOpenCreditNgn: 50_000, quotationOverpayResidualNgn: 483_050 })
    ).toBe(483_050);
    expect(
      refundExceedsOpenCredit({
        amountNgn: 483_050,
        openCreditNgn: effectiveRefundOpenCreditNgn({
          ledgerOpenCreditNgn: 0,
          quotationOverpayResidualNgn: 483_050,
        }),
        mdApproved: false,
      })
    ).toBe('');
  });
});
