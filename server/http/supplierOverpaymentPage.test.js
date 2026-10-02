import { describe, expect, it } from 'vitest';
import { renderSupplierOverpaymentPage } from './supplierOverpaymentRoutes.js';

describe('renderSupplierOverpaymentPage', () => {
  it('renders sign-in message when user is not logged in', () => {
    const html = renderSupplierOverpaymentPage({
      user: null,
      canPost: false,
    });
    expect(html).toContain('Sign in to Zarewa first');
  });

  it('renders read-only warning when user lacks finance.pay', () => {
    const html = renderSupplierOverpaymentPage({
      user: { displayName: 'Sales Officer', permissions: ['sales.create'] },
      canPost: false,
    });
    expect(html).toContain('read-only access here');
  });

  it('renders KPI metrics, tabs, and action forms when a purchase order is loaded', () => {
    const html = renderSupplierOverpaymentPage({
      user: { displayName: 'Amina Finance', permissions: ['finance.pay'] },
      canPost: true,
      poId: 'PO-2026-0042',
      position: {
        ok: true,
        poId: 'PO-2026-0042',
        supplierName: 'African Steel Mills Ltd',
        branchId: 'BR-KD',
        status: 'received',
        obligationNgn: 10_000_000,
        supplierPaidNgn: 12_500_000,
        stillOwedNgn: 0,
        excessNgn: 2_500_000,
      },
      accounts: [
        { id: 1, name: 'Kaduna Bank (GTB)', type: 'Bank', balance: 50_000_000 },
        { id: 2, name: 'TAJ Bank', type: 'Bank', balance: 12_000_000 },
      ],
      treasuryAccountId: '1',
      dateISO: '2026-10-02',
      csrf: 'token-abc',
      recentOrders: [
        { po_id: 'PO-2026-0042', supplier_name: 'African Steel Mills Ltd', status: 'received' },
      ],
      overpaidOrders: [
        { po_id: 'PO-2026-0042', supplier_name: 'African Steel Mills Ltd' },
      ],
      movements: [
        {
          id: 'TM-2026-1',
          postedAtISO: '2026-10-01',
          type: 'SUPPLIER_OVERPAYMENT',
          amountNgn: -2_500_000,
          reference: 'NIP/991283',
          note: 'Duplicate transfer during payroll weekend',
          treasuryAccountId: 1,
          accountName: 'Kaduna Bank (GTB)',
          accountType: 'Bank',
        },
      ],
    });

    // PO Header
    expect(html).toContain('African Steel Mills Ltd');
    expect(html).toContain('#PO-2026-0042');
    expect(html).toContain('Kaduna');

    // KPI Metrics
    expect(html).toContain('10,000,000'); // obligation
    expect(html).toContain('12,500,000'); // paid
    expect(html).toContain('Paid in full ✓');
    expect(html).toContain('2,500,000'); // excess

    // Tabs
    expect(html).toContain('1. Record Second / Extra Payment');
    expect(html).toContain('2. Record Overpayment Reversal');
    expect(html).toContain('2,500,000 refundable');

    // Form inputs and quick fill
    expect(html).toContain('Fill Full Excess (₦2,500,000)');
    expect(html).toContain('Kaduna Bank (GTB)');
    expect(html).toContain('NIP/20261002/983719');

    // Movement History
    expect(html).toContain('NIP/991283');
    expect(html).toContain('Duplicate transfer during payroll weekend');
    expect(html).toContain('−₦2,500,000');
  });

  it('renders confirmation notice or error when present', () => {
    const html = renderSupplierOverpaymentPage({
      user: { displayName: 'Amina Finance', permissions: ['finance.pay'] },
      canPost: true,
      notice: 'Recorded ₦2,500,000 leaving the bank.',
      error: 'Bank reference was already recorded.',
    });
    expect(html).toContain('Transaction Confirmed:');
    expect(html).toContain('Recorded ₦2,500,000 leaving the bank.');
    expect(html).toContain('Transaction Blocked:');
    expect(html).toContain('Bank reference was already recorded.');
  });
});
