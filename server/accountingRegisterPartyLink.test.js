import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  assessRegisterLinePartyLink,
  buildDebtorsRegister,
  createAccountingRegisterLine,
  ensureAccountingRegisterSchema,
  listAccountingRegisterLines,
} from './accountingSubledgerOps.js';

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

function insertUnlinkedLegacyLine(db, overrides = {}) {
  ensureAccountingRegisterSchema(db);
  db.prepare(
    `INSERT INTO accounting_register_lines (
      id, register_side, category, party_name, party_ref, branch_id, amount_ngn,
      as_at_date_iso, source, description, status, reference, created_at_iso, created_by_user_id, notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    overrides.id || 'REG-UNLINKED-1',
    overrides.registerSide || 'debtor',
    overrides.category || 'project_overpayment',
    overrides.partyName || 'April roofing project',
    overrides.partyRef ?? null,
    overrides.branchId || DEFAULT_BRANCH_ID,
    overrides.amountNgn ?? 8_000_000,
    overrides.asAtDateIso || '2024-04-01',
    'legacy',
    overrides.description || 'Pre-system overpayment',
    'open',
    overrides.reference || 'April project',
    new Date().toISOString(),
    null,
    null
  );
}

function insertSalesReceipt(db, overrides = {}) {
  db.prepare(
    `INSERT OR REPLACE INTO sales_receipts (
      id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, finance_reconciliation_saved_at_iso
    ) VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    overrides.id || 'RCPT-TEST-1',
    overrides.customerId || 'CUS-001',
    overrides.customerName || 'Test Customer',
    overrides.quotationRef ?? null,
    overrides.amountNgn ?? 100_000,
    overrides.status || 'Pending clearance',
    overrides.dateIso || '2026-05-20',
    overrides.financeReconciliationSavedAtIso ?? null
  );
}

