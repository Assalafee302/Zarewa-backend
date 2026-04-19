/**
 * General ledger: chart of accounts, journals, trial balance, minimal auto-posting hooks.
 * @param {import('better-sqlite3').Database} db
 */

import { DEFAULT_BRANCH_ID } from './branches.js';
import { assertPeriodOpen } from './controlOps.js';
import { nextGlJournalHumanId, nextGlJournalLineHumanId } from './humanId.js';

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
      FOREIGN KEY (journal_id) REFERENCES gl_journal_entries(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES gl_accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_gl_lines_journal ON gl_journal_lines(journal_id);
    CREATE INDEX IF NOT EXISTS idx_gl_lines_account ON gl_journal_lines(account_id);
  `);
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
  ensureGlSchema(db);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES (?,?,?,?,1,?)`
  );
  ins.run('acc-adv', '2500', 'Customer advances / deposits', 'liability', 75);
  ins.run('acc-revenue', '4000', 'Sales revenue (management)', 'revenue', 35);
  ins.run('acc-accum-dep', '1398', 'Accumulated depreciation', 'asset', 31);
  ins.run('acc-dep-exp', '6100', 'Depreciation expense', 'expense', 92);
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
  ensureGlSchema(db);
  seedDefaultGlAccounts(db);
  const lines = payload.lines || [];
  let deb = 0;
  let cred = 0;
  for (const l of lines) {
    deb += Math.round(Number(l.debitNgn) || 0);
    cred += Math.round(Number(l.creditNgn) || 0);
  }
  if (deb !== cred) return { ok: false, error: 'Journal debits and credits must balance.' };
  if (deb <= 0) return { ok: false, error: 'Journal total must be positive.' };

  const entryDate = String(payload.entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return { ok: false, error: 'Invalid entry date.' };

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
    `INSERT INTO gl_journal_lines (id, journal_id, account_id, debit_ngn, credit_ngn, memo) VALUES (?,?,?,?,?,?)`
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
    insL.run(nextGlJournalLineHumanId(db, branchForJe), jid, aid, d, c, l.memo ?? null);
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
      if (!result.ok) throw new Error(result.error);
    })();
    return result;
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes('Unknown GL account') || msg.includes('Journal') || msg.includes('Invalid')) {
      return { ok: false, error: msg };
    }
    return { ok: false, error: msg };
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

export function listGlAccounts(db) {
  ensureGlSchema(db);
  seedDefaultGlAccounts(db);
  return db
    .prepare(`SELECT id, code, name, type, is_active AS isActive, sort_order AS sortOrder FROM gl_accounts ORDER BY sort_order, code`)
    .all();
}

/**
 * Trial balance: sum lines for journals with entry_date in [startDate, endDate] inclusive.
 */
