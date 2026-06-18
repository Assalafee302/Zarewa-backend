import { beforeAll, describe, expect, it } from 'vitest';
import { acquireIntegrationHarness, isMysqlAvailableForTests, resolveTestActor } from './testIntegrationHarness.js';
import {
  applyStaffPurchaseCreditToQuotationPaid,
  createStaffPurchaseCreditRequest,
  decideStaffPurchaseCredit,
  ensureStaffSalesCustomer,
  getQuotationStaffPurchaseCreditStatus,
  staffPurchaseCreditColumnsReady,
  syncQuotationStaffPurchaseFlag,
} from './staffPurchaseCreditOps.js';
import { staffObligationTablesReady } from './staffObligationOps.js';
import { nowIso } from './hrOps.js';
import { syncQuotationPaidFromReceipts } from './writeOps.js';

describe.skipIf(!isMysqlAvailableForTests())('staffPurchaseCreditOps', () => {
  let db;
  let actor;
  let staffUserId;
  let quotationRef;

  beforeAll(() => {
    const harness = acquireIntegrationHarness();
    db = harness.db;
    actor = { ...resolveTestActor(db), roleKey: 'admin', permissions: ['*'] };
    const staff = db.prepare(`SELECT user_id FROM hr_staff_profiles LIMIT 1`).get();
    staffUserId = staff?.user_id;
    expect(staffUserId).toBeTruthy();
    expect(staffObligationTablesReady(db)).toBe(true);
    expect(staffPurchaseCreditColumnsReady(db)).toBe(true);

    db.prepare(`UPDATE hr_staff_profiles SET date_joined_iso = '2018-01-01', updated_at_iso = ? WHERE user_id = ?`).run(
      nowIso(),
      staffUserId
    );

    const cust = ensureStaffSalesCustomer(db, staffUserId, actor);
    expect(cust.ok).toBe(true);

    quotationRef = `QT-TEST-SPC-${Date.now()}`;
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
       VALUES (?, ?, 'Test Staff', 500000, 0, 'Unpaid', 'Pending', '{}', date('now'), 'KD')`
    ).run(quotationRef, cust.customerId);
    syncQuotationStaffPurchaseFlag(db, quotationRef);
  });

  it('flags staff quotations and creates purchase credit request', () => {
    const q = db.prepare(`SELECT is_staff_purchase FROM quotations WHERE id = ?`).get(quotationRef);
    expect(Number(q?.is_staff_purchase)).toBe(1);

    const req = createStaffPurchaseCreditRequest(db, actor, {
      quotationRef,
      staffUserId,
      amountNgn: 300_000,
      termMonths: 3,
      reason: 'UAT staff roof purchase',
    });
    expect(req.ok, req.error || 'create failed').toBe(true);
    expect(req.account.status).toBe('pending_approval');

    const status = getQuotationStaffPurchaseCreditStatus(db, quotationRef);
    expect(status.isStaffCustomer).toBe(true);
    expect(status.account?.id).toBe(req.account.id);
  });

  it('approves purchase credit and books quotation paid via ledger', () => {
    const pending = db
      .prepare(`SELECT id FROM hr_staff_obligation_accounts WHERE quotation_ref = ? AND status = 'pending_approval'`)
      .get(quotationRef);
    expect(pending?.id).toBeTruthy();

    const approved = decideStaffPurchaseCredit(db, pending.id, 'approve', actor, { note: 'BM approved UAT' });
    expect(approved.ok).toBe(true);
    expect(approved.account.status).toBe('active');
    expect(approved.account.principalOutstandingNgn).toBeGreaterThan(0);

    const sync = syncQuotationPaidFromReceipts(db, quotationRef);
    expect(sync.staffPurchaseCreditNgn).toBeGreaterThan(0);
    expect(sync.paidNgn).toBeGreaterThan(0);

    const applyDup = applyStaffPurchaseCreditToQuotationPaid(db, quotationRef, 1000, pending.id, actor);
    expect(applyDup.already).toBe(true);
  });
});