function insertOpenBankDeposit(db, overrides = {}) {
  db.prepare(
    `INSERT OR REPLACE INTO bank_deposits (
      id, branch_id, bank_date_iso, amount_ngn, allocated_ngn, description, bank_reference, status, registered_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    overrides.id || 'BD-TEST-1',
    overrides.branchId || DEFAULT_BRANCH_ID,
    overrides.bankDateIso || '2026-05-20',
    overrides.amountNgn ?? 250_000,
    overrides.allocatedNgn ?? 0,
    overrides.description || 'Test bank inflow',
    overrides.bankReference || 'REF-TEST',
    overrides.status || 'OPEN',
    new Date().toISOString()
  );
}

describe.skipIf(!mysqlOk)('accounting register party linking', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('rejects linked categories without a master-record party ref', () => {
    const bad = createAccountingRegisterLine(
      db,
      {
        registerSide: 'debtor',
        category: 'project_overpayment',
        partyName: 'April roofing project',
        amountNgn: 8_000_000,
        asAtDateIso: '2024-04-01',
        branchId: DEFAULT_BRANCH_ID,
      },
      { id: 'USR-ADMIN' }
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/customer/i);
  });

  it('creates a customer-linked project overpayment line', () => {
    const ok = createAccountingRegisterLine(
      db,
      {
        registerSide: 'debtor',
        category: 'project_overpayment',
        partyRef: 'CUS-001',
        amountNgn: 8_000_000,
        asAtDateIso: '2024-04-01',
        branchId: DEFAULT_BRANCH_ID,
        description: 'April project overpayment',
      },
      { id: 'USR-ADMIN' }
    );
    expect(ok.ok).toBe(true);
    expect(ok.line.partyRef).toBe('CUS-001');
    expect(ok.line.partyName).toBeTruthy();
  });

  it('rejects an invalid customer id', () => {
    const bad = createAccountingRegisterLine(
      db,
      {
        registerSide: 'debtor',
        category: 'customer_deposit',
        partyRef: 'CUS-NOPE',
        amountNgn: 100_000,
        asAtDateIso: '2024-01-01',
        branchId: DEFAULT_BRANCH_ID,
      },
      { id: 'USR-ADMIN' }
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/customer/i);
  });

  it('rejects inter-branch lines where counterparty equals own branch', () => {
    const branches = db.prepare(`SELECT id FROM branches ORDER BY id`).all();
    expect(branches.length).toBeGreaterThan(0);
    const own = branches[0].id;
    const bad = createAccountingRegisterLine(
      db,
      {
        registerSide: 'debtor',
        category: 'inter_branch',
        partyRef: own,
        amountNgn: 500_000,
        asAtDateIso: '2024-01-01',
        branchId: own,
      },
      { id: 'USR-ADMIN' }
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/differ/i);
  });

  it('flags unlinked legacy lines in the debtors register', () => {
    insertUnlinkedLegacyLine(db);
    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const legacy = reg.sections.find((s) => s.id === 'legacy_inherited');
    expect(legacy?.unlinkedLegacyCount).toBe(1);
    expect(reg.summary.unlinkedLegacyCount).toBe(1);
    const row = legacy.items.find((i) => i.id === 'REG-UNLINKED-1');
    expect(row.partyLinkStatus).toBe('unlinked');
    expect(row.partyLinkWarning).toMatch(/customer/i);
  });

  it('assessRegisterLinePartyLink marks linked supplier lines as linked', () => {
    const supplier = db.prepare(`SELECT supplier_id FROM suppliers LIMIT 1`).get();
    expect(supplier?.supplier_id).toBeTruthy();
    const link = assessRegisterLinePartyLink(db, {
      category: 'supplier_ap',
      partyRef: supplier.supplier_id,
      branchId: DEFAULT_BRANCH_ID,
    });
    expect(link.partyLinkStatus).toBe('linked');
    expect(link.partyLinkWarning).toBe('');
  });

  it('lists register lines for a single branch only', () => {
    insertUnlinkedLegacyLine(db, { id: 'REG-KD-1', branchId: DEFAULT_BRANCH_ID });
    const otherBranch = db
      .prepare(`SELECT id FROM branches WHERE id <> ? ORDER BY id LIMIT 1`)
      .get(DEFAULT_BRANCH_ID)?.id;
    if (!otherBranch) return;
    insertUnlinkedLegacyLine(db, {
      id: 'REG-OTHER-1',
      branchId: otherBranch,
      partyName: 'Other branch payable',
    });

    const scoped = listAccountingRegisterLines(db, {
      registerSide: 'debtor',
      branchId: DEFAULT_BRANCH_ID,
      status: 'open',
    });
    expect(scoped.lines.some((l) => l.id === 'REG-KD-1')).toBe(true);
    expect(scoped.lines.some((l) => l.id === 'REG-OTHER-1')).toBe(false);
  });

  it('rejects register lines without a branch', () => {
    const bad = createAccountingRegisterLine(
      db,
      {
        registerSide: 'debtor',
        category: 'legacy',
        partyName: 'Unscoped payable',
        amountNgn: 100_000,
        asAtDateIso: '2024-01-01',
      },
      { id: 'USR-ADMIN' }
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/branch/i);
  });

  it('buildDebtorsRegister scopes legacy inherited lines by branch', () => {
    insertUnlinkedLegacyLine(db, { id: 'REG-KD-LEG', branchId: DEFAULT_BRANCH_ID });
    const otherBranch = db
      .prepare(`SELECT id FROM branches WHERE id <> ? ORDER BY id LIMIT 1`)
      .get(DEFAULT_BRANCH_ID)?.id;
    if (!otherBranch) return;
    insertUnlinkedLegacyLine(db, {
      id: 'REG-OTHER-LEG',
      branchId: otherBranch,
      partyName: 'Other branch legacy',
    });

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const legacy = reg.sections.find((s) => s.id === 'legacy_inherited');
    expect(legacy?.items.some((i) => i.id === 'REG-KD-LEG')).toBe(true);
    expect(legacy?.items.some((i) => i.id === 'REG-OTHER-LEG')).toBe(false);
  });

  it('excludes uncleared linked receipts from debtors sections but lists them as exceptions', () => {
    insertSalesReceipt(db, {
      id: 'RCPT-UNCLEARED-LINKED',
      quotationRef: 'QT-CLR-001',
      amountNgn: 300_000,
      financeReconciliationSavedAtIso: null,
    });
    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const unallocated = reg.sections.find((s) => s.id === 'unallocated_receipts');
    expect(unallocated?.items.some((i) => i.id === 'RCPT-UNCLEARED-LINKED')).toBe(false);
    expect(reg.exceptions?.pendingFinanceClearance?.count).toBe(1);
    expect(reg.exceptions.pendingFinanceClearance.totalNgn).toBe(300_000);
    expect(reg.summary.pendingFinanceClearanceCount).toBe(1);
  });

  it('includes unlinked sales receipts in unallocated section only', () => {
    insertSalesReceipt(db, {
      id: 'RCPT-UNLINKED',
      quotationRef: null,
      amountNgn: 150_000,
    });
    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const unallocated = reg.sections.find((s) => s.id === 'unallocated_receipts');
    expect(unallocated?.items.some((i) => i.id === 'RCPT-UNLINKED')).toBe(true);
    expect(reg.summary.unallocatedReceiptsNgn).toBe(150_000);
    expect(reg.exceptions?.pendingFinanceClearance?.count).toBe(0);
  });

  it('includes open bank deposits in bank deposit suspense section', () => {
    insertOpenBankDeposit(db, { id: 'BD-SUSP-1', amountNgn: 400_000 });
    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const suspense = reg.sections.find((s) => s.id === 'bank_deposit_suspense');
    expect(suspense?.items.some((i) => i.id === 'BD-SUSP-1')).toBe(true);
    expect(reg.summary.bankDepositSuspenseNgn).toBe(400_000);
  });
});
