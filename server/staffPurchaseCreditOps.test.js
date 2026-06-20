import { beforeAll, describe, expect, it } from 'vitest';
import { acquireIntegrationHarness, isMysqlAvailableForTests, resolveTestActor } from './testIntegrationHarness.js';
import {
  applyStaffPurchaseCreditToQuotationPaid,
  computeStaffPurchaseCreditAmountBounds,
  createStaffPurchaseCreditRequest,
  decideStaffPurchaseCredit,
  ensureStaffSalesCustomer,
  getQuotationStaffPurchaseCreditStatus,
  staffPurchaseCreditColumnsReady,
  syncQuotationStaffPurchaseFlag,
} from './staffPurchaseCreditOps.js';
import { countPendingStaffPurchaseCreditRequests, syncStaffPurchaseCreditWorkItem, STAFF_PURCHASE_CREDIT_WORK_SOURCE } from './staffPurchaseCreditWorkItems.js';
import { findPersistedWorkItemBySource } from './workItems.js';
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

    const approved = decideStaffPurchaseCredit(db, pending.id, 'approve', actor, { note: 'MD approved UAT' });
    expect(approved.ok).toBe(true);
    expect(approved.account.status).toBe('active');
    expect(approved.account.principalOutstandingNgn).toBeGreaterThan(0);

    const sync = syncQuotationPaidFromReceipts(db, quotationRef);
    expect(sync.staffPurchaseCreditNgn).toBeGreaterThan(0);
    expect(sync.paidNgn).toBeGreaterThan(0);

    const applyDup = applyStaffPurchaseCreditToQuotationPaid(db, quotationRef, 1000, pending.id, actor);
    expect(applyDup.already).toBe(true);
  });

  it('requires rejection note and exposes deposit bounds in status', () => {
    const bounds = computeStaffPurchaseCreditAmountBounds(400_000, { requireDepositPercent: 25 });
    expect(bounds.depositRequiredNgn).toBe(100_000);
    expect(bounds.maxCreditNgn).toBe(300_000);

    db.prepare(
      `UPDATE hr_staff_obligation_accounts SET status = 'paid_off', principal_outstanding_ngn = 0, updated_at_iso = ?
       WHERE user_id = ? AND kind = 'purchase' AND status IN ('active', 'pending_approval')`
    ).run(nowIso(), staffUserId);

    const quote2 = `QT-TEST-SPC-REJ-${Date.now()}`;
    const cust = ensureStaffSalesCustomer(db, staffUserId, actor);
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
       VALUES (?, ?, 'Test Staff', 400000, 0, 'Unpaid', 'Pending', '{}', date('now'), 'KD')`
    ).run(quote2, cust.customerId);

    const req = createStaffPurchaseCreditRequest(db, actor, {
      quotationRef: quote2,
      staffUserId,
      amountNgn: 200_000,
      termMonths: 4,
      reason: 'Reject flow UAT',
    });
    expect(req.ok, req.error || 'create failed').toBe(true);

    const noNote = decideStaffPurchaseCredit(db, req.account.id, 'reject', actor, { note: 'no' });
    expect(noNote.ok).toBe(false);

    const rejected = decideStaffPurchaseCredit(db, req.account.id, 'reject', actor, {
      note: 'Not approved — policy exception',
    });
    expect(rejected.ok).toBe(true);
    expect(rejected.account.status).toBe('rejected');

    const status = getQuotationStaffPurchaseCreditStatus(db, quote2);
    expect(status.rejectionNote).toMatch(/policy exception/i);
    expect(Array.isArray(status.timeline)).toBe(true);
    expect(status.timeline.some((e) => e.action === 'hr.purchase_credit.rejected')).toBe(true);

    syncStaffPurchaseCreditWorkItem(db, db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(req.account.id), actor);
    const wi = findPersistedWorkItemBySource(db, STAFF_PURCHASE_CREDIT_WORK_SOURCE, req.account.id);
    expect(wi?.status === 'rejected' || wi?.status === 'closed').toBe(true);
  });

  it('tracks pending count for MD queue', () => {
    const n = countPendingStaffPurchaseCreditRequests(db, 'ALL');
    expect(typeof n).toBe('number');
  });
});
