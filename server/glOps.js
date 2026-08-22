/**
 * General ledger: chart of accounts, journals, trial balance, minimal auto-posting hooks.
 * @param {import('better-sqlite3').Database} db
 */

import { DEFAULT_BRANCH_ID } from './branches.js';
import { branchPredicate } from './branchSql.js';
import { assertPeriodOpen } from './controlOps.js';
import { nextGlJournalHumanId, nextGlJournalLineHumanId } from './humanId.js';
import { resolveCustomerReceiptGlCreditAccount } from './ap1cReceiptGl.js';
import { resolveReceiptReversalAccountFromMetaOrJournalLines } from './ap1cReversalRefundOps.js';
import { recordReceiptPolicyMetaAfterCustomerReceiptGl } from './receiptPolicyMetaOps.js';

function glJournalBranchFilter(db, branchScope, alias = 'j') {
  const scope = String(branchScope ?? 'ALL').trim() || 'ALL';
  return branchPredicate(db, 'gl_journal_entries', scope, alias);
}

export function ensureGlSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gl_accounts (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS gl_journal_entries (
      id TEXT PRIMARY KEY,
      entry_date_iso TEXT NOT NULL,
      period_key TEXT NOT NULL,
      memo TEXT,
      source_kind TEXT,
      source_id TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      branch_id TEXT
    );
    CREATE TABLE IF NOT EXISTS gl_journal_lines (
      id TEXT PRIMARY KEY,
      journal_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      debit_ngn INTEGER NOT NULL DEFAULT 0,
      credit_ngn INTEGER NOT NULL DEFAULT 0,
      memo TEXT,
      cost_center TEXT,
      FOREIGN KEY (journal_id) REFERENCES gl_journal_entries(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES gl_accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_gl_lines_journal ON gl_journal_lines(journal_id);
    CREATE INDEX IF NOT EXISTS idx_gl_lines_account ON gl_journal_lines(account_id);
  `);
  try {
    const cols = db.prepare(`PRAGMA table_info(gl_journal_lines)`).all();
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('cost_center')) {
      db.exec(`ALTER TABLE gl_journal_lines ADD COLUMN cost_center TEXT`);
    }
  } catch {
    /* ignore */
  }
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_gl_journal_source ON gl_journal_entries(source_kind, source_id) WHERE source_kind IS NOT NULL AND source_id IS NOT NULL AND TRIM(source_id) != '';`
    );
  } catch {
    /* older SQLite — idempotency relies on application check */
  }
}

export function seedDefaultGlAccounts(db) {
  ensureGlSchema(db);
  const c = db.prepare(`SELECT COUNT(*) AS n FROM gl_accounts`).get().n;
  if (c > 0) {
    ensureSupplementalGlAccounts(db);
    return;
  }
  const rows = [
    ['acc-cash', '1000', 'Cash on hand', 'asset', 10],
    ['acc-ar', '1200', 'Accounts receivable', 'asset', 20],
    ['acc-inv-rm', '1300', 'Raw materials inventory', 'asset', 30],
    ['acc-grni', '2100', 'GRNI / goods received not invoiced', 'liability', 40],
    ['acc-payroll-net', '2200', 'Net payroll payable', 'liability', 50],
    ['acc-paye', '2300', 'PAYE payable', 'liability', 60],
    ['acc-pension', '2400', 'Pension payable', 'liability', 70],
    ['acc-adv', '2500', 'Customer advances / deposits', 'liability', 75],
    ['acc-cogs', '5000', 'Cost of goods sold', 'expense', 80],
    ['acc-payroll-exp', '6000', 'Payroll expense', 'expense', 90],
  ];
  const ins = db.prepare(
    `INSERT INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES (?,?,?,?,1,?)`
  );
  for (const [id, code, name, type, sort] of rows) {
    ins.run(id, code, name, type, sort);
  }
  ensureSupplementalGlAccounts(db);
}

/** Ensures accounts added after first seed still exist (existing databases). */
export function ensureSupplementalGlAccounts(db) {
  try {
    db.prepare(`SELECT 1 FROM gl_accounts LIMIT 1`).get();
  } catch {
    ensureGlSchema(db);
  }
  const ins = db.prepare(
    `INSERT OR IGNORE INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES (?,?,?,?,1,?)`
  );
  /** Receipt / advance auto-posting expects these codes; older DBs may lack them if seed changed. */
  ins.run('acc-cash', '1000', 'Cash on hand', 'asset', 10);
  ins.run('acc-ar', '1200', 'Accounts receivable', 'asset', 20);
  ins.run('acc-adv', '2500', 'Customer advances / deposits', 'liability', 75);
  ins.run('acc-revenue', '4000', 'Sales revenue (management)', 'revenue', 35);
  ins.run('acc-supplier-adv', '1400', 'Supplier advances / prepayments', 'asset', 28);
  ins.run('acc-accum-dep', '1398', 'Accumulated depreciation', 'asset', 31);
  ins.run('acc-dep-exp', '6100', 'Depreciation expense', 'expense', 92);
  ins.run('acc-fa-plant', '1500', 'Plant & machinery', 'asset', 32);
  ins.run('acc-fa-building', '1501', 'Land & buildings', 'asset', 33);
  ins.run('acc-fa-furniture', '1502', 'Furniture & fittings', 'asset', 34);
  ins.run('acc-fa-generator', '1504', 'Generators', 'asset', 36);
  ins.run('acc-fa-gain-loss', '6200', 'Gain/loss on asset disposal', 'expense', 93);
  ins.run('acc-bank-suspense', '2150', 'Unallocated bank receipts', 'liability', 76);
  ins.run('acc-ap-trade', '2000', 'Trade payables — suppliers', 'liability', 38);
  ins.run('acc-due-from-branch', '1800', 'Due from branch', 'asset', 23);
  ins.run('acc-due-to-branch', '2800', 'Due to branch', 'liability', 78);
  ins.run('acc-capital', '3100', "Owner's capital", 'equity', 5);
  ins.run('acc-drawings', '3200', 'Drawings', 'equity', 6);
  ins.run('acc-retained', '3900', 'Retained earnings', 'equity', 7);
  /** Physical count / manual adjust variance (perpetual inventory). */
  ins.run('acc-inv-variance', '5055', 'Inventory count variance', 'expense', 85);
}

