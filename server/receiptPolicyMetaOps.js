/**
 * AP1c-1 — receipt GL policy metadata (tagging only; does not change journal lines or accounts).
 */
import { firstProductionDateISO } from '../shared/lib/customerLedgerCore.js';
import { productionStatusAtReceipt } from '../shared/lib/ap1cSimulator.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import { listProductionJobs } from './readModel.js';

/** @typedef {'legacy_ar_at_receipt' | 'policy_v1_deposit_before_production' | 'policy_v1_ar_after_production' | 'unknown'} ReceiptPolicyBasis */
/** @typedef {'1200' | '2500'} ReceiptCreditedAccountCode */

export const RECEIPT_POLICY_BASIS = {
  LEGACY_AR: 'legacy_ar_at_receipt',
  V1_DEPOSIT: 'policy_v1_deposit_before_production',
  V1_AR: 'policy_v1_ar_after_production',
  UNKNOWN: 'unknown',
};

function tableExists(db, name) {
  const n = String(name || '').trim();
  if (!n) return false;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`
      )
      .get(n);
    if (row) return true;
  } catch {
    /* SQLite */
  }
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(n));
  } catch {
    return false;
  }
}

export function receiptPolicyMetaTableExists(db) {
  return tableExists(db, 'gl_receipt_policy_meta');
}

/** Idempotent schema + backfill for existing CUSTOMER_RECEIPT_GL journals. */
export function migrateGlReceiptPolicyMeta(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gl_receipt_policy_meta (
      id TEXT PRIMARY KEY,
      journal_id TEXT NOT NULL,
      ledger_entry_id TEXT,
      receipt_id TEXT,
      quotation_ref TEXT,
      customer_id TEXT,
      branch_id TEXT,
      policy_basis TEXT NOT NULL,
      credited_account_code TEXT NOT NULL,
      production_completed_at_receipt INTEGER,
      amount_ngn INTEGER NOT NULL DEFAULT 0,
      posted_at_iso TEXT,
      created_at_iso TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gl_receipt_policy_meta_journal ON gl_receipt_policy_meta(journal_id);
    CREATE INDEX IF NOT EXISTS idx_gl_receipt_policy_meta_ledger ON gl_receipt_policy_meta(ledger_entry_id);
    CREATE INDEX IF NOT EXISTS idx_gl_receipt_policy_meta_quotation ON gl_receipt_policy_meta(quotation_ref);
    CREATE INDEX IF NOT EXISTS idx_gl_receipt_policy_meta_credited ON gl_receipt_policy_meta(credited_account_code);
    CREATE INDEX IF NOT EXISTS idx_gl_receipt_policy_meta_basis ON gl_receipt_policy_meta(policy_basis);
  `);
  backfillReceiptPolicyMeta(db);
}

/**
 * @param {Array<{ accountCode?: string, creditNgn?: number, debitNgn?: number }>} journalLines
 * @returns {{ creditedAccountCode: ReceiptCreditedAccountCode | null, creditNgn: number }}
 */
export function findReceiptGlCreditedAccountFromLines(journalLines) {
  let creditNgn = 0;
  /** @type {ReceiptCreditedAccountCode | null} */
  let creditedAccountCode = null;
  for (const ln of journalLines || []) {
    const code = String(ln.accountCode || '').trim();
    const cr = Math.round(Number(ln.creditNgn) || 0);
    if (cr > 0 && (code === '1200' || code === '2500')) {
      creditedAccountCode = /** @type {ReceiptCreditedAccountCode} */ (code);
      creditNgn = Math.max(creditNgn, cr);
    }
  }
  return { creditedAccountCode, creditNgn };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} journalId
 */
export function loadJournalLinesForReceiptMeta(db, journalId) {
  if (!tableExists(db, 'gl_journal_lines') || !tableExists(db, 'gl_accounts')) return [];
  return db
    .prepare(
      `SELECT ga.code AS accountCode, jl.credit_ngn AS creditNgn, jl.debit_ngn AS debitNgn
       FROM gl_journal_lines jl
       INNER JOIN gl_accounts ga ON ga.id = jl.account_id
       WHERE jl.journal_id = ?`
    )
    .all(journalId)
    .map((r) => ({
      accountCode: r.accountCode,
      creditNgn: r.creditNgn,
      debitNgn: r.debitNgn,
    }));
}

