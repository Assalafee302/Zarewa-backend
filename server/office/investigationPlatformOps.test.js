import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db.js';
import { insertCuttingList, insertProductionJob, payRefundEntry } from '../writeOps.js';
import { insertRefundRequest } from '../controlOps.js';
import {
  addInvestigationPlatformMember,
  closeInvestigationPlatformCase,
  getInvestigationPlatformCase,
  liftInvestigationPlatformHold,
  openInvestigationPlatformCase,
} from './investigationPlatformOps.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

const md = { id: 'USR-MD', roleKey: 'md', displayName: 'Managing Director', permissions: [] };
const officer = { id: 'USR-OM', roleKey: 'operations_manager', displayName: 'Case Officer', permissions: [] };
const sales = { id: 'USR-SALES', roleKey: 'sales', displayName: 'Sales Desk', permissions: [] };

describe.skipIf(!mysqlOk)('investigation platform phase 1', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    const iso = new Date().toISOString();
    const users = [
      ['USR-MD', 'md.user', 'Managing Director', 'md'],
      ['USR-OM', 'om.user', 'Case Officer', 'operations_manager'],
      ['USR-BM', 'bm.user', 'Aminu Bello', 'sales_manager'],
      ['USR-SALES', 'sales.user', 'Sales Desk', 'sales'],
      ['USR-CASH', 'cash.user', 'Cashier', 'cashier'],
    ];
    for (const [id, username, displayName, role] of users) {
      db.prepare(
        `INSERT INTO app_users (id, username, display_name, password_hash, role_key, status, created_at_iso)
         VALUES (?, ?, ?, 'x', ?, 'active', ?)`
      ).run(id, username, displayName, role, iso);
    }
    db.prepare(
      `INSERT INTO customers (customer_id, name, phone_number, branch_id, status, created_by, created_at_iso)
       VALUES ('CUS-KD-26-1069', 'YUSUF', '0803123453985', 'BR-KD', 'Active', 'Aminu Bello', ?)`
    ).run(iso);
    db.prepare(
      `INSERT INTO customers (customer_id, name, phone_number, branch_id, status, created_at_iso)
       VALUES ('CUS-SHARE', 'Same phone', '234803123453985', 'BR-KD', 'Active', ?)`
    ).run(iso);
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, handled_by, handled_by_user_id, branch_id)
       VALUES ('QT-KD-26-1594', 'CUS-KD-26-1069', 'YUSUF', 971400, 'Aminu Bello', 'USR-BM', 'BR-KD')`
    ).run();
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, handled_by, branch_id)
       VALUES ('QT-KD-26-1606', 'CUS-KD-26-1069', 'YUSUF', 1071000, 'Aminu Bello', 'BR-KD')`
    ).run();
    db.prepare(
      `INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, handled_by)
       VALUES ('LE-KD-26-1767', 'CUS-KD-26-1069', 'YUSUF', 'QT-KD-26-1594', 1000000, 'Pending', 'Aminu Bello')`
    ).run();
    db.prepare(
      `INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, handled_by)
       VALUES ('LE-KD-26-1778', 'CUS-KD-26-1069', 'YUSUF', 'QT-KD-26-1606', 1122000, 'Pending', 'Aminu Bello')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (job_id, quotation_ref, customer_id, customer_name, status, created_at_iso, actual_meters)
       VALUES ('PRO-KD-26-1303', 'QT-KD-26-1594', 'CUS-KD-26-1069', 'YUSUF', 'Completed', ?, 198)`
    ).run(iso);
    db.prepare(
      `INSERT INTO production_jobs (job_id, quotation_ref, customer_id, customer_name, status, created_at_iso, actual_meters)
       VALUES ('PRO-KD-26-1314', 'QT-KD-26-1606', 'CUS-KD-26-1069', 'YUSUF', 'Completed', ?, 231)`
    ).run(iso);
    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, quotation_ref, amount_ngn, status,
         approved_by, paid_by, paid_amount_ngn, payee_name, branch_id
       ) VALUES ('RF-KD-26-9638', 'CUS-KD-26-1069', 'YUSUF', 'QT-KD-26-1594', 51000, 'Paid',
         'Aminu Bello', 'Aminu Bello', 51000, 'Aminu Bello', 'BR-KD')`
    ).run();
    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, quotation_ref, amount_ngn, status,
         approved_by, paid_amount_ngn, payee_name, branch_id
       ) VALUES ('RF-KD-26-9679', 'CUS-KD-26-1069', 'YUSUF', 'QT-KD-26-1606', 40600, 'Paid',
         'Aminu Bello', 40600, 'Aminu Bello', 'BR-KD')`
    ).run();
  });

  afterEach(() => {
    db?.close?.();
  });

  function openYusuf(actor = md, officerId = 'USR-OM') {
    return openInvestigationPlatformCase(
      db,
      {
        id: 'INV-KD-26-0001',
        explicitId: true,
        title: 'Yusuf — goods released on receipts that never reached Taj',
        branchId: 'BR-KD',
        status: 'Open',
        caseOfficerUserId: officerId,
        links: [
          { recordKind: 'customer', recordId: 'CUS-KD-26-1069' },
          { recordKind: 'quotation', recordId: 'QT-KD-26-1594' },
          { recordKind: 'quotation', recordId: 'QT-KD-26-1606' },
          { recordKind: 'receipt', recordId: 'LE-KD-26-1767' },
          { recordKind: 'receipt', recordId: 'LE-KD-26-1778' },
          { recordKind: 'production_job', recordId: 'PRO-KD-26-1303' },
          { recordKind: 'production_job', recordId: 'PRO-KD-26-1314' },
          { recordKind: 'refund', recordId: 'RF-KD-26-9638' },
          { recordKind: 'refund', recordId: 'RF-KD-26-9679' },
        ],
      },
      actor
    );
  }

  it('suspends linked receipts and refuses refunds, payouts, and new production', () => {
    const opened = openYusuf();
    expect(opened.ok).toBe(true);
    expect(opened.case.money.exposureNgn).toBe(2_134_000);
    expect(opened.case.money.goodsReleasedNgn).toBe(2_042_400);
    expect(opened.case.money.moneyPaidOutNgn).toBe(91_600);
    expect(opened.case.money.stillAtStakeNgn).toBe(2_134_000);

    const receipt = db.prepare(`SELECT status FROM sales_receipts WHERE id = ?`).get('LE-KD-26-1767');
    expect(receipt.status).toBe('Suspended - investigation');

    const cutting = insertCuttingList(db, { customerID: 'CUS-KD-26-1069', quotationRef: 'QT-KD-26-1594' });
    expect(cutting.ok).toBe(false);
    expect(cutting.error).toBe('Under investigation: INV-KD-26-0001');

    const sharedPhone = insertCuttingList(db, { customerID: 'CUS-SHARE' });
    expect(sharedPhone.error).toBe('Under investigation: INV-KD-26-0001');

    const job = insertProductionJob(db, { customerID: 'CUS-KD-26-1069', quotationRef: 'QT-KD-26-1606' });
    expect(job.error).toBe('Under investigation: INV-KD-26-0001');

    const refund = insertRefundRequest(
      db,
      { customerID: 'CUS-KD-26-1069', quotationRef: 'QT-KD-26-1594', amountNgn: 5000 },
      sales,
      'BR-KD'
    );
    expect(refund.error).toBe('Under investigation: INV-KD-26-0001');

    const payout = payRefundEntry(db, 'RF-KD-26-9638', { actor: officer });
    expect(payout.ok).toBe(false);
    expect(payout.error).toContain('Under investigation: INV-KD-26-0001');
  });

  it('limits the case file to the MD, the case officer, and members, and logs the view', () => {
    expect(openYusuf().ok).toBe(true);
    const denied = getInvestigationPlatformCase(db, 'INV-KD-26-0001', sales);
    expect(denied.status).toBe(403);

    const asOfficer = getInvestigationPlatformCase(db, 'INV-KD-26-0001', officer);
    expect(asOfficer.ok).toBe(true);
    const viewed = db
      .prepare(`SELECT action FROM audit_log WHERE entity_id = ? AND action = 'investigation.platform.view'`)
      .all('INV-KD-26-0001');
    expect(viewed.length).toBeGreaterThan(0);

    const added = addInvestigationPlatformMember(db, 'INV-KD-26-0001', 'USR-CASH', md);
    expect(added.ok).toBe(true);
    expect(getInvestigationPlatformCase(db, 'INV-KD-26-0001', { id: 'USR-CASH', roleKey: 'cashier' }).ok).toBe(true);
  });

  it('refuses a case officer or member whose name is on a linked record', () => {
    const named = openYusuf(md, 'USR-BM');
    expect(named.ok).toBe(false);
    expect(named.code).toBe('INVESTIGATION_CONFLICT');

    expect(openYusuf().ok).toBe(true);
    const member = addInvestigationPlatformMember(db, 'INV-KD-26-0001', 'USR-BM', md);
    expect(member.ok).toBe(false);
    expect(member.code).toBe('INVESTIGATION_CONFLICT');
  });

  it('lets only the MD lift a hold or close the case', () => {
    expect(openYusuf().ok).toBe(true);
    const officerLift = liftInvestigationPlatformHold(db, 'INV-KD-26-0001', { note: 'Not the MD.' }, officer);
    expect(officerLift.status).toBe(403);
    const officerClose = closeInvestigationPlatformCase(
      db,
      'INV-KD-26-0001',
      { outcome: 'Cleared', decisionNote: 'Officer cannot close this case.' },
      officer
    );
    expect(officerClose.status).toBe(403);

    const lifted = liftInvestigationPlatformHold(
      db,
      'INV-KD-26-0001',
      { note: 'MD lifts the hold after the statements are in.' },
      md
    );
    expect(lifted.ok).toBe(true);
    expect(lifted.case.holdActive).toBe(false);
    const restored = db.prepare(`SELECT status FROM sales_receipts WHERE id = ?`).get('LE-KD-26-1767');
    expect(restored.status).toBe('Pending');

    const closed = closeInvestigationPlatformCase(
      db,
      'INV-KD-26-0001',
      { outcome: 'Written off', decisionNote: 'MD closes after the police reference is filed.', writtenOffNgn: 0 },
      md
    );
    expect(closed.ok).toBe(true);
    expect(closed.case.status).toBe('Closed');
    expect(closed.case.outcome).toBe('Written off');
  });
});
