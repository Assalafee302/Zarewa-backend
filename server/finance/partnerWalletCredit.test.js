import { describe, it, expect, afterEach } from 'vitest';
import { partnerWalletEnabled } from './partnerWalletCredit.js';

const prevWallet = process.env.ZAREWA_PARTNER_WALLET_V1;
const prevAssoc = process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1;

describe('partnerWalletEnabled', () => {
  afterEach(() => {
    if (prevWallet == null) delete process.env.ZAREWA_PARTNER_WALLET_V1;
    else process.env.ZAREWA_PARTNER_WALLET_V1 = prevWallet;
    if (prevAssoc == null) delete process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1;
    else process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = prevAssoc;
  });

  it('follows explicit ZAREWA_PARTNER_WALLET_V1', () => {
    process.env.ZAREWA_PARTNER_WALLET_V1 = '1';
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '0';
    expect(partnerWalletEnabled()).toBe(true);
    process.env.ZAREWA_PARTNER_WALLET_V1 = '0';
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '1';
    expect(partnerWalletEnabled()).toBe(false);
  });

  it('defaults to associated-staff policy when wallet flag unset', () => {
    delete process.env.ZAREWA_PARTNER_WALLET_V1;
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '1';
    expect(partnerWalletEnabled()).toBe(true);
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '0';
    expect(partnerWalletEnabled()).toBe(false);
  });
});
