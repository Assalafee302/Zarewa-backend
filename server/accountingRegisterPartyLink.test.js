import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  assessRegisterLinePartyLink,
  buildDebtorsRegister,
  createAccountingRegisterLine,
  ensureAccountingRegisterSchema,
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
});
