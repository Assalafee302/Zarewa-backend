/**
 * AP2c — supplier advance GL design (optional posting behind flag; not wired to legacy payments).
 */
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import {
  ensureGlSchema,
  getGlAccountIdByCode,
  postBalancedJournal,
  seedDefaultGlAccounts,
} from './glOps.js';
import { tableExists } from './ap2ReceivedBasisOps.js';

const SUPPLIER_ADVANCE_CODE = '1400';

export function ensureSupplierAdvanceGlAccount(db) {
  ensureGlSchema(db);
  seedDefaultGlAccounts(db);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES (?,?,?,?,1,?)`
  );
  ins.run('acc-supplier-adv', SUPPLIER_ADVANCE_CODE, 'Supplier advances / prepayments', 'asset', 28);
  return getGlAccountIdByCode(db, SUPPLIER_ADVANCE_CODE);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function describeSupplierAdvanceGlCapability(db) {
  const flags = readFinanceFeatureFlags();
  ensureSupplierAdvanceGlAccount(db);
  const accountId = getGlAccountIdByCode(db, SUPPLIER_ADVANCE_CODE);
  const hasGl = tableExists(db, 'gl_journal_entries');
  let existingSupplierPaymentGl = 0;
  if (hasGl) {
    try {
      existingSupplierPaymentGl = db
        .prepare(
          `SELECT COUNT(*) AS c FROM gl_journal_entries
           WHERE UPPER(COALESCE(source_kind,'')) LIKE '%SUPPLIER%'`
        )
        .get()?.c;
    } catch {
      existingSupplierPaymentGl = 0;
    }
  }
  return {
    postingEnabled: flags.supplierAdvanceAccountingEnabled,
    accountCode: SUPPLIER_ADVANCE_CODE,
    accountConfigured: Boolean(accountId),
    legacySupplierPaymentGlCount: existingSupplierPaymentGl,
    designNotes: [
      'Supplier payments in Treasury do not consistently post GL today — do not retroactively reclassify.',
      'When enabled: prepayment Dr 1400 / Cr 1000; GRN Dr 1300 / Cr 2100; apply advance Dr 2100 / Cr 1400.',
      'Use source_kind SUPPLIER_ADVANCE_PAYMENT with PO id for idempotency.',
    ],
  };
}

/**
 * Optional controlled post — only when flag on and called explicitly (not from payment flow).
 * @param {import('better-sqlite3').Database} db
 */
export function tryPostSupplierAdvancePaymentGl(db, payload) {
  const flags = readFinanceFeatureFlags();
  if (!flags.supplierAdvanceAccountingEnabled) {
    return {
      ok: false,
      skipped: true,
      reason: 'SUPPLIER_ADVANCE_ACCOUNTING_ENABLED=0',
    };
  }
  const amt = Math.round(Number(payload.amountNgn) || 0);
  if (amt <= 0) return { ok: false, error: 'Amount required.' };
  ensureSupplierAdvanceGlAccount(db);
  const poId = String(payload.poId || '').trim();
  const sourceId = poId ? `PO-ADV-PAY-${poId}-${payload.paymentRef || '1'}` : String(payload.sourceId || '').trim();
  const tid = Math.round(Number(payload.treasuryAccountId) || 0);
  const creditCode = tid > 0 ? String(1000 + tid) : '1001';
  if (tid > 0) {
    const glId = `acc-cash-${tid}`;
    db.prepare(
      `INSERT OR IGNORE INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES (?,?,?,?,1,?)`
    ).run(glId, creditCode, `Cash — account ${tid}`, 'asset', 10 + tid);
  }
  return postBalancedJournal(db, {
    entryDateISO: String(payload.entryDateISO || new Date().toISOString()).slice(0, 10),
    memo: payload.memo || `Supplier prepayment ${poId}`,
    sourceKind: 'SUPPLIER_ADVANCE_PAYMENT',
    sourceId,
    branchId: payload.branchId,
    createdByUserId: payload.createdByUserId,
    lines: [
      { accountCode: SUPPLIER_ADVANCE_CODE, debitNgn: amt, memo: poId },
      { accountCode: creditCode, creditNgn: amt, memo: poId },
    ],
  });
}