/**
 * @param {string} quotationRef
 * @param {string} receiptAtISO
 * @param {Array<{ status?: string, quotationRef?: string, actualMeters?: number, completedAtISO?: string, endDateISO?: string }>} productionJobs
 * @returns {boolean | null} true = production complete at receipt, false = not, null = unknown
 */
export function inferProductionCompletedAtReceipt(quotationRef, receiptAtISO, productionJobs = []) {
  const qref = String(quotationRef || '').trim();
  if (!qref) return null;
  const firstProd = firstProductionDateISO(qref, productionJobs);
  if (!firstProd) return false;
  const receiptDay = String(receiptAtISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDay)) {
    const phase = productionStatusAtReceipt(qref, receiptAtISO, productionJobs);
    if (phase === 'post_production') return true;
    if (phase === 'pre_production') return false;
    return null;
  }
  return receiptDay >= firstProd;
}

/**
 * @param {{
 *   creditedAccountCode: ReceiptCreditedAccountCode | null,
 *   productionCompletedAtReceipt: boolean | null,
 *   postingUsesPolicyV1ReceiptGl?: boolean,
 * }} ctx
 * @returns {ReceiptPolicyBasis}
 */
export function resolveReceiptPolicyBasis(ctx) {
  const code = ctx.creditedAccountCode;
  const prod = ctx.productionCompletedAtReceipt;
  if (!code) return RECEIPT_POLICY_BASIS.UNKNOWN;
  if (prod === null) return RECEIPT_POLICY_BASIS.UNKNOWN;

  if (code === '2500' && prod === false) return RECEIPT_POLICY_BASIS.V1_DEPOSIT;
  if (code === '1200' && prod === true) return RECEIPT_POLICY_BASIS.V1_AR;

  if (code === '1200' && prod === false) {
    return ctx.postingUsesPolicyV1ReceiptGl
      ? RECEIPT_POLICY_BASIS.UNKNOWN
      : RECEIPT_POLICY_BASIS.LEGACY_AR;
  }
  if (code === '2500' && prod === true) return RECEIPT_POLICY_BASIS.UNKNOWN;
  return RECEIPT_POLICY_BASIS.UNKNOWN;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} journalId
 */
export function getReceiptPolicyMetaByJournalId(db, journalId) {
  if (!receiptPolicyMetaTableExists(db)) return null;
  const jid = String(journalId || '').trim();
  if (!jid) return null;
  return db.prepare(`SELECT * FROM gl_receipt_policy_meta WHERE journal_id = ?`).get(jid) || null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} ledgerEntryId
 */
export function getReceiptPolicyMetaByLedgerEntryId(db, ledgerEntryId) {
  if (!receiptPolicyMetaTableExists(db)) return null;
  const lid = String(ledgerEntryId || '').trim();
  if (!lid) return null;
  return db.prepare(`SELECT * FROM gl_receipt_policy_meta WHERE ledger_entry_id = ?`).get(lid) || null;
}

/**
 * @param {object} row
 */
export function mapReceiptPolicyMetaRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    journalId: row.journal_id,
    ledgerEntryId: row.ledger_entry_id,
    receiptId: row.receipt_id,
    quotationRef: row.quotation_ref,
    customerId: row.customer_id,
    branchId: row.branch_id,
    policyBasis: row.policy_basis,
    creditedAccountCode: row.credited_account_code,
    productionCompletedAtReceipt:
      row.production_completed_at_receipt == null
        ? null
        : Number(row.production_completed_at_receipt) === 1,
    amountNgn: Math.round(Number(row.amount_ngn) || 0),
    postedAtISO: row.posted_at_iso,
    createdAtISO: row.created_at_iso,
  };
}

/**
 * Dry-run classification from stored metadata (preferred over journal inference).
 * @param {ReturnType<mapReceiptPolicyMetaRow>} meta
 */
