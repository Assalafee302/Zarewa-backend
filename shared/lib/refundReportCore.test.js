// @vitest-environment node
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildRefundReport,
  FLAG_PAID_NO_TREASURY,
  FLAG_PAYEE_IS_APPROVER,
  FLAG_PAYEE_IS_STAFF,
  FLAG_PAYEE_NOT_CUSTOMER,
  REVIEW_NO_BANK_LINK,
  REVIEW_NO_PAYEE,
  sameName,
  samePerson,
} from './refundReportCore.js';
import { refundReportDocument, refundReportExcelSheets } from './refundReportPrint.js';
import { renderReportDocument } from './reportPrintDocument.js';

const load = (f) => JSON.parse(fs.readFileSync(new URL(`./__fixtures__/kd-2026-09/${f}`, import.meta.url), 'utf8'));
const bank = load('bankReconSource.json');
const fx = load('refundReportSource.json');
const accounts = new Map(bank.accounts.map((a) => [String(a.id), a]));
const treasury = bank.treasuryMovements.map((t) => {
  const a = accounts.get(String(t.treasuryAccountId)) || {};
  return { ...t, accountName: a.name, bankName: a.bankName, accountType: a.type };
});

describe('name matching', () => {
  it('drops titles and accepts a 4+ letter prefix', () => {
    expect(sameName('ENGR ATTA', 'Engr Attah Nicholas')).toBe(true);
    expect(sameName('Abba Yusuf Baita', 'ABBA YUSUF')).toBe(true);
    expect(sameName('Musa Ali', 'Haruna Mohd')).toBe(false);
    expect(samePerson('Musa', 'Musa Ali')).toBe(true);
    expect(samePerson('Musa Bello', 'Musa Ali')).toBe(false);
  });
});

describe('refund report — synthetic flags', () => {
  const tm = (id, refundID, amountNgn, extra = {}) => ({
    id, postedAtISO: '2026-08-10T12:00:00.000Z', type: 'REFUND_PAYOUT', treasuryAccountId: 4, accountName: 'Main', bankName: 'Moniepoint',
    accountType: 'Bank', amountNgn: -amountNgn, sourceKind: 'REFUND', sourceId: refundID, ...extra,
  });
  const rf = (refundID, customer, payeeName, approvedBy, extra = {}) => ({
    refundID, customer, payeeName, approvedBy, requestedBy: 'Sales Officer Ade', status: 'Paid', paidAmountNgn: 1000,
    paidAtISO: '2026-08-10', requestedAtISO: '2026-08-09', ...extra,
  });
  const r = buildRefundReport({
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    staffNames: ['Ibrahim Cashier'],
    refunds: [
      rf('RF-1', 'Musa Ali', 'MUSA ALI', 'Manager Bala'),
      rf('RF-2', 'Musa Ali', 'Haruna Mohd', 'Manager Bala'),
      rf('RF-3', 'Musa Ali', 'Bala Manager', 'Manager Bala'),
      rf('RF-4', 'Musa Ali', 'Ibrahim Cashier', 'Manager Bala'),
      rf('RF-5', 'Musa Ali', '', 'Manager Bala'),
      rf('RF-6', 'Musa Ali', 'Musa Ali', 'Manager Bala'),
    ],
    treasuryMovements: [
      tm('TM-XX-26-0001', 'RF-1', 1000),
      tm('TM-XX-26-0002', 'RF-2', 1000),
      tm('TM-XX-26-0003', 'RF-3', 1000),
      tm('TM-XX-26-0004', 'RF-4', 1000),
      tm('TM-XX-26-0005', 'RF-5', 1000, { postedAtISO: '2026-08-09T12:00:00.000Z' }),
    ],
    bankRecon: [{ id: 'BKR-XX-26-0001', systemMatch: 'TM-XX-26-0001' }],
  });
  const row = (id) => r.rows.find((x) => x.refundID === id);

  it('one row per payout, sorted by payment date then account', () => {
    expect(r.rows.map((x) => x.treasuryMovementId)).toEqual(['TM-XX-26-0005', 'TM-XX-26-0001', 'TM-XX-26-0002', 'TM-XX-26-0003', 'TM-XX-26-0004']);
    expect(row('RF-1')).toMatchObject({ bankLineId: 'BKR-XX-26-0001', accountDebited: 'Main (Moniepoint)', amountNgn: 1000, severity: '' });
  });

  it('flags payee ≠ customer, payee = approver, payee = staff', () => {
    expect(row('RF-2').flags).toEqual([FLAG_PAYEE_NOT_CUSTOMER]);
    expect(row('RF-3').flags).toEqual([FLAG_PAYEE_NOT_CUSTOMER, FLAG_PAYEE_IS_APPROVER, `${FLAG_PAYEE_IS_STAFF} (Manager Bala)`]);
    expect(row('RF-4').flags).toEqual([FLAG_PAYEE_NOT_CUSTOMER, `${FLAG_PAYEE_IS_STAFF} (Ibrahim Cashier)`]);
    expect(r.counts).toMatchObject({ payeeNotCustomer: 3, payeeIsApprover: 1, payeeIsStaff: 2 });
  });

  it('amber for no payee and for a bank payout with no bank-statement line', () => {
    expect(row('RF-5')).toMatchObject({ severity: 'review', review: [REVIEW_NO_PAYEE, REVIEW_NO_BANK_LINK] });
  });

  it('flags one payee receiving refunds for 3+ different customers', () => {
    const many = buildRefundReport({
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      refunds: ['A', 'B', 'C'].map((c, i) => rf(`RF-M${i}`, `Customer ${c}x`, 'Auwal Bakari', 'Manager Bala', { customerID: `CUS-${c}` })),
      treasuryMovements: [0, 1, 2].map((i) => tm(`TM-XX-26-01${i}`, `RF-M${i}`, 500)),
    });
    expect(many.rows.every((x) => x.flags.includes('Same payee for several customers (3 in the period)'))).toBe(true);
    expect(many.counts.payeeManyCustomers).toBe(3);
  });

  it('a refund marked paid with no treasury payout is an exception', () => {
    expect(r.paidNoTreasury.map((x) => [x.refundID, x.flags])).toEqual([['RF-6', [FLAG_PAID_NO_TREASURY]]]);
  });

  it('prints through the shared layout with full ids and red rows', () => {
    const html = renderReportDocument(refundReportDocument(r, { branchName: 'Kaduna' }));
    expect(html).toContain('TM-XX-26-0002');
    expect(html).toContain('class="sev-exception"');
    expect(html).toContain('Page " counter(page) " of " counter(pages)');
  });
});

