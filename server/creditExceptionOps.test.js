import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  createCreditExceptionRequest,
  decideCreditException,
  revokeCreditException,
  migrateCreditExceptions,
  resolveActiveCreditForQuotation,
  getQuotationCreditStatus,
  countCreditExceptionTrialDiagnostics,
} from './creditExceptionOps.js';
import { evaluateDeliveryPaymentRelease } from './deliveryReleaseGate.js';

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

describe.skipIf(!mysqlTestReady)('creditExceptionOps', () => {
  let db;
  const prev = {};

  beforeEach(() => {
    prev.DELIVERY_PAYMENT_GATE = process.env.DELIVERY_PAYMENT_GATE;
    process.env.DELIVERY_PAYMENT_GATE = 'warn';
    prev.CREDIT_BRANCH_MANAGER_LIMIT_NGN = process.env.CREDIT_BRANCH_MANAGER_LIMIT_NGN;
    process.env.CREDIT_BRANCH_MANAGER_LIMIT_NGN = '5000000';
    prev.CREDIT_MD_REQUIRED_ABOVE_NGN = process.env.CREDIT_MD_REQUIRED_ABOVE_NGN;
    process.env.CREDIT_MD_REQUIRED_ABOVE_NGN = '10000000';

    db = createDatabase(':memory:');
    migrateCreditExceptions(db);
    db.exec(`
      INSERT INTO quotations (id, customer_id, total_ngn, paid_ngn, status, lines_json, date_iso, branch_id)
      VALUES ('QT-CRED-1', 'C1', 10000000, 3000000, 'Approved', '{}', '2026-06-01', 'BR-KD');
      INSERT INTO production_jobs (job_id, quotation_ref, status, actual_meters, completed_at_iso, created_at_iso)
      VALUES ('PJ-C1','QT-CRED-1','Completed',100,'2026-06-10T10:00:00.000Z','2026-06-10T10:00:00.000Z');
    `);
  });

  afterEach(() => {
    db?.close();
    for (const k of ['DELIVERY_PAYMENT_GATE', 'CREDIT_BRANCH_MANAGER_LIMIT_NGN', 'CREDIT_MD_REQUIRED_ABOVE_NGN']) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  const branchActor = { id: 'u-bm', roleKey: 'sales_manager', displayName: 'Branch Mgr' };
  const mdActor = { id: 'u-md', roleKey: 'md', displayName: 'MD' };

  it('creates pending credit exception', () => {
    const r = createCreditExceptionRequest(
      db,
      { quotationRef: 'QT-CRED-1', amountNgn: 7_000_000, reason: 'Customer terms' },
      branchActor
    );
    expect(r.ok).toBe(true);
    expect(r.creditException.status).toBe('pending');
    expect(r.creditException.amountNgn).toBe(7_000_000);
  });

  it('approves credit exception', () => {
    const created = createCreditExceptionRequest(
      db,
      { quotationRef: 'QT-CRED-1', amountNgn: 7_000_000 },
      branchActor
    );
    const approved = decideCreditException(db, created.creditException.id, 'approve', {}, mdActor);
    expect(approved.ok).toBe(true);
    expect(approved.creditException.status).toBe('approved');
  });

  it('rejects credit exception', () => {
    const created = createCreditExceptionRequest(db, { quotationRef: 'QT-CRED-1' }, branchActor);
    const rejected = decideCreditException(db, created.creditException.id, 'reject', { note: 'No' }, mdActor);
    expect(rejected.ok).toBe(true);
    expect(rejected.creditException.status).toBe('rejected');
  });

  it('revokes approved credit', () => {
    const created = createCreditExceptionRequest(db, { quotationRef: 'QT-CRED-1' }, branchActor);
    decideCreditException(db, created.creditException.id, 'approve', {}, mdActor);
    const revoked = revokeCreditException(db, created.creditException.id, { note: 'Revoked' }, mdActor);
    expect(revoked.ok).toBe(true);
    expect(revoked.creditException.status).toBe('revoked');
  });

  it('delivery gate allows when approved credit covers balance', () => {
    const created = createCreditExceptionRequest(db, { quotationRef: 'QT-CRED-1', amountNgn: 7_000_000 }, branchActor);
    decideCreditException(db, created.creditException.id, 'approve', {}, mdActor);
    const gate = evaluateDeliveryPaymentRelease(db, { quotationRef: 'QT-CRED-1' });
    expect(gate.creditAllowed).toBe(true);
    expect(gate.wouldBlock).toBe(false);
    expect(gate.code).toBe('DELIVERY_RELEASE_CREDIT_EXCEPTION');
  });

  it('partial credit does not fully pass gate', () => {
    const created = createCreditExceptionRequest(db, { quotationRef: 'QT-CRED-1', amountNgn: 1_000_000 }, branchActor);
    decideCreditException(db, created.creditException.id, 'approve', {}, mdActor);
    const active = resolveActiveCreditForQuotation(db, 'QT-CRED-1');
    expect(active.coversBalance).toBe(false);
    const gate = evaluateDeliveryPaymentRelease(db, { quotationRef: 'QT-CRED-1' });
    expect(gate.wouldBlock).toBe(true);
    expect(gate.creditAllowed).toBe(false);
  });

  it('expired credit does not pass gate', () => {
    const created = createCreditExceptionRequest(
      db,
      { quotationRef: 'QT-CRED-1', expiresAtISO: '2020-01-01' },
      branchActor
    );
    decideCreditException(db, created.creditException.id, 'approve', {}, mdActor);
    const active = resolveActiveCreditForQuotation(db, 'QT-CRED-1');
    expect(active).toBeNull();
  });

  it('does not create GL journal on approve', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gl_journal_entries (
        id TEXT PRIMARY KEY, entry_date_iso TEXT, period_key TEXT, memo TEXT,
        source_kind TEXT, source_id TEXT, created_at_iso TEXT
      );
    `);
    const created = createCreditExceptionRequest(db, { quotationRef: 'QT-CRED-1' }, branchActor);
    decideCreditException(db, created.creditException.id, 'approve', {}, mdActor);
    const n = db.prepare(`SELECT COUNT(*) AS c FROM gl_journal_entries`).get().c;
    expect(n).toBe(0);
  });

  it('trial diagnostics include credit counts', () => {
    createCreditExceptionRequest(db, { quotationRef: 'QT-CRED-1' }, branchActor);
    const d = countCreditExceptionTrialDiagnostics(db, 'ALL');
    expect(d.pendingCreditExceptionsCount).toBe(1);
  });

  it('quotation credit-status returns outstanding', () => {
    const st = getQuotationCreditStatus(db, 'QT-CRED-1');
    expect(st.outstandingNgn).toBe(7_000_000);
    expect(st.receivableNgn).toBe(7_000_000);
  });
});
