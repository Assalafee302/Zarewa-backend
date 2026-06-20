import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { buildCreditorsRegister } from './accountingSubledgerOps.js';
import { MIN_CUSTOMER_TRADE_RECEIVABLE_NGN } from '../shared/lib/accountingRegisterConstants.js';

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

function seedCustomer(db, customerId) {
  db.prepare(
    `INSERT IGNORE INTO customers (customer_id, name, branch_id, status, tier, payment_terms)
     VALUES (?, ?, ?, 'Active', 'Standard', 'Cash')`
  ).run(customerId, 'Receivable Test Customer', DEFAULT_BRANCH_ID);
}

function seedCustomerReceivableQuote(db, { id, customerId, totalNgn, paidNgn }) {
  seedCustomer(db, customerId);
  db.prepare(
    `INSERT OR REPLACE INTO quotations (
      id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    customerId,
    'Receivable Test Customer',
    totalNgn,
    paidNgn,
    'Partial',
    'Approved',
    '{}',
    '2026-05-10',
    DEFAULT_BRANCH_ID
  );
  db.prepare(
    `INSERT OR REPLACE INTO production_jobs (
      job_id, quotation_ref, actual_meters, status, completed_at_iso, created_at_iso, branch_id
    ) VALUES (?,?,?,?,?,?,?)`
  ).run(
    `JOB-${id}`,
    id,
    10,
    'Completed',
    '2026-05-10T10:00:00.000Z',
    '2026-05-10T10:00:00.000Z',
    DEFAULT_BRANCH_ID
  );
}

describe.skipIf(!mysqlOk)('creditors register customer trade receivables floor', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it(`excludes customer receivable rows below ₦${MIN_CUSTOMER_TRADE_RECEIVABLE_NGN.toLocaleString()}`, () => {
    seedCustomerReceivableQuote(db, {
      id: 'QT-SMALL-FLOOR',
      customerId: 'CUS-SMALL-FLOOR',
      totalNgn: 50_000,
      paidNgn: 49_700,
    });

    const reg = buildCreditorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const section = reg.sections.find((s) => s.id === 'customer_receivables');
    expect(section?.items.some((i) => i.partyRef === 'CUS-SMALL-FLOOR')).toBe(false);
  });

  it(`includes customer receivable rows at or above ₦${MIN_CUSTOMER_TRADE_RECEIVABLE_NGN.toLocaleString()}`, () => {
    seedCustomerReceivableQuote(db, {
      id: 'QT-LARGE-FLOOR',
      customerId: 'CUS-LARGE-FLOOR',
      totalNgn: 50_000,
      paidNgn: 48_000,
    });

    const reg = buildCreditorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const section = reg.sections.find((s) => s.id === 'customer_receivables');
    const row = section?.items.find((i) => i.partyRef === 'CUS-LARGE-FLOOR');
    expect(row?.amountNgn).toBe(2_000);
  });

  it('includes customer when small balances aggregate above the floor', () => {
    seedCustomer(db, 'CUS-MIX-FLOOR');
    seedCustomerReceivableQuote(db, {
      id: 'QT-MIX-A',
      customerId: 'CUS-MIX-FLOOR',
      totalNgn: 10_000,
      paidNgn: 9_500,
    });
    seedCustomerReceivableQuote(db, {
      id: 'QT-MIX-B',
      customerId: 'CUS-MIX-FLOOR',
      totalNgn: 10_000,
      paidNgn: 9_400,
    });

    const reg = buildCreditorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const section = reg.sections.find((s) => s.id === 'customer_receivables');
    const row = section?.items.find((i) => i.partyRef === 'CUS-MIX-FLOOR');
    expect(row?.amountNgn).toBe(1_100);
  });
});
