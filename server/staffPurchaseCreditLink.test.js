import { describe, expect, it } from 'vitest';
import {
  formatStaffSalesCustomerName,
  linkSalesCustomerToStaff,
  listStaffForSalesCustomerLink,
} from './staffPurchaseCreditOps.js';
import { acquireIntegrationHarness, isMysqlAvailableForTests, resolveTestActor } from './testIntegrationHarness.js';
import { nowIso } from './hrOps.js';

describe('formatStaffSalesCustomerName', () => {
  it('includes employee number when present', () => {
    expect(formatStaffSalesCustomerName('Ahmed Musa', 'ZAPKD004')).toBe('Ahmed Musa · ZAPKD004 (Staff)');
  });
});

describe.skipIf(!isMysqlAvailableForTests())('staff customer link', () => {
  it('links sales customer to staff and lists by employee number', () => {
    const harness = acquireIntegrationHarness();
    const db = harness.db;
    const actor = { ...resolveTestActor(db), roleKey: 'admin', permissions: ['*'] };
    const staff = db.prepare(`SELECT user_id, employee_no FROM hr_staff_profiles LIMIT 1`).get();
    expect(staff?.user_id).toBeTruthy();

    db.prepare(`UPDATE hr_staff_profiles SET employee_no = ?, sales_customer_id = NULL, updated_at_iso = ? WHERE user_id = ?`).run(
      'ZAPKD004',
      nowIso(),
      staff.user_id
    );

    const customerId = `CUS-LINK-TEST-${Date.now()}`;
    db.prepare(
      `INSERT INTO customers (customer_id, name, phone_number, email, status, tier, payment_terms, created_by, created_at_iso, last_activity_iso, branch_id)
       VALUES (?, 'Test Staff Buyer', '080', '', 'Active', 'Regular', 'Due on receipt', 'test', date('now'), date('now'), 'KD')`
    ).run(customerId);

    const linked = linkSalesCustomerToStaff(db, customerId, staff.user_id, actor);
    expect(linked.ok, linked.error).toBe(true);
    expect(linked.customerName).toContain('ZAPKD004');

    const options = listStaffForSalesCustomerLink(db, 'ALL', 'zapkd004');
    expect(options.some((o) => o.userId === staff.user_id)).toBe(true);
    expect(options[0]?.label).toContain('ZAPKD004');
  });
});