export function classifyFromReceiptPolicyMeta(meta) {
  if (!meta) return { ok: false, warning: 'no_meta' };
  const preProd = meta.productionCompletedAtReceipt === false;
  const isLegacy =
    meta.policyBasis === RECEIPT_POLICY_BASIS.LEGACY_AR ||
    (preProd && meta.creditedAccountCode === '1200');
  return {
    ok: true,
    quotationRef: meta.quotationRef,
    amountNgn: meta.amountNgn,
    productionPhaseAtReceipt: preProd ? 'pre_production' : meta.productionCompletedAtReceipt ? 'post_production' : 'unknown',
    policyCreditAccount: preProd ? '2500' : '1200',
    actualCreditAccount: meta.creditedAccountCode,
    actualCreditNgn: meta.amountNgn,
    policyBasis: meta.policyBasis,
    mismatch: isLegacy,
    isLegacyPreProd1200: isLegacy && meta.creditedAccountCode === '1200',
    legacyBridgeNgn: isLegacy && meta.creditedAccountCode === '1200' ? meta.amountNgn : 0,
    expected2500InsteadOf1200Ngn:
      isLegacy && meta.creditedAccountCode === '1200' ? meta.amountNgn : 0,
    source: 'metadata',
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   journalId: string,
 *   ledgerEntryId?: string | null,
 *   receiptId?: string | null,
 *   quotationRef?: string | null,
 *   customerId?: string | null,
 *   branchId?: string | null,
 *   amountNgn: number,
 *   entryDateISO?: string | null,
 *   receiptAtISO?: string | null,
 *   postedAtISO?: string | null,
 *   productionJobs?: Array<{ status?: string, quotationRef?: string, actualMeters?: number, completedAtISO?: string, endDateISO?: string }>,
 *   journalLines?: Array<{ accountCode?: string, creditNgn?: number, debitNgn?: number }>,
 *   postingUsesPolicyV1ReceiptGl?: boolean,
 * }} payload
 */
