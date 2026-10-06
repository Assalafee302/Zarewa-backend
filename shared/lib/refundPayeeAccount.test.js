import { describe, expect, it } from 'vitest';
import {
  payeeAccountRejection,
  refundExceedsOpenCredit,
  refundIdFromSystemMatch,
  statementContainsPayeeAccount,
} from './refundPayeeAccount.js';

describe('refund payee account', () => {
  it('accepts a 10-digit bank account and an 11-digit OPay number', () => {
    expect(payeeAccountRejection('0123456789')).toBe('');
    expect(payeeAccountRejection('08140171674')).toBe('');
  });

  it('rejects blank, letter, zero, and short placeholders', () => {
    expect(payeeAccountRejection('')).toMatch(/required/i);
    expect(payeeAccountRejection('000')).toMatch(/required/i);
    expect(payeeAccountRejection('87654')).toMatch(/10-digit/);
    expect(payeeAccountRejection('sed')).toMatch(/digits/);
    expect(payeeAccountRejection('1234')).toMatch(/10-digit/);
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
});