export function trialBalanceRows(db, startDate, endDate) {
  ensureGlSchema(db);
  seedDefaultGlAccounts(db);
  const sd = String(startDate || '').slice(0, 10);
  const ed = String(endDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) {
    return { ok: false, error: 'startDate and endDate must be YYYY-MM-DD.' };
  }
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
         WHERE j.entry_date_iso >= ? AND j.entry_date_iso <= ?
       ) x ON x.account_id = a.id
       WHERE a.is_active = 1
       GROUP BY a.id
       ORDER BY a.sort_order, a.code`
    )
    .all(sd, ed);
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
  return { ok: true, rows: detail, totals, startDate: sd, endDate: ed };
}

/** Dr Cash, Cr AR — posted when customer receipt hits treasury (idempotent on ledger entry id). */
export function tryPostCustomerReceiptGl(db, { ledgerEntryId, amountNgn, entryDateISO, branchId, createdByUserId }) {
  const amt = Math.round(Number(amountNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true };
  const date = String(entryDateISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid entry date for GL.' };
  try {
    return postBalancedJournalTx(db, {
      entryDateISO: date,
      memo: `Customer receipt ${ledgerEntryId}`,
      sourceKind: 'CUSTOMER_RECEIPT_GL',
      sourceId: String(ledgerEntryId),
      branchId,
      createdByUserId,
      lines: [
        { accountCode: '1000', debitNgn: amt, memo: String(ledgerEntryId) },
        { accountCode: '1200', creditNgn: amt, memo: String(ledgerEntryId) },
      ],
    });
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

/** Reverses receipt GL (Dr AR, Cr Cash) when a receipt GL journal exists for the original entry. */
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
  try {
    return postBalancedJournalTx(db, {
      entryDateISO: date,
      memo: `Reverse receipt GL ${original}`,
      sourceKind: 'CUSTOMER_RECEIPT_REV_GL',
      sourceId: rev,
      branchId: payload.branchId ?? null,
      createdByUserId: payload.createdByUserId ?? null,
      lines: [
        { accountCode: '1200', debitNgn: amt, memo: `Rev ${original}` },
        { accountCode: '1000', creditNgn: amt, memo: `Rev ${original}` },
      ],
    });
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
  return postBalancedJournalTx(db, {
    entryDateISO: date,
    memo: `Customer refund payout ${refundId}`,
    sourceKind: 'CUSTOMER_REFUND_PAYOUT_GL',
    sourceId: `${refundId}:paid:${cum}`,
    branchId: payload.branchId ?? null,
    createdByUserId: payload.createdByUserId ?? null,
    lines: [
      { accountCode: '2500', debitNgn: amt, memo: refundId },
      { accountCode: '1000', creditNgn: amt, memo: refundId },
    ],
  });
}

export function listGlJournalEntries(db, startDate, endDate) {
  seedDefaultGlAccounts(db);
  const sd = String(startDate || '').slice(0, 10);
  const ed = String(endDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) {
    return { ok: false, error: 'startDate and endDate must be YYYY-MM-DD.' };
  }
  const rows = db
    .prepare(
      `SELECT j.id AS journalId, j.entry_date_iso AS entryDateISO, j.period_key AS periodKey, j.memo,
        j.source_kind AS sourceKind, j.source_id AS sourceId,
        COALESCE(SUM(l.debit_ngn), 0) AS totalDebitNgn,
        COALESCE(SUM(l.credit_ngn), 0) AS totalCreditNgn
       FROM gl_journal_entries j
       LEFT JOIN gl_journal_lines l ON l.journal_id = j.id
       WHERE j.entry_date_iso >= ? AND j.entry_date_iso <= ?
       GROUP BY j.id
       ORDER BY j.entry_date_iso ASC, j.id ASC`
    )
    .all(sd, ed);
  const journals = rows.map((r) => ({
    journalId: r.journalId,
    entryDateISO: r.entryDateISO,
    periodKey: r.periodKey,
    memo: r.memo ?? '',
    sourceKind: r.sourceKind ?? '',
    sourceId: r.sourceId ?? '',
    totalDebitNgn: Math.round(Number(r.totalDebitNgn) || 0),
    totalCreditNgn: Math.round(Number(r.totalCreditNgn) || 0),
  }));
  return { ok: true, journals, startDate: sd, endDate: ed };
}

export function listGlJournalLinesForJournal(db, journalId) {
  seedDefaultGlAccounts(db);
  const jid = String(journalId || '').trim();
  if (!jid) return { ok: false, error: 'journalId is required.' };
  const rows = db
    .prepare(
      `SELECT l.id AS lineId, a.code AS accountCode, a.name AS accountName,
        l.debit_ngn AS debitNgn, l.credit_ngn AS creditNgn, l.memo AS lineMemo
       FROM gl_journal_lines l
       JOIN gl_accounts a ON a.id = l.account_id
       WHERE l.journal_id = ?
       ORDER BY l.id`
    )
    .all(jid);
  return { ok: true, lines: rows };
}

export function listGlActivityLines(db, startDate, endDate) {
  seedDefaultGlAccounts(db);
  const sd = String(startDate || '').slice(0, 10);
  const ed = String(endDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) {
    return { ok: false, error: 'startDate and endDate must be YYYY-MM-DD.' };
  }
  const rows = db
    .prepare(
      `SELECT j.entry_date_iso AS entryDateISO, j.id AS journalId, j.memo AS journalMemo,
        j.source_kind AS sourceKind, j.source_id AS sourceId,
        a.code AS accountCode, a.name AS accountName,
        l.debit_ngn AS debitNgn, l.credit_ngn AS creditNgn, l.memo AS lineMemo
       FROM gl_journal_lines l
       JOIN gl_journal_entries j ON j.id = l.journal_id
       JOIN gl_accounts a ON a.id = l.account_id
       WHERE j.entry_date_iso >= ? AND j.entry_date_iso <= ?
       ORDER BY j.entry_date_iso, j.id, l.id`
    )
    .all(sd, ed);
  return { ok: true, lines: rows, startDate: sd, endDate: ed };
}