export function upsertReceiptPolicyMeta(db, payload) {
  if (!receiptPolicyMetaTableExists(db)) migrateGlReceiptPolicyMeta(db);

  const journalId = String(payload.journalId || '').trim();
  if (!journalId) return { ok: false, error: 'missing_journal_id' };

  const existing = getReceiptPolicyMetaByJournalId(db, journalId);
  if (existing) {
    return { ok: true, duplicate: true, meta: mapReceiptPolicyMetaRow(existing) };
  }

  const lines = payload.journalLines || loadJournalLinesForReceiptMeta(db, journalId);
  const { creditedAccountCode, creditNgn } = findReceiptGlCreditedAccountFromLines(lines);
  const amountNgn = Math.round(Number(payload.amountNgn) || creditNgn || 0);

  const qref = String(payload.quotationRef || '').trim();
  const receiptAtISO =
    payload.receiptAtISO || payload.entryDateISO || payload.postedAtISO || '';
  const jobs = payload.productionJobs || [];
  const prodAtReceipt = qref ? inferProductionCompletedAtReceipt(qref, receiptAtISO, jobs) : null;

  const policyBasis = resolveReceiptPolicyBasis({
    creditedAccountCode,
    productionCompletedAtReceipt: prodAtReceipt,
    postingUsesPolicyV1ReceiptGl: Boolean(payload.postingUsesPolicyV1ReceiptGl),
  });

  const now = new Date().toISOString();
  const postedAt =
    payload.postedAtISO ||
    (payload.entryDateISO ? `${String(payload.entryDateISO).slice(0, 10)}T12:00:00.000Z` : now);

  const id = `RPM-${journalId}`;
  const prodInt = prodAtReceipt === null ? null : prodAtReceipt ? 1 : 0;

  db.prepare(
    `INSERT INTO gl_receipt_policy_meta (
      id, journal_id, ledger_entry_id, receipt_id, quotation_ref, customer_id, branch_id,
      policy_basis, credited_account_code, production_completed_at_receipt,
      amount_ngn, posted_at_iso, created_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    journalId,
    payload.ledgerEntryId ?? null,
    payload.receiptId ?? null,
    qref || null,
    payload.customerId ?? null,
    payload.branchId ?? null,
    policyBasis,
    creditedAccountCode || '1200',
    prodInt,
    amountNgn,
    postedAt,
    now
  );

  const row = getReceiptPolicyMetaByJournalId(db, journalId);
  return { ok: true, meta: mapReceiptPolicyMetaRow(row) };
}

/**
 * After tryPostCustomerReceiptGl — record metadata without changing GL.
 * @param {import('better-sqlite3').Database} db
 * @param {import('./glOps.js').postBalancedJournalTx extends Function ? Parameters<typeof tryPostCustomerReceiptGl>[1] : never} receiptPayload
 * @param {{ ok?: boolean, journalId?: string, duplicate?: boolean, skipped?: boolean }} glResult
 */
export function recordReceiptPolicyMetaAfterCustomerReceiptGl(db, receiptPayload, glResult) {
  if (!glResult?.ok || glResult.skipped) return { ok: true, skipped: true };
  const journalId = String(glResult.journalId || '').trim();
  if (!journalId) return { ok: true, skipped: true, reason: 'no_journal_id' };

  let quotationRef = receiptPayload.quotationRef ?? null;
  let customerId = receiptPayload.customerId ?? null;
  let receiptId = receiptPayload.receiptId ?? null;
  let receiptAtISO = receiptPayload.receiptAtISO || receiptPayload.entryDateISO || null;

  const ledgerEntryId = String(receiptPayload.ledgerEntryId || '').trim();
  if (tableExists(db, 'sales_receipts') && ledgerEntryId) {
    const sr = db
      .prepare(
        `SELECT id, quotation_ref, customer_id, date_iso, branch_id FROM sales_receipts WHERE ledger_entry_id = ? LIMIT 1`
      )
      .get(ledgerEntryId);
    if (sr) {
      receiptId = receiptId || sr.id;
      quotationRef = quotationRef || sr.quotation_ref;
      customerId = customerId || sr.customer_id;
      receiptAtISO = receiptAtISO || sr.date_iso;
    }
  }

  const jobs =
    quotationRef && tableExists(db, 'production_jobs')
      ? listProductionJobs(db, 'ALL').filter(
          (j) => String(j.quotationRef || j.quotation_ref || '').trim() === String(quotationRef).trim()
        )
      : [];

  try {
    return upsertReceiptPolicyMeta(db, {
      journalId,
      ledgerEntryId,
      receiptId,
      quotationRef,
      customerId,
      branchId: receiptPayload.branchId ?? null,
      amountNgn: receiptPayload.amountNgn,
      entryDateISO: receiptPayload.entryDateISO,
      receiptAtISO,
      productionJobs: jobs,
      postingUsesPolicyV1ReceiptGl: readFinanceFeatureFlags().accountingPolicyV1ReceiptGl,
    });
  } catch (e) {
    console.error('[receipt-policy-meta]', e);
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function sumPolicyV1DepositReceiptMetaNgn(db, quotationRef) {
  return sumReceiptPolicyMetaNgnForQuotation(db, quotationRef, { creditedAccountCode: '2500' });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function sumLegacyBridgeReceiptMetaNgn(db, quotationRef) {
  return sumReceiptPolicyMetaNgnForQuotation(db, quotationRef, {
    policyBasis: RECEIPT_POLICY_BASIS.LEGACY_AR,
    creditedAccountCode: '1200',
  });
}

/**
 * Active receipt GL meta sums (exclude reversed sales_receipts when linked).
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {{ creditedAccountCode?: string, policyBasis?: string }} [filter]
 */
export function sumReceiptPolicyMetaNgnForQuotation(db, quotationRef, filter = {}) {
  const qref = String(quotationRef || '').trim();
  if (!qref || !receiptPolicyMetaTableExists(db)) return 0;

  let sql = `
    SELECT COALESCE(SUM(m.amount_ngn), 0) AS s
    FROM gl_receipt_policy_meta m
    LEFT JOIN sales_receipts sr ON sr.ledger_entry_id = m.ledger_entry_id
    WHERE m.quotation_ref = ?
      AND (sr.id IS NULL OR sr.status IS NULL OR TRIM(LOWER(sr.status)) NOT IN ('reversed'))`;
  const args = [qref];

  if (filter.creditedAccountCode) {
    sql += ` AND m.credited_account_code = ?`;
    args.push(filter.creditedAccountCode);
  }
  if (filter.policyBasis) {
    sql += ` AND m.policy_basis = ?`;
    args.push(filter.policyBasis);
  }

  const row = db.prepare(sql).get(...args);
  return Math.max(0, Math.round(Number(row?.s) || 0));
}

/**
 * Backfill metadata for CUSTOMER_RECEIPT_GL journals missing a meta row (no journal line changes).
 * @param {import('better-sqlite3').Database} db
 */
export function backfillReceiptPolicyMeta(db) {
  if (!tableExists(db, 'gl_journal_entries')) return { ok: true, inserted: 0, skipped: 0 };

  const jobsByQuote = new Map();
  if (tableExists(db, 'production_jobs')) {
    for (const j of listProductionJobs(db, 'ALL')) {
      const ref = String(j.quotationRef || j.quotation_ref || '').trim();
      if (!ref) continue;
      if (!jobsByQuote.has(ref)) jobsByQuote.set(ref, []);
      jobsByQuote.get(ref).push(j);
    }
  }

  const journals = db
    .prepare(
      `SELECT j.id AS journal_id, j.source_id AS ledger_entry_id, j.entry_date_iso, j.created_at_iso, j.branch_id
       FROM gl_journal_entries j
       WHERE j.source_kind = 'CUSTOMER_RECEIPT_GL'`
    )
    .all();

  let inserted = 0;
  let skipped = 0;

  for (const j of journals) {
    const journalId = String(j.journal_id || '').trim();
    if (!journalId) continue;
    if (getReceiptPolicyMetaByJournalId(db, journalId)) {
      skipped += 1;
      continue;
    }

    const ledgerEntryId = String(j.ledger_entry_id || '').trim();
    let quotationRef = null;
    let customerId = null;
    let receiptId = null;
    let receiptAtISO = j.entry_date_iso;
    let branchId = j.branch_id;

    if (tableExists(db, 'sales_receipts') && ledgerEntryId) {
      const sr = db
        .prepare(
          `SELECT id, quotation_ref, customer_id, date_iso, branch_id, amount_ngn FROM sales_receipts WHERE ledger_entry_id = ? LIMIT 1`
        )
        .get(ledgerEntryId);
      if (sr) {
        receiptId = sr.id;
        quotationRef = sr.quotation_ref;
        customerId = sr.customer_id;
        receiptAtISO = sr.date_iso || receiptAtISO;
        branchId = branchId || sr.branch_id;
      }
    }

    const lines = loadJournalLinesForReceiptMeta(db, journalId);
    const { creditedAccountCode, creditNgn } = findReceiptGlCreditedAccountFromLines(lines);
    const amountNgn = creditNgn || 0;

    const qref = String(quotationRef || '').trim();
    const jobs = qref ? jobsByQuote.get(qref) || [] : [];
    const prodAtReceipt = qref ? inferProductionCompletedAtReceipt(qref, receiptAtISO, jobs) : null;

    const policyBasis = resolveReceiptPolicyBasis({
      creditedAccountCode,
      productionCompletedAtReceipt: prodAtReceipt,
      postingUsesPolicyV1ReceiptGl: false,
    });

    const now = new Date().toISOString();
    const id = `RPM-${journalId}`;
    const prodInt = prodAtReceipt === null ? null : prodAtReceipt ? 1 : 0;

    try {
      db.prepare(
        `INSERT INTO gl_receipt_policy_meta (
          id, journal_id, ledger_entry_id, receipt_id, quotation_ref, customer_id, branch_id,
          policy_basis, credited_account_code, production_completed_at_receipt,
          amount_ngn, posted_at_iso, created_at_iso
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        journalId,
        ledgerEntryId || null,
        receiptId,
        qref || null,
        customerId,
        branchId,
        policyBasis,
        creditedAccountCode || '1200',
        prodInt,
        amountNgn,
        j.created_at_iso || now,
        now
      );
      inserted += 1;
    } catch {
      skipped += 1;
    }
  }

  return { ok: true, inserted, skipped };
}