export function getGlAccountIdByCode(db, code) {
  const row = db.prepare(`SELECT id FROM gl_accounts WHERE code = ? AND is_active = 1`).get(String(code));
  return row?.id ?? null;
}

/**
 * Post a balanced journal (caller may already be inside a DB transaction).
 * @param {import('better-sqlite3').Database} db
 */
export function postBalancedJournalTx(db, payload) {
  try {
    db.prepare(`SELECT 1 FROM gl_journal_entries LIMIT 1`).get();
  } catch {
    ensureGlSchema(db);
    seedDefaultGlAccounts(db);
  }
  ensureSupplementalGlAccounts(db);
  const lines = payload.lines || [];
  let deb = 0;
  let cred = 0;
  for (const l of lines) {
    deb += Math.round(Number(l.debitNgn) || 0);
    cred += Math.round(Number(l.creditNgn) || 0);
  }
  if (deb !== cred) return { ok: false, error: 'Journal debits and credits must balance.', code: 'GL_NOT_BALANCED' };
  if (deb <= 0) return { ok: false, error: 'Journal total must be positive.', code: 'GL_AMOUNT' };

  const entryDate = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return { ok: false, error: 'Invalid entry date.', code: 'GL_DATE' };

  try {
    assertPeriodOpen(db, entryDate, 'GL journal date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const sk = payload.sourceKind != null ? String(payload.sourceKind).trim() : '';
  const sid = payload.sourceId != null ? String(payload.sourceId).trim() : '';
  if (sk && sid) {
    const dup = db
      .prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = ? AND source_id = ?`)
      .get(sk, sid);
    if (dup) return { ok: true, journalId: dup.id, duplicate: true };
  }

  const branchForJe = String(payload.branchId || DEFAULT_BRANCH_ID).trim();
  const jid = nextGlJournalHumanId(db, branchForJe);
  const periodKey = entryDate.slice(0, 7);
  const now = new Date().toISOString();

  const insJ = db.prepare(
    `INSERT INTO gl_journal_entries (id, entry_date_iso, period_key, memo, source_kind, source_id, created_at_iso, created_by_user_id, branch_id)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const insL = db.prepare(
    `INSERT INTO gl_journal_lines (id, journal_id, account_id, debit_ngn, credit_ngn, memo, cost_center) VALUES (?,?,?,?,?,?,?)`
  );

  insJ.run(
    jid,
    entryDate,
    periodKey,
    payload.memo ?? null,
    sk || null,
    sid || null,
    now,
    payload.createdByUserId ?? null,
    payload.branchId ?? null
  );
  for (const l of lines) {
    const aid = getGlAccountIdByCode(db, l.accountCode);
    if (!aid) throw new Error(`Unknown GL account code: ${l.accountCode}`);
    const d = Math.round(Number(l.debitNgn) || 0);
    const c = Math.round(Number(l.creditNgn) || 0);
    if (d < 0 || c < 0) throw new Error('Amounts must be non-negative.');
    if ((d === 0) === (c === 0)) throw new Error('Each line needs either debit or credit.');
    if (d > 0 && c > 0) throw new Error('Line cannot have both debit and credit.');
    const cc = l.costCenter != null ? String(l.costCenter ?? '').trim().slice(0, 64) : '';
    insL.run(nextGlJournalLineHumanId(db, branchForJe), jid, aid, d, c, l.memo ?? null, cc || null);
  }
  return { ok: true, journalId: jid };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ entryDateISO: string, memo?: string, sourceKind?: string, sourceId?: string, branchId?: string, createdByUserId?: string, lines: Array<{ accountCode: string, debitNgn?: number, creditNgn?: number, memo?: string }> }} payload
 */
export function postBalancedJournal(db, payload) {
  try {
    let result;
    db.transaction(() => {
      result = postBalancedJournalTx(db, payload);
      if (!result.ok) {
        const err = new Error(result.error);
        err.glResult = result;
        throw err;
      }
    })();
    return result;
  } catch (e) {
    if (e && typeof e === 'object' && e.glResult) return e.glResult;
    const msg = String(e.message || e);
    if (msg.includes('Unknown GL account') || msg.includes('Journal') || msg.includes('Invalid')) {
      return { ok: false, error: msg, code: 'GL_ERROR' };
    }
    return { ok: false, error: msg, code: 'GL_ERROR' };
  }
}

export function tryPostGrnInventoryJournal(db, { entryDateISO, coilNo, landedCostNgn, branchId, createdByUserId }) {
  const amt = Math.round(Number(landedCostNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true };
  try {
    const r = postBalancedJournalTx(db, {
      entryDateISO,
      memo: `GRN inventory ${coilNo}`,
      sourceKind: 'COIL_GRN',
      sourceId: coilNo,
      branchId,
      createdByUserId,
      lines: [
        { accountCode: '1300', debitNgn: amt, memo: coilNo },
        { accountCode: '2100', creditNgn: amt, memo: coilNo },
      ],
    });
    if (!r.ok) return r;
    return r;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Raw materials receipt (stone metres, accessories) — same DR inventory / CR GRNI as coil GRN when cost &gt; 0.
 * @param {{ entryDateISO: string, sourceKind: string, sourceId: string, landedCostNgn: number, branchId?: string, createdByUserId?: string, memo?: string }} p
 */
export function tryPostInventoryReceiptJournal(db, p) {
  const amt = Math.round(Number(p.landedCostNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true };
  const sourceId = String(p.sourceId || '').trim() || `rcpt-${Date.now()}`;
  try {
    return postBalancedJournalTx(db, {
      entryDateISO: p.entryDateISO,
      memo: p.memo || `Inventory receipt ${sourceId}`,
      sourceKind: p.sourceKind || 'INVENTORY_RECEIPT',
      sourceId,
      branchId: p.branchId,
      createdByUserId: p.createdByUserId,
      lines: [
        { accountCode: '1300', debitNgn: amt, memo: sourceId },
        { accountCode: '2100', creditNgn: amt, memo: sourceId },
      ],
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Coil scrap / write-off: Dr COGS 5000 / Cr RM inventory 1300 for kg × unit cost.
 * Skips when amount is 0 (missing unit cost) so physical scrap can still post.
 */
export function tryPostCoilScrapJournal(db, { entryDateISO, coilNo, kg, unitCostNgnPerKg, branchId, createdByUserId, sourceId }) {
  const k = Number(kg) || 0;
  const unit = Number(unitCostNgnPerKg) || 0;
  const amt = Math.round(k * unit);
  if (amt <= 0) return { ok: true, skipped: true, reason: 'no_unit_cost_or_zero' };
  const sid = String(sourceId || '').trim() || `scrap-${coilNo}-${entryDateISO}-${Math.round(k * 100)}`;
  try {
    return postBalancedJournalTx(db, {
      entryDateISO,
      memo: `Coil scrap ${coilNo} (${k} kg)`,
      sourceKind: 'COIL_SCRAP_GL',
      sourceId: sid,
      branchId,
      createdByUserId,
      lines: [
        { accountCode: '5000', debitNgn: amt, memo: coilNo },
        { accountCode: '1300', creditNgn: amt, memo: coilNo },
      ],
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Perpetual inventory qty variance (manual adjust or month-end count).
 * Shortage (qty decrease / book &gt; count): Dr 5055 / Cr 1300.
 * Surplus (qty increase / count &gt; book): Dr 1300 / Cr 5055.
 * Skips when amount is 0.
 */
export function tryPostInventoryVarianceJournal(db, {
  entryDateISO,
  amountNgn,
  direction,
  branchId,
  createdByUserId,
  sourceId,
  memo,
  sourceKind = 'INVENTORY_VARIANCE_GL',
}) {
  try {
    ensureSupplementalGlAccounts(db);
  } catch (e) {
    return { ok: false, error: `Could not ensure GL accounts: ${String(e.message || e)}` };
  }
  const amt = Math.round(Math.abs(Number(amountNgn) || 0));
  if (amt <= 0) return { ok: true, skipped: true, reason: 'zero_amount' };
  const sid = String(sourceId || '').trim().slice(0, 120);
  if (!sid) return { ok: false, error: 'sourceId required for inventory variance journal.' };
  const day = String(entryDateISO || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, error: 'Valid entryDateISO (YYYY-MM-DD) required for inventory variance journal.' };
  }
  const dir = String(direction || '').toLowerCase();
  const shortage =
    dir === 'shortage' || dir === 'decrease' || dir === 'credit_inventory' || dir === 'loss';
  const lines = shortage
    ? [
        { accountCode: '5055', debitNgn: amt, memo: sid.slice(0, 80) },
        { accountCode: '1300', creditNgn: amt, memo: sid.slice(0, 80) },
      ]
    : [
        { accountCode: '1300', debitNgn: amt, memo: sid.slice(0, 80) },
        { accountCode: '5055', creditNgn: amt, memo: sid.slice(0, 80) },
      ];
  try {
    const r = postBalancedJournalTx(db, {
      entryDateISO: day,
      memo: String(memo || `Inventory variance ${sid}`).slice(0, 500),
      sourceKind,
      sourceId: sid,
      branchId,
      createdByUserId,
      lines,
    });
    if (r && r.ok === false) return r;
    return r || { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Month-end stock register lock — posts net physical-count variance only.
 * Full closing value is stored on the period (perpetual 1300 already holds receipts less COGS;
 * capitalising full closing again would double-count).
 * @param {{ sourceIdSuffix?: string }} [extra] Unique suffix so reopen→re-capture can post a new variance.
 */
export function tryPostStockRegisterClosingJournal(db, {
  entryDateISO,
  branchId,
  periodKey,
  closingValueNgn,
  varianceNgn,
  createdByUserId,
  sourceIdSuffix,
}) {
  try {
    ensureSupplementalGlAccounts(db);
  } catch (e) {
    return { ok: false, error: `Could not ensure GL accounts: ${String(e.message || e)}` };
  }
  const pk = String(periodKey || '').trim();
  const bid = String(branchId || '').trim();
  if (!pk || !bid) return { ok: false, error: 'periodKey and branchId required.' };
  const closeVal = Math.round(Number(closingValueNgn) || 0);
  const variance = Math.round(Number(varianceNgn) || 0);

  if (variance === 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'no_net_variance',
      closingValueNgn: closeVal,
      varianceNgn: 0,
      varianceJournalId: null,
    };
  }

  const suffix = String(sourceIdSuffix || Date.now()).replace(/[^\w-]/g, '').slice(0, 40);
  const varianceResult = tryPostInventoryVarianceJournal(db, {
    entryDateISO,
    amountNgn: Math.abs(variance),
    direction: variance < 0 ? 'shortage' : 'surplus',
    branchId: bid,
    createdByUserId,
    sourceId: `src-var-${bid}-${pk}-${suffix}`.slice(0, 120),
    sourceKind: 'STOCK_REGISTER_VARIANCE_GL',
    memo: `Stock register count variance ${bid} ${pk} · closing ₦${closeVal.toLocaleString('en-NG')} · variance ₦${variance}`,
  });

  return {
    ok: varianceResult.ok !== false,
    closingValueNgn: closeVal,
    varianceNgn: variance,
    varianceJournalId: varianceResult.journalId || null,
    duplicate: varianceResult.duplicate || false,
    skipped: varianceResult.skipped || false,
    error: varianceResult.error,
    results: { variance: varianceResult },
  };
}

export function listGlAccounts(db) {
  ensureGlSchema(db);
  seedDefaultGlAccounts(db);
  return db
    .prepare(`SELECT id, code, name, type, is_active AS isActive, sort_order AS sortOrder FROM gl_accounts ORDER BY sort_order, code`)
    .all();
}

/**
 * Trial balance: sum lines for journals with entry_date in [startDate, endDate] inclusive.
 * @param {{ costCenter?: string; branchScope?: 'ALL' | string; branchId?: string }} [opts] When costCenter is set, only journal lines with that cost center tag are included.
 */
export function trialBalanceRows(db, startDate, endDate, opts = {}) {
  ensureGlSchema(db);
  seedDefaultGlAccounts(db);
  const sd = String(startDate || '').slice(0, 10);
  const ed = String(endDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) {
    return { ok: false, error: 'startDate and endDate must be YYYY-MM-DD.' };
  }
  const costCenter = String(opts?.costCenter || '').trim();
  const branchScope = String(opts?.branchScope ?? opts?.branchId ?? 'ALL').trim() || 'ALL';
  const ccSql = costCenter ? ` AND TRIM(COALESCE(l.cost_center, '')) = ?` : '';
  const bp = glJournalBranchFilter(db, branchScope, 'j');
  const params = costCenter ? [sd, ed, costCenter] : [sd, ed];
  params.push(...bp.args);
  const rows = db
    .prepare(
      `SELECT a.code AS accountCode, a.name AS accountName, a.type AS accountType,
        COALESCE(SUM(x.debit_ngn), 0) AS debitNgn,
        COALESCE(SUM(x.credit_ngn), 0) AS creditNgn
       FROM gl_accounts a
       LEFT JOIN (
         SELECT l.account_id, l.debit_ngn, l.credit_ngn
         FROM gl_journal_lines l
         INNER JOIN gl_journal_entries j ON j.id = l.journal_id
         WHERE j.entry_date_iso >= ? AND j.entry_date_iso <= ?${ccSql}${bp.sql}
       ) x ON x.account_id = a.id
       WHERE a.is_active = 1
       GROUP BY a.id
       ORDER BY a.sort_order, a.code`
    )
    .all(...params);
  const detail = rows.map((r) => {
    const d = Math.round(Number(r.debitNgn) || 0);
    const c = Math.round(Number(r.creditNgn) || 0);
    return {
      accountCode: r.accountCode,
      accountName: r.accountName,
      accountType: r.accountType,
      debitNgn: d,
      creditNgn: c,
      netNgn: d - c,
    };
  });
  const totals = detail.reduce(
    (acc, r) => {
      acc.debitNgn += r.debitNgn;
      acc.creditNgn += r.creditNgn;
      return acc;
    },
    { debitNgn: 0, creditNgn: 0 }
  );
  return { ok: true, rows: detail, totals, startDate: sd, endDate: ed, costCenter: costCenter || null, branchScope };
}

/** Dr Cash, Cr AR — posted when customer receipt hits treasury (idempotent on ledger entry id). */
export function tryPostCustomerReceiptGl(
  db,
  {
    ledgerEntryId,
    amountNgn,
    entryDateISO,
    branchId,
    createdByUserId,
    quotationRef,
    customerId,
    receiptId,
    receiptAtISO,
  }
) {
  const amt = Math.round(Number(amountNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true };
  const date = String(entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid entry date for GL.' };
  const creditAccount = resolveCustomerReceiptGlCreditAccount(db, {
    quotationRef,
    entryDateISO: date,
    receiptAtISO: receiptAtISO || date,
  });
  try {
    const result = postBalancedJournalTx(db, {
      entryDateISO: date,
      memo: `Customer receipt ${ledgerEntryId}`,
      sourceKind: 'CUSTOMER_RECEIPT_GL',
      sourceId: String(ledgerEntryId),
      branchId,
      createdByUserId,
      lines: [
        { accountCode: '1000', debitNgn: amt, memo: String(ledgerEntryId) },
        { accountCode: creditAccount, creditNgn: amt, memo: String(ledgerEntryId) },
      ],
    });
    if (result.ok && result.journalId) {
      try {
        recordReceiptPolicyMetaAfterCustomerReceiptGl(
          db,
          {
            ledgerEntryId,
            amountNgn: amt,
            entryDateISO: date,
            branchId,
            createdByUserId,
            quotationRef,
            customerId,
            receiptId,
            receiptAtISO,
          },
          result
        );
      } catch (metaErr) {
        console.error('[receipt-policy-meta]', metaErr);
      }
    }
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Dr Cash, Cr Customer advances — when advance deposit hits treasury. */
export function tryPostCustomerAdvanceGl(db, { ledgerEntryId, amountNgn, entryDateISO, branchId, createdByUserId }) {
  const amt = Math.round(Number(amountNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true };
  const date = String(entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid entry date for GL.' };
  ensureSupplementalGlAccounts(db);
  try {
    return postBalancedJournalTx(db, {
      entryDateISO: date,
      memo: `Customer advance ${ledgerEntryId}`,
      sourceKind: 'CUSTOMER_ADVANCE_GL',
      sourceId: String(ledgerEntryId),
      branchId,
      createdByUserId,
      lines: [
        { accountCode: '1000', debitNgn: amt, memo: String(ledgerEntryId) },
        { accountCode: '2500', creditNgn: amt, memo: String(ledgerEntryId) },
      ],
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Reverses receipt GL (Dr original credit account, Cr Cash) when a receipt GL journal exists. */
export function tryPostCustomerReceiptReversalGl(db, payload) {
  const original = String(payload.originalReceiptLedgerId || '').trim();
  const rev = String(payload.reversalLedgerId || '').trim();
  if (!original || !rev) return { ok: true, skipped: true };
  const has = db
    .prepare(`SELECT 1 FROM gl_journal_entries WHERE source_kind = 'CUSTOMER_RECEIPT_GL' AND source_id = ?`)
    .get(original);
  if (!has) return { ok: true, skipped: true };
  const amt = Math.round(Number(payload.amountNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true };
  const date = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid reversal date for GL.' };

  const resolved = resolveReceiptReversalAccountFromMetaOrJournalLines(db, original);
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.message,
      code: resolved.reasonCode,
      requiresManualReview: true,
    };
  }

  const debitAccount = resolved.accountCode;
  const memoBase = `Reverse receipt GL ${original}`;
  const memo =
    resolved.warning || resolved.source !== 'metadata'
      ? `${memoBase} [${resolved.source}${resolved.warning ? `: ${resolved.warning}` : ''}]`
      : memoBase;

  try {
    const result = postBalancedJournalTx(db, {
      entryDateISO: date,
      memo,
      sourceKind: 'CUSTOMER_RECEIPT_REV_GL',
      sourceId: rev,
      branchId: payload.branchId ?? null,
      createdByUserId: payload.createdByUserId ?? null,
      lines: [
        { accountCode: debitAccount, debitNgn: amt, memo: `Rev ${original}` },
        { accountCode: '1000', creditNgn: amt, memo: `Rev ${original}` },
      ],
    });
    if (result.ok) {
      result.reversalAccountCode = debitAccount;
      result.reversalAccountSource = resolved.source;
      if (resolved.warning) result.reversalWarning = resolved.warning;
    }
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Reverses advance GL (Dr advances, Cr cash) when an advance GL journal exists for the original entry. */
export function tryPostCustomerAdvanceReversalGl(db, payload) {
  const original = String(payload.originalAdvanceLedgerId || '').trim();
  const rev = String(payload.reversalLedgerId || '').trim();
  if (!original || !rev) return { ok: true, skipped: true };
  const has = db
    .prepare(`SELECT 1 FROM gl_journal_entries WHERE source_kind = 'CUSTOMER_ADVANCE_GL' AND source_id = ?`)
    .get(original);
  if (!has) return { ok: true, skipped: true };
  const amt = Math.round(Number(payload.amountNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true };
  const date = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid reversal date for GL.' };
  ensureSupplementalGlAccounts(db);
  try {
    return postBalancedJournalTx(db, {
      entryDateISO: date,
      memo: `Reverse customer advance GL ${original}`,
      sourceKind: 'CUSTOMER_ADVANCE_REV_GL',
      sourceId: rev,
      branchId: payload.branchId ?? null,
      createdByUserId: payload.createdByUserId ?? null,
      lines: [
        { accountCode: '2500', debitNgn: amt, memo: `Rev ${original}` },
        { accountCode: '1000', creditNgn: amt, memo: `Rev ${original}` },
      ],
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Cash refund to customer: reduce customer advances (2500) and cash (1000).
 * Idempotent per payout slice via source_id = refundId:paid:cumulativePaidNgn.
 */
export function tryPostCustomerRefundPayoutGlTx(db, payload) {
  const refundId = String(payload.refundId || '').trim();
  const amt = Math.round(Number(payload.payoutAmountNgn) || 0);
  const cum = Math.round(Number(payload.cumulativePaidNgn) || 0);
  if (!refundId || amt <= 0) return { ok: true, skipped: true };
  const date = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid refund GL date.' };
  ensureSupplementalGlAccounts(db);
  const revenueReview = Boolean(payload.needsRevenueReview);
  const memo = revenueReview
    ? `Customer refund payout ${refundId} [AP1c-4: post-production — revenue/AR review may be required]`
    : `Customer refund payout ${refundId}`;
  const result = postBalancedJournalTx(db, {
    entryDateISO: date,
    memo,
    sourceKind: 'CUSTOMER_REFUND_PAYOUT_GL',
    sourceId: `${refundId}:paid:${cum}`,
    branchId: payload.branchId ?? null,
    createdByUserId: payload.createdByUserId ?? null,
    lines: [
      { accountCode: '2500', debitNgn: amt, memo: refundId },
      { accountCode: '1000', creditNgn: amt, memo: refundId },
    ],
  });
  if (result.ok && revenueReview) {
    result.refundPayoutGlWarning =
      'Post-production refund: payout debits 2500 only; revenue/AR correction is not automated in AP1c-4.';
  }
  return result;
}

/**
 * Full reversal of recorded customer-refund treasury payouts: undo GL accrual (2500/1000) for the net paid amount.
 * Idempotent via `source_id = refundId:full` (second call returns duplicate).
 * @param {import('better-sqlite3').Database} db
 * @param {{ refundId: string, reversalAmountNgn: number, entryDateISO: string, branchId?: string|null, createdByUserId?: string|null }} payload
 */
export function tryPostCustomerRefundPayoutReversalGlTx(db, payload) {
  const refundId = String(payload.refundId || '').trim();
  const amt = Math.round(Number(payload.reversalAmountNgn) || 0);
  if (!refundId || amt <= 0) return { ok: true, skipped: true };
  const date = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid refund GL reversal date.' };
  ensureSupplementalGlAccounts(db);
  return postBalancedJournalTx(db, {
    entryDateISO: date,
    memo: `Reverse customer refund payout ${refundId}`,
    sourceKind: 'CUSTOMER_REFUND_PAYOUT_REVERSAL_GL',
    sourceId: `${refundId}:full`,
    branchId: payload.branchId ?? null,
    createdByUserId: payload.createdByUserId ?? null,
    lines: [
      { accountCode: '2500', creditNgn: amt, memo: refundId },
      { accountCode: '1000', debitNgn: amt, memo: refundId },
    ],
  });
}

/** Dr Cash (1000), Cr suspense (2150) — when Finance registers an unlinked bank deposit. */
export function tryPostBankDepositRegisterGl(db, payload) {
  const depositId = String(payload.depositId || '').trim();
  const amt = Math.round(Number(payload.amountNgn) || 0);
  if (!depositId || amt <= 0) return { ok: true, skipped: true };
  const date = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid bank deposit GL date.' };
  ensureSupplementalGlAccounts(db);
  try {
    return postBalancedJournalTx(db, {
      entryDateISO: date,
      memo: `Unlinked bank deposit ${depositId}`,
      sourceKind: 'BANK_DEPOSIT_REGISTER_GL',
      sourceId: depositId,
      branchId: payload.branchId ?? null,
      createdByUserId: payload.createdByUserId ?? null,
      lines: [
        { accountCode: '1000', debitNgn: amt, memo: depositId },
        { accountCode: '2150', creditNgn: amt, memo: depositId },
      ],
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Dr suspense (2150), Cr AR/advances — when deposit is linked to a customer receipt or advance. */
export function tryPostBankDepositAllocationGl(db, payload) {
  const depositId = String(payload.depositId || '').trim();
  const ledgerEntryId = String(payload.ledgerEntryId || '').trim();
  const allocId = String(payload.allocationId || `${depositId}:${ledgerEntryId}`).trim();
  const amt = Math.round(Number(payload.amountNgn) || 0);
  if (!depositId || !ledgerEntryId || amt <= 0) return { ok: true, skipped: true };
  const date = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid allocation GL date.' };
  ensureSupplementalGlAccounts(db);
  const kind = String(payload.allocKind || '').trim().toLowerCase();
  let creditAccount = '1200';
  if (kind === 'advance') {
    creditAccount = '2500';
  } else {
    const le = db.prepare(`SELECT quotation_ref, at_iso FROM ledger_entries WHERE id = ?`).get(ledgerEntryId);
    creditAccount = resolveCustomerReceiptGlCreditAccount(db, {
      quotationRef: le?.quotation_ref,
      entryDateISO: date,
      receiptAtISO: le?.at_iso || date,
    });
  }
  try {
    return postBalancedJournalTx(db, {
      entryDateISO: date,
      memo: `Link bank deposit ${depositId} to ${ledgerEntryId}`,
      sourceKind: 'BANK_DEPOSIT_ALLOC_GL',
      sourceId: allocId,
      branchId: payload.branchId ?? null,
      createdByUserId: payload.createdByUserId ?? null,
      lines: [
        { accountCode: '2150', debitNgn: amt, memo: ledgerEntryId },
        { accountCode: creditAccount, creditNgn: amt, memo: ledgerEntryId },
      ],
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Reverse register GL (Dr 2150, Cr 1000) when an unlinked deposit is reversed. */
export function tryPostBankDepositReverseGl(db, payload) {
  const depositId = String(payload.depositId || '').trim();
  const amt = Math.round(Number(payload.amountNgn) || 0);
  if (!depositId || amt <= 0) return { ok: true, skipped: true };
  const has = db
    .prepare(`SELECT 1 FROM gl_journal_entries WHERE source_kind = 'BANK_DEPOSIT_REGISTER_GL' AND source_id = ?`)
    .get(depositId);
  if (!has) return { ok: true, skipped: true };
  const date = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid reverse GL date.' };
  ensureSupplementalGlAccounts(db);
  try {
    return postBalancedJournalTx(db, {
      entryDateISO: date,
      memo: `Reverse unlinked bank deposit ${depositId}`,
      sourceKind: 'BANK_DEPOSIT_REVERSE_GL',
      sourceId: depositId,
      branchId: payload.branchId ?? null,
      createdByUserId: payload.createdByUserId ?? null,
      lines: [
        { accountCode: '2150', debitNgn: amt, memo: depositId },
        { accountCode: '1000', creditNgn: amt, memo: depositId },
      ],
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Move suspense to final account when deposit is not a customer payment. */
export function tryPostBankDepositReclassGl(db, payload) {
  const depositId = String(payload.depositId || '').trim();
  const amt = Math.round(Number(payload.amountNgn) || 0);
  const creditAccount = String(payload.creditAccountCode || '').trim();
  if (!depositId || amt <= 0 || !creditAccount) return { ok: true, skipped: true };
  const has = db
    .prepare(`SELECT 1 FROM gl_journal_entries WHERE source_kind = 'BANK_DEPOSIT_REGISTER_GL' AND source_id = ?`)
    .get(depositId);
  if (!has) return { ok: true, skipped: true };
  const date = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid reclass GL date.' };
  ensureSupplementalGlAccounts(db);
  try {
    return postBalancedJournalTx(db, {
      entryDateISO: date,
      memo: payload.memo || `Reclass bank deposit ${depositId}`,
      sourceKind: 'BANK_DEPOSIT_RECLASS_GL',
      sourceId: depositId,
      branchId: payload.branchId ?? null,
      createdByUserId: payload.createdByUserId ?? null,
      lines: [
        { accountCode: '2150', debitNgn: amt, memo: depositId },
        { accountCode: creditAccount, creditNgn: amt, memo: depositId },
      ],
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Undo duplicate receipt cash GL after merge (Dr AR/adv, Cr 1000). */
export function tryPostBankDepositMergeDuplicateReceiptGl(db, payload) {
  const ledgerEntryId = String(payload.ledgerEntryId || '').trim();
  const depositId = String(payload.depositId || '').trim();
  const mergeId = `${depositId}:${ledgerEntryId}`;
  if (!ledgerEntryId || !depositId) return { ok: true, skipped: true };
  const has = db
    .prepare(`SELECT 1 FROM gl_journal_entries WHERE source_kind = 'CUSTOMER_RECEIPT_GL' AND source_id = ?`)
    .get(ledgerEntryId);
  if (!has) return { ok: true, skipped: true };
  const amt = Math.round(Number(payload.amountNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true };
  const date = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid merge GL date.' };
  const resolved = resolveReceiptReversalAccountFromMetaOrJournalLines(db, ledgerEntryId);
  if (!resolved.ok) {
    return { ok: false, error: resolved.message, code: resolved.reasonCode, requiresManualReview: true };
  }
  ensureSupplementalGlAccounts(db);
  try {
    return postBalancedJournalTx(db, {
      entryDateISO: date,
      memo: `Merge duplicate receipt cash ${ledgerEntryId} → ${depositId}`,
      sourceKind: 'BANK_DEPOSIT_MERGE_RECEIPT_GL',
      sourceId: mergeId,
      branchId: payload.branchId ?? null,
      createdByUserId: payload.createdByUserId ?? null,
      lines: [
        { accountCode: resolved.accountCode, debitNgn: amt, memo: ledgerEntryId },
        { accountCode: '1000', creditNgn: amt, memo: ledgerEntryId },
      ],
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Undo duplicate advance cash GL after merge (Dr 2500, Cr 1000). */
export function tryPostBankDepositMergeDuplicateAdvanceGl(db, payload) {
  const ledgerEntryId = String(payload.ledgerEntryId || '').trim();
  const depositId = String(payload.depositId || '').trim();
  const mergeId = `${depositId}:${ledgerEntryId}`;
  if (!ledgerEntryId || !depositId) return { ok: true, skipped: true };
  const has = db
    .prepare(`SELECT 1 FROM gl_journal_entries WHERE source_kind = 'CUSTOMER_ADVANCE_GL' AND source_id = ?`)
    .get(ledgerEntryId);
  if (!has) return { ok: true, skipped: true };
  const amt = Math.round(Number(payload.amountNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true };
  const date = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid merge GL date.' };
  ensureSupplementalGlAccounts(db);
  try {
    return postBalancedJournalTx(db, {
      entryDateISO: date,
      memo: `Merge duplicate advance cash ${ledgerEntryId} → ${depositId}`,
      sourceKind: 'BANK_DEPOSIT_MERGE_ADVANCE_GL',
      sourceId: mergeId,
      branchId: payload.branchId ?? null,
      createdByUserId: payload.createdByUserId ?? null,
      lines: [
        { accountCode: '2500', debitNgn: amt, memo: ledgerEntryId },
        { accountCode: '1000', creditNgn: amt, memo: ledgerEntryId },
      ],
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Bounded GL journal rows for workspace search bootstrap / offline cache. */
export function listGlJournalsForWorkspaceSearch(db, branchScope = 'ALL', opts = {}) {
  seedDefaultGlAccounts(db);
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='gl_journal_entries'`).get()) {
    return [];
  }
  const limit = Math.min(2000, Math.max(50, Number(opts?.limit) || 800));
  const bp = glJournalBranchFilter(db, branchScope, 'j');
  return db
    .prepare(
      `SELECT j.id, j.entry_date_iso, IFNULL(j.memo,'') AS memo, IFNULL(j.source_id,'') AS source_id
       FROM gl_journal_entries j WHERE 1=1${bp.sql}
       ORDER BY j.entry_date_iso DESC, j.id DESC LIMIT ?`
    )
    .all(...bp.args, limit)
    .map((row) => ({
      id: row.id,
      entryDateISO: row.entry_date_iso,
      memo: row.memo || '',
      sourceId: row.source_id || '',
    }));
}

export function listGlJournalEntries(db, startDate, endDate, opts = {}) {
  seedDefaultGlAccounts(db);
  const sd = String(startDate || '').slice(0, 10);
  const ed = String(endDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) {
    return { ok: false, error: 'startDate and endDate must be YYYY-MM-DD.' };
  }
  const branchScope = String(opts?.branchScope ?? opts?.branchId ?? 'ALL').trim() || 'ALL';
  const bp = glJournalBranchFilter(db, branchScope, 'j');
  const rows = db
    .prepare(
      `SELECT j.id AS journalId, j.entry_date_iso AS entryDateISO, j.period_key AS periodKey, j.memo,
        j.source_kind AS sourceKind, j.source_id AS sourceId, j.branch_id AS branchId,
        COALESCE(SUM(l.debit_ngn), 0) AS totalDebitNgn,
        COALESCE(SUM(l.credit_ngn), 0) AS totalCreditNgn
       FROM gl_journal_entries j
       LEFT JOIN gl_journal_lines l ON l.journal_id = j.id
       WHERE j.entry_date_iso >= ? AND j.entry_date_iso <= ?${bp.sql}
       GROUP BY j.id
       ORDER BY j.entry_date_iso ASC, j.id ASC`
    )
    .all(sd, ed, ...bp.args);
  const journals = rows.map((r) => ({
    journalId: r.journalId,
    entryDateISO: r.entryDateISO,
    periodKey: r.periodKey,
    memo: r.memo ?? '',
    sourceKind: r.sourceKind ?? '',
    sourceId: r.sourceId ?? '',
    branchId: String(r.branchId ?? '').trim(),
    totalDebitNgn: Math.round(Number(r.totalDebitNgn) || 0),
    totalCreditNgn: Math.round(Number(r.totalCreditNgn) || 0),
  }));
  return { ok: true, journals, startDate: sd, endDate: ed, branchScope };
}

export function listGlJournalLinesForJournal(db, journalId) {
  seedDefaultGlAccounts(db);
  const jid = String(journalId || '').trim();
  if (!jid) return { ok: false, error: 'journalId is required.' };
  const rows = db
    .prepare(
      `SELECT l.id AS lineId, a.code AS accountCode, a.name AS accountName,
        l.debit_ngn AS debitNgn, l.credit_ngn AS creditNgn, l.memo AS lineMemo,
        TRIM(COALESCE(l.cost_center, '')) AS costCenter
       FROM gl_journal_lines l
       JOIN gl_accounts a ON a.id = l.account_id
       WHERE l.journal_id = ?
       ORDER BY l.id`
    )
    .all(jid);
  return { ok: true, lines: rows };
}

export function listGlActivityLines(db, startDate, endDate, opts = {}) {
  seedDefaultGlAccounts(db);
  const sd = String(startDate || '').slice(0, 10);
  const ed = String(endDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) {
    return { ok: false, error: 'startDate and endDate must be YYYY-MM-DD.' };
  }
  const costCenter = String(opts?.costCenter || '').trim();
  const branchScope = String(opts?.branchScope ?? opts?.branchId ?? 'ALL').trim() || 'ALL';
  const ccSql = costCenter ? ` AND TRIM(COALESCE(l.cost_center, '')) = ?` : '';
  const bp = glJournalBranchFilter(db, branchScope, 'j');
  const params = costCenter ? [sd, ed, costCenter] : [sd, ed];
  params.push(...bp.args);
  const maxLines = Math.min(
    50_000,
    Math.max(500, Number(process.env.ZAREWA_GL_ACTIVITY_LIMIT) || 10_000)
  );
  const rows = db
    .prepare(
      `SELECT j.entry_date_iso AS entryDateISO, j.id AS journalId, j.memo AS journalMemo,
        j.source_kind AS sourceKind, j.source_id AS sourceId, j.branch_id AS branchId,
        a.code AS accountCode, a.name AS accountName,
        l.debit_ngn AS debitNgn, l.credit_ngn AS creditNgn, l.memo AS lineMemo,
        TRIM(COALESCE(l.cost_center, '')) AS costCenter
       FROM gl_journal_lines l
       JOIN gl_journal_entries j ON j.id = l.journal_id
       JOIN gl_accounts a ON a.id = l.account_id
       WHERE j.entry_date_iso >= ? AND j.entry_date_iso <= ?${ccSql}${bp.sql}
       ORDER BY j.entry_date_iso, j.id, l.id
       LIMIT ?`
    )
    .all(...params, maxLines + 1);
  const truncated = rows.length > maxLines;
  const lines = truncated ? rows.slice(0, maxLines) : rows;
  return {
    ok: true,
    lines,
    truncated,
    limit: maxLines,
    startDate: sd,
    endDate: ed,
    costCenter: costCenter || null,
    branchScope,
  };
}