describe('refund report — Kaduna Sep 2026 fixture', () => {
  const r = buildRefundReport({ refunds: fx.refunds, treasuryMovements: treasury, bankRecon: bank.bankLines, startDate: '2026-09-01', endDate: '2026-09-30' });

  it('refunds paid = treasury REFUND_PAYOUT in September ₦28,512,025 (175 lines) = sales bridge figure', () => {
    expect(r.totals).toMatchObject({ paidNgn: 28_512_025, payoutCount: 175, companyCutNgn: 0 });
    expect(Object.fromEntries(r.totals.byAccount.map((a) => [a.account, a.amountNgn]))).toEqual({
      'Zarewa Aluminum & Plastics Ltd (Moniepoint)': 23_025_975,
      'Zaps Aluminum Enterprises (Taj Bank)': 5_245_510,
      'Cash Office': 240_540,
    });
  });

  it('the ERP export carries no payee: every line is amber "No payee recorded"; 39 bank payouts with no BKR line', () => {
    expect(r.counts).toMatchObject({ noPayee: 175, noBankLink: 39, exceptions: 0 });
    expect(r.rows[0]).toMatchObject({ treasuryMovementId: 'TM-KD-26-2359', refundID: 'RF-KD-26-9559', bankLineId: 'BKR-KD-26-0089' });
  });

  it('Excel has the same columns as print', () => {
    const sheets = refundReportExcelSheets(r);
    expect(sheets.map((s) => s.name)).toEqual(['Refund_payouts', 'Paid_no_treasury', 'Not_yet_paid', 'By_account']);
    expect(Object.keys(sheets[0].rows[0])).toEqual(expect.arrayContaining(['payee', 'payeeBank', 'approvedBy', 'requestedBy', 'accountDebited', 'bankLineId']));
  });
});
