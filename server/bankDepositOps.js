/**
 * Unlinked bank deposit pool — treasury credits on register; Sales links without double-counting cash.
 */
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  BANK_DEPOSIT_ALLOC_KIND_ADVANCE,
  BANK_DEPOSIT_ALLOC_KIND_RECEIPT,
  BANK_DEPOSIT_CLOSE_AMOUNT_FLOOR_NGN,
  BANK_DEPOSIT_CLOSE_AMOUNT_RATIO,
  BANK_DEPOSIT_CLOSE_DATE_DAYS,
  BANK_DEPOSIT_RECLASS_EXPENSE_OFFSET,
  BANK_DEPOSIT_RECLASS_INTER_BRANCH,
  BANK_DEPOSIT_RECLASS_KINDS,
  BANK_DEPOSIT_RECLASS_OTHER_INCOME,
  BANK_DEPOSIT_RECLASS_REFUND_OUT,
  BANK_DEPOSIT_RESERVE_MS,
  BANK_DEPOSIT_STATUS_ALLOCATED,
  BANK_DEPOSIT_STATUS_OPEN,
  BANK_DEPOSIT_STATUS_PARTIAL,
  BANK_DEPOSIT_STATUS_RECLASSED,
  BANK_DEPOSIT_STATUS_RESERVED,
  BANK_DEPOSIT_STATUS_REVERSED,
  BANK_DEPOSIT_TREASURY_REVERSAL_TYPE,
  BANK_DEPOSIT_TREASURY_SOURCE_KIND,
  BANK_DEPOSIT_TREASURY_TYPE,
  bankDepositRemainingNgn,
  scoreBankDepositMatch,
} from '../shared/lib/bankDeposits.js';
import { appendAuditLog, assertPeriodOpen } from './controlOps.js';
import {
  tryPostBankDepositAllocationGl,
  tryPostBankDepositMergeDuplicateAdvanceGl,
  tryPostBankDepositMergeDuplicateReceiptGl,
  tryPostBankDepositReclassGl,
  tryPostBankDepositRegisterGl,
  tryPostBankDepositReverseGl,
} from './glOps.js';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}
import { nextBankDepositAllocationHumanId, nextBankDepositHumanId } from './humanId.js';
import { insertTreasuryMovementTx, reverseTreasurySourceTx } from './writeOps.js';

function actorId(actor) {
  return actor?.id ?? actor?.userId ?? null;
}

function actorName(actor) {
  return String(actor?.displayName ?? actor?.name ?? actor?.username ?? 'System').trim() || 'System';
}

function mapDepositRow(row) {
  if (!row) return null;
  const amountNgn = roundMoney(row.amount_ngn);
  const allocatedNgn = roundMoney(row.allocated_ngn);
  return {
    id: row.id,
    branchId: row.branch_id,
    bankDateISO: row.bank_date_iso,
    amountNgn,
    allocatedNgn,
    remainingNgn: Math.max(0, amountNgn - allocatedNgn),
    description: row.description ?? '',
    bankReference: row.bank_reference ?? '',
    treasuryAccountId: row.treasury_account_id,
    treasuryMovementId: row.treasury_movement_id ?? '',
    status: row.status,
    reservedAtISO: row.reserved_at_iso ?? null,
    reservedByUserId: row.reserved_by_user_id ?? null,
    reservedByName: row.reserved_by_name ?? null,
    reservedUntilISO: row.reserved_until_iso ?? null,
    registeredAtISO: row.registered_at_iso,
    registeredByUserId: row.registered_by_user_id ?? null,
    registeredByName: row.registered_by_name ?? null,
    note: row.note ?? '',
    bankReconLineId: row.bank_recon_line_id ?? null,
    reversedAtISO: row.reversed_at_iso ?? null,
    reclassKind: row.reclass_kind ?? null,
    reclassNote: row.reclass_note ?? null,
    reclassifiedAtISO: row.reclassified_at_iso ?? null,
  };
}

const TERMINAL_DEPOSIT_STATUSES = new Set([BANK_DEPOSIT_STATUS_REVERSED, BANK_DEPOSIT_STATUS_RECLASSED]);

function reclassCreditAccountCode(kind) {
  const k = String(kind || '').trim().toUpperCase();
  if (k === BANK_DEPOSIT_RECLASS_OTHER_INCOME) return '4000';
  if (k === BANK_DEPOSIT_RECLASS_INTER_BRANCH) return '1300';
  if (k === BANK_DEPOSIT_RECLASS_REFUND_OUT) return '1000';
  if (k === BANK_DEPOSIT_RECLASS_EXPENSE_OFFSET) return '6100';
  return null;
}

function refreshDepositStatus(db, depositId) {
  const row = db.prepare(`SELECT amount_ngn, allocated_ngn, status FROM bank_deposits WHERE id = ?`).get(depositId);
  if (!row) return;
  if (TERMINAL_DEPOSIT_STATUSES.has(String(row.status))) return;
  const total = roundMoney(row.amount_ngn);
  const allocated = roundMoney(row.allocated_ngn);
  let next = BANK_DEPOSIT_STATUS_OPEN;
  if (allocated >= total && total > 0) next = BANK_DEPOSIT_STATUS_ALLOCATED;
  else if (allocated > 0) next = BANK_DEPOSIT_STATUS_PARTIAL;
  db.prepare(
    `UPDATE bank_deposits SET status = ?, reserved_at_iso = NULL, reserved_by_user_id = NULL, reserved_by_name = NULL, reserved_until_iso = NULL WHERE id = ?`
  ).run(next, depositId);
}

function assertDepositLinkable(db, depositId, actor, { forAmountNgn = null } = {}) {
  const row = db.prepare(`SELECT * FROM bank_deposits WHERE id = ?`).get(depositId);
  if (!row) return { ok: false, error: 'Bank deposit not found.' };
  if (String(row.status) === BANK_DEPOSIT_STATUS_REVERSED) {
    return { ok: false, error: 'This bank deposit was reversed.' };
  }
  if (String(row.status) === BANK_DEPOSIT_STATUS_RECLASSED) {
    return { ok: false, error: 'This bank deposit was reclassified.' };
  }
  if (String(row.status) === BANK_DEPOSIT_STATUS_ALLOCATED) {
    return { ok: false, error: 'This bank deposit is already fully linked.' };
  }
  const remaining = bankDepositRemainingNgn(mapDepositRow(row));
  if (remaining <= 0) return { ok: false, error: 'No remaining balance on this bank deposit.' };
  if (forAmountNgn != null && roundMoney(forAmountNgn) > remaining) {
    return {
      ok: false,
      error: `Only ₦${remaining.toLocaleString('en-NG')} remains on this deposit.`,
      remainingNgn: remaining,
    };
  }
  const st = String(row.status || '');
  if (st === BANK_DEPOSIT_STATUS_RESERVED) {
    const until = String(row.reserved_until_iso || '').trim();
    const uid = String(row.reserved_by_user_id || '').trim();
    const me = String(actorId(actor) || '').trim();
    const expired = until && Date.parse(until) < Date.now();
    if (expired) {
      refreshDepositStatus(db, depositId);
      return assertDepositLinkable(db, depositId, actor, { forAmountNgn });
    }
    if (uid && me && uid !== me) {
      return {
        ok: false,
        error: `Deposit is being linked by ${row.reserved_by_name || 'another user'}. Try again shortly.`,
        code: 'DEPOSIT_RESERVED',
      };
    }
  }
  return { ok: true, row, remainingNgn: remaining };
}

/**
 * Finance / Cashier: register money seen on the bank statement (treasury credit).
 * @param {import('better-sqlite3').Database} db
 */
export function registerBankDeposit(db, payload, branchId = DEFAULT_BRANCH_ID, actor = null) {
  const bankDateISO = String(payload.bankDateISO ?? '').trim();
  const description = String(payload.description ?? '').trim();
  const bankReference = String(payload.bankReference ?? payload.bank_reference ?? '').trim();
  const amountNgn = roundMoney(payload.amountNgn);
  const treasuryAccountId = Number(payload.treasuryAccountId);
  const note = String(payload.note ?? '').trim();
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;

  if (!bankDateISO || !/^\d{4}-\d{2}-\d{2}$/.test(bankDateISO)) {
    return { ok: false, error: 'Valid bank date (YYYY-MM-DD) is required.' };
  }
  if (!description) return { ok: false, error: 'Bank description is required.' };
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    return { ok: false, error: 'Amount must be a positive whole naira value.' };
  }
  if (!treasuryAccountId) {
    return { ok: false, error: 'Select the treasury (bank/cash) account that received this payment.' };
  }

  try {
    assertPeriodOpen(db, bankDateISO, 'Bank deposit date');
  } catch (e) {
    return { ok: false, error: String(e.message || e), code: 'PERIOD_LOCKED' };
  }

  if (bankReference) {
    const dup = db
      .prepare(
        `SELECT id FROM bank_deposits WHERE branch_id = ? AND bank_reference = ? AND status != ? LIMIT 1`
      )
      .get(bid, bankReference, BANK_DEPOSIT_STATUS_REVERSED);
    if (dup?.id) {
      return {
        ok: false,
        error: `A deposit with reference “${bankReference}” is already registered (${dup.id}).`,
        code: 'DUPLICATE_BANK_REFERENCE',
        existingId: dup.id,
      };
    }
  }

  const id = nextBankDepositHumanId(db, bid);
  const now = new Date().toISOString();

  try {
    db.transaction(() => {
      const mv = insertTreasuryMovementTx(db, {
        type: BANK_DEPOSIT_TREASURY_TYPE,
        treasuryAccountId,
        amountNgn,
        postedAtISO: `${bankDateISO}T12:00:00`,
        reference: bankReference || id,
        counterpartyKind: 'BANK_DEPOSIT',
        counterpartyId: id,
        counterpartyName: description.slice(0, 80),
        sourceKind: BANK_DEPOSIT_TREASURY_SOURCE_KIND,
        sourceId: id,
        note: note || `Unlinked bank deposit ${id}`,
        createdBy: actorName(actor),
        workspaceBranchId: bid,
        actor,
      });
      db.prepare(
        `INSERT INTO bank_deposits (
          id, branch_id, bank_date_iso, amount_ngn, allocated_ngn, description, bank_reference,
          treasury_account_id, treasury_movement_id, status, registered_at_iso,
          registered_by_user_id, registered_by_name, note, bank_recon_line_id
        ) VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        bid,
        bankDateISO,
        amountNgn,
        description,
        bankReference || null,
        treasuryAccountId,
        mv.id,
        BANK_DEPOSIT_STATUS_OPEN,
        now,
        actorId(actor),
        actorName(actor),
        note || null,
        payload.bankReconLineId ? String(payload.bankReconLineId).trim() : null
      );
      const gl = tryPostBankDepositRegisterGl(db, {
        depositId: id,
        amountNgn,
        entryDateISO: bankDateISO,
        branchId: bid,
        createdByUserId: actorId(actor),
      });
      if (!gl.ok && !gl.skipped) throw new Error(gl.error || 'GL posting failed for bank deposit register.');
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  appendAuditLog(db, {
    actor,
    action: 'bank_deposit.register',
    entityKind: 'bank_deposit',
    entityId: id,
    note: `${description.slice(0, 80)} · ₦${amountNgn.toLocaleString('en-NG')}`,
    status: 'success',
    details: { bankDateISO, amountNgn, treasuryAccountId, bankReference },
  });

  return { ok: true, id, deposit: mapDepositRow(db.prepare(`SELECT * FROM bank_deposits WHERE id = ?`).get(id)) };
}

/** Soft-lock a deposit while Sales is linking (prevents concurrent double allocation). */
export function reserveBankDeposit(db, depositId, actor) {
  const id = String(depositId ?? '').trim();
  if (!id) return { ok: false, error: 'Deposit id is required.' };
  const gate = assertDepositLinkable(db, id, actor);
  if (!gate.ok) return gate;
  const until = new Date(Date.now() + BANK_DEPOSIT_RESERVE_MS).toISOString();
  db.prepare(
    `UPDATE bank_deposits SET status = ?, reserved_at_iso = ?, reserved_by_user_id = ?, reserved_by_name = ?, reserved_until_iso = ? WHERE id = ?`
  ).run(BANK_DEPOSIT_STATUS_RESERVED, new Date().toISOString(), actorId(actor), actorName(actor), until, id);
  return { ok: true, reservedUntilISO: until };
}

export function releaseBankDepositReservation(db, depositId, actor) {
  const id = String(depositId ?? '').trim();
  if (!id) return { ok: false, error: 'Deposit id is required.' };
  const row = db.prepare(`SELECT * FROM bank_deposits WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Bank deposit not found.' };
  if (String(row.status) !== BANK_DEPOSIT_STATUS_RESERVED) return { ok: true, released: false };
  const uid = String(row.reserved_by_user_id || '').trim();
  const me = String(actorId(actor) || '').trim();
  if (uid && me && uid !== me) {
    return { ok: false, error: 'Only the user who reserved this deposit can release it.' };
  }
  refreshDepositStatus(db, id);
  return { ok: true, released: true };
}

/**
 * Link deposit balance to a ledger receipt or advance (no duplicate treasury credit).
 * @param {import('better-sqlite3').Database} db
 */
export function allocateBankDepositTx(db, { depositId, ledgerEntryId, kind, amountNgn, actor, branchId }) {
  const depId = String(depositId ?? '').trim();
  const leId = String(ledgerEntryId ?? '').trim();
  const allocKind =
    kind === BANK_DEPOSIT_ALLOC_KIND_ADVANCE ? BANK_DEPOSIT_ALLOC_KIND_ADVANCE : BANK_DEPOSIT_ALLOC_KIND_RECEIPT;
  const amt = roundMoney(amountNgn);
  if (!depId || !leId) return { ok: false, error: 'Deposit id and ledger entry id are required.' };
  if (amt <= 0) return { ok: false, error: 'Allocation amount must be positive.' };

  const gate = assertDepositLinkable(db, depId, actor, { forAmountNgn: amt });
  if (!gate.ok) return gate;
  const row = gate.row;

  const exists = db
    .prepare(`SELECT id FROM bank_deposit_allocations WHERE bank_deposit_id = ? AND allocated_to_id = ?`)
    .get(depId, leId);
  if (exists?.id) {
    return { ok: false, error: 'This ledger entry is already linked to this deposit.', allocationId: exists.id };
  }

  const bid = String(branchId || row.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const allocId = nextBankDepositAllocationHumanId(db, bid);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO bank_deposit_allocations (
      id, bank_deposit_id, allocated_to_kind, allocated_to_id, amount_ngn,
      allocated_at_iso, allocated_by_user_id, allocated_by_name
    ) VALUES (?,?,?,?,?,?,?,?)`
  ).run(allocId, depId, allocKind, leId, amt, now, actorId(actor), actorName(actor));

  db.prepare(`UPDATE bank_deposits SET allocated_ngn = allocated_ngn + ? WHERE id = ?`).run(amt, depId);
  refreshDepositStatus(db, depId);

  const gl = tryPostBankDepositAllocationGl(db, {
    depositId: depId,
    ledgerEntryId: leId,
    allocationId: allocId,
    amountNgn: amt,
    allocKind: allocKind,
    entryDateISO: String(row.bank_date_iso || now).slice(0, 10),
    branchId: bid,
    createdByUserId: actorId(actor),
  });
  if (!gl.ok && !gl.skipped) {
    throw new Error(gl.error || 'GL allocation failed.');
  }

  appendAuditLog(db, {
    actor,
    action: 'bank_deposit.allocate',
    entityKind: 'bank_deposit',
    entityId: depId,
    note: `Linked ₦${amt.toLocaleString('en-NG')} to ${allocKind} ${leId}`,
    status: 'success',
    details: { allocationId: allocId, ledgerEntryId: leId, amountNgn: amt },
  });

  return { ok: true, allocationId: allocId, depositId: depId, amountNgn: amt };
}

/** Fuzzy match for duplicate prevention when Sales posts without linking. */
export function findSimilarOpenBankDeposits(db, { branchId, amountNgn, bankDateISO, bankReference, limit = 5 }) {
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const rows = db
    .prepare(
      `SELECT * FROM bank_deposits
       WHERE branch_id = ?
         AND status IN ('OPEN','PARTIAL','RESERVED')
         AND amount_ngn - allocated_ngn > 0
       ORDER BY bank_date_iso DESC, registered_at_iso DESC
       LIMIT 80`
    )
    .all(bid);

  const target = { amountNgn, bankDateISO, bankReference };
  const scored = [];
  for (const row of rows) {
    const mapped = mapDepositRow(row);
    const match = scoreBankDepositMatch(mapped, target);
    if (match.score > 0) {
      scored.push({
        ...mapped,
        matchScore: match.score,
        matchHints: match.matchHints,
        amountExact: match.amountExact,
        amountClose: match.amountClose,
        dateExact: match.dateExact,
        dateClose: match.dateClose,
        dateDiffDays: match.dateDiffDays,
        canMergeDuplicate: match.canMergeDuplicate,
      });
    }
  }
  scored.sort((a, b) => b.matchScore - a.matchScore);
  return scored.slice(0, Math.max(1, Math.min(limit, 20)));
}

export function getBankDepositById(db, depositId) {
  const row = db.prepare(`SELECT * FROM bank_deposits WHERE id = ?`).get(String(depositId ?? '').trim());
  return mapDepositRow(row);
}

export function listBankDepositAllocationsForDeposit(db, depositId) {
  return db
    .prepare(
      `SELECT * FROM bank_deposit_allocations WHERE bank_deposit_id = ? ORDER BY allocated_at_iso ASC`
    )
    .all(String(depositId ?? '').trim())
    .map((r) => ({
      id: r.id,
      bankDepositId: r.bank_deposit_id,
      allocatedToKind: r.allocated_to_kind,
      allocatedToId: r.allocated_to_id,
      amountNgn: roundMoney(r.amount_ngn),
      allocatedAtISO: r.allocated_at_iso,
      allocatedByName: r.allocated_by_name ?? '',
    }));
}

/** @param {import('better-sqlite3').Database} db */
export function listBankDeposits(db, branchScope = 'ALL', opts = {}) {
  const openOnly = Boolean(opts.openOnly);
  let sql = `SELECT * FROM bank_deposits WHERE 1=1`;
  const args = [];
  if (branchScope && branchScope !== 'ALL') {
    sql += ` AND branch_id = ?`;
    args.push(String(branchScope).trim());
  }
  if (openOnly) {
    sql += ` AND status IN ('OPEN','PARTIAL','RESERVED') AND amount_ngn - allocated_ngn > 0`;
  }
  sql += ` ORDER BY bank_date_iso DESC, registered_at_iso DESC`;
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => mapDepositRow(row));
}

/**
 * Deposits registered by Finance that match unlinked receipt/advance treasury (double-count risk).
 * Includes exact pairs plus close-amount / close-date suggestions.
 * Merge is allowed only when amount is exact and date is exact or within {@link BANK_DEPOSIT_CLOSE_DATE_DAYS}.
 * @param {import('better-sqlite3').Database} db
 */
export function listBankDepositDuplicateExceptions(db, branchScope = 'ALL') {
  let branchSql = '';
  const args = [];
  if (branchScope && branchScope !== 'ALL') {
    branchSql = ' AND d.branch_id = ?';
    args.push(String(branchScope).trim());
  }

  const amountTolFloor = BANK_DEPOSIT_CLOSE_AMOUNT_FLOOR_NGN;
  const amountTolRatio = BANK_DEPOSIT_CLOSE_AMOUNT_RATIO;
  const closeDateDays = BANK_DEPOSIT_CLOSE_DATE_DAYS;

  const rows = db
    .prepare(
      `SELECT
        d.id AS deposit_id,
        d.branch_id AS branch_id,
        d.bank_date_iso AS bank_date_iso,
        d.amount_ngn AS deposit_amount_ngn,
        d.bank_reference AS deposit_bank_reference,
        d.description AS deposit_description,
        d.status AS deposit_status,
        d.allocated_ngn AS deposit_allocated_ngn,
        le.id AS ledger_entry_id,
        le.type AS ledger_type,
        le.customer_id AS customer_id,
        le.customer_name AS customer_name,
        le.amount_ngn AS ledger_amount_ngn,
        le.bank_reference AS ledger_bank_reference,
        le.at_iso AS ledger_at_iso,
        tm.amount_ngn AS treasury_amount_ngn,
        tm.posted_at_iso AS treasury_posted_at_iso,
        tm.reference AS treasury_reference,
        tm.type AS treasury_type,
        tm.source_kind AS treasury_source_kind
      FROM bank_deposits d
      INNER JOIN treasury_movements tm
        ON tm.type IN ('RECEIPT_IN', 'ADVANCE_IN')
       AND tm.reverses_movement_id IS NULL
       AND tm.amount_ngn > 0
      INNER JOIN ledger_entries le
        ON le.id = tm.source_id
       AND tm.source_kind IN ('LEDGER_RECEIPT', 'LEDGER_ADVANCE')
       AND le.branch_id = d.branch_id
      LEFT JOIN bank_deposit_allocations bda ON bda.allocated_to_id = le.id
      WHERE d.status IN ('OPEN', 'PARTIAL', 'RESERVED')
        AND d.amount_ngn - d.allocated_ngn > 0
        AND bda.id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM treasury_movements rev WHERE rev.reverses_movement_id = tm.id
        )
        AND ABS(ABS(tm.amount_ngn) - d.amount_ngn) <=
              GREATEST(?, CAST(ROUND(GREATEST(ABS(tm.amount_ngn), d.amount_ngn) * ?) AS SIGNED))
        AND ABS(DATEDIFF(DATE(LEFT(tm.posted_at_iso, 10)), DATE(d.bank_date_iso))) <= ?
        ${branchSql}
      ORDER BY d.bank_date_iso DESC, d.registered_at_iso DESC`
    )
    .all(amountTolFloor, amountTolRatio, closeDateDays, ...args);

  return rows
    .map((row) => {
      const deposit = mapDepositRow({
        id: row.deposit_id,
        branch_id: row.branch_id,
        bank_date_iso: row.bank_date_iso,
        amount_ngn: row.deposit_amount_ngn,
        allocated_ngn: row.deposit_allocated_ngn,
        description: row.deposit_description,
        bank_reference: row.deposit_bank_reference,
        status: row.deposit_status,
      });
      const ledgerBankReference = row.ledger_bank_reference ?? row.treasury_reference ?? '';
      const match = scoreBankDepositMatch(deposit, {
        amountNgn: row.treasury_amount_ngn,
        bankDateISO: String(row.treasury_posted_at_iso || '').slice(0, 10),
        bankReference: ledgerBankReference,
      });

      // Require at least one amount signal and one date signal (SQL already bounds both).
      if (!match.amountClose || !match.dateClose) return null;

      return {
        depositId: row.deposit_id,
        deposit,
        ledgerEntryId: row.ledger_entry_id,
        ledgerType: row.ledger_type,
        customerId: row.customer_id ?? '',
        customerName: row.customer_name ?? '',
        amountNgn: roundMoney(row.deposit_amount_ngn),
        ledgerAmountNgn: roundMoney(row.ledger_amount_ngn),
        treasuryAmountNgn: roundMoney(row.treasury_amount_ngn),
        bankDateISO: row.bank_date_iso,
        ledgerBankDateISO: String(row.treasury_posted_at_iso || '').slice(0, 10),
        depositBankReference: row.deposit_bank_reference ?? '',
        ledgerBankReference,
        treasuryType: row.treasury_type,
        treasurySourceKind: row.treasury_source_kind,
        matchScore: match.score,
        matchHints: match.matchHints,
        amountExact: match.amountExact,
        amountClose: match.amountClose,
        dateExact: match.dateExact,
        dateClose: match.dateClose,
        dateDiffDays: match.dateDiffDays,
        canMerge: match.canMergeDuplicate,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.matchScore - a.matchScore || String(b.bankDateISO).localeCompare(String(a.bankDateISO)));
}

/**
 * Link deposit to receipt/advance and reverse the duplicate treasury + GL cash leg.
 * @param {import('better-sqlite3').Database} db
 */
export function mergeBankDepositDuplicate(db, { depositId, ledgerEntryId, actor }) {
  const depId = String(depositId ?? '').trim();
  const leId = String(ledgerEntryId ?? '').trim();
  if (!depId || !leId) return { ok: false, error: 'Deposit id and ledger entry id are required.' };

  const depRow = db.prepare(`SELECT * FROM bank_deposits WHERE id = ?`).get(depId);
  if (!depRow) return { ok: false, error: 'Bank deposit not found.' };
  const le = db.prepare(`SELECT * FROM ledger_entries WHERE id = ?`).get(leId);
  if (!le) return { ok: false, error: 'Ledger entry not found.' };

  const exceptions = listBankDepositDuplicateExceptions(db, depRow.branch_id).filter(
    (x) => x.depositId === depId && x.ledgerEntryId === leId && x.canMerge
  );
  if (!exceptions.length) {
    return {
      ok: false,
      error:
        'No mergeable duplicate match found. Amounts must match exactly; dates may be within ±2 days.',
      code: 'NOT_DUPLICATE_PAIR',
    };
  }

  const remaining = bankDepositRemainingNgn(mapDepositRow(depRow));
  const amt = Math.min(remaining, roundMoney(le.amount_ngn));
  if (amt <= 0) return { ok: false, error: 'Nothing left to merge on this deposit.' };

  const leType = String(le.type || '').toUpperCase();
  const isAdvance = leType === 'ADVANCE_IN' || leType === 'ADVANCE' || leType === 'CUSTOMER_ADVANCE';
  const allocKind = isAdvance ? BANK_DEPOSIT_ALLOC_KIND_ADVANCE : BANK_DEPOSIT_ALLOC_KIND_RECEIPT;
  const sourceKind = isAdvance ? 'LEDGER_ADVANCE' : 'LEDGER_RECEIPT';
  const reversalType = isAdvance ? 'ADVANCE_REVERSAL_OUT' : 'RECEIPT_REVERSAL_OUT';
  const mergeDate = String(depRow.bank_date_iso || new Date().toISOString()).slice(0, 10);

  try {
    assertPeriodOpen(db, mergeDate, 'Bank deposit merge date');
  } catch (e) {
    return { ok: false, error: String(e.message || e), code: 'PERIOD_LOCKED' };
  }

  try {
    let allocationId = null;
    db.transaction(() => {
      const alloc = allocateBankDepositTx(db, {
        depositId: depId,
        ledgerEntryId: leId,
        kind: allocKind,
        amountNgn: amt,
        actor,
        branchId: depRow.branch_id,
      });
      if (!alloc.ok) throw new Error(alloc.error || 'Allocation failed.');
      allocationId = alloc.allocationId;

      reverseTreasurySourceTx(
        db,
        sourceKind,
        leId,
        reversalType,
        `Merge duplicate treasury for bank deposit ${depId}`,
        actor,
        { postedAtISO: `${mergeDate}T12:00:00.000Z` }
      );

      const mergeGl = isAdvance
        ? tryPostBankDepositMergeDuplicateAdvanceGl(db, {
            depositId: depId,
            ledgerEntryId: leId,
            amountNgn: amt,
            entryDateISO: mergeDate,
            branchId: depRow.branch_id,
            createdByUserId: actorId(actor),
          })
        : tryPostBankDepositMergeDuplicateReceiptGl(db, {
            depositId: depId,
            ledgerEntryId: leId,
            amountNgn: amt,
            entryDateISO: mergeDate,
            branchId: depRow.branch_id,
            createdByUserId: actorId(actor),
          });
      if (!mergeGl.ok && !mergeGl.skipped) {
        throw new Error(mergeGl.error || 'Merge duplicate GL failed.');
      }
    })();

    appendAuditLog(db, {
      actor,
      action: 'bank_deposit.merge_duplicate',
      entityKind: 'bank_deposit',
      entityId: depId,
      note: `Merged with ${leId} · ₦${amt.toLocaleString('en-NG')}`,
      status: 'success',
      details: { ledgerEntryId: leId, allocationId, amountNgn: amt },
    });

    return {
      ok: true,
      depositId: depId,
      ledgerEntryId: leId,
      allocationId,
      amountNgn: amt,
      deposit: getBankDepositById(db, depId),
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Reverse an unallocated bank deposit (treasury + GL). */
export function reverseBankDeposit(db, depositId, actor, note = '') {
  const id = String(depositId ?? '').trim();
  if (!id) return { ok: false, error: 'Deposit id is required.' };
  const row = db.prepare(`SELECT * FROM bank_deposits WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Bank deposit not found.' };
  if (String(row.status) === BANK_DEPOSIT_STATUS_REVERSED) {
    return { ok: false, error: 'Deposit already reversed.' };
  }
  if (String(row.status) === BANK_DEPOSIT_STATUS_RECLASSED) {
    return { ok: false, error: 'Deposit was reclassified; cannot reverse.' };
  }
  if (roundMoney(row.allocated_ngn) > 0) {
    return { ok: false, error: 'Cannot reverse a deposit with linked receipts or advances.' };
  }

  const reversalDate = new Date().toISOString().slice(0, 10);
  try {
    assertPeriodOpen(db, reversalDate, 'Bank deposit reversal date');
  } catch (e) {
    return { ok: false, error: String(e.message || e), code: 'PERIOD_LOCKED' };
  }

  const reversalNote = String(note || '').trim() || `Reverse unlinked bank deposit ${id}`;
  const now = new Date().toISOString();
  const amountNgn = roundMoney(row.amount_ngn);

  try {
    db.transaction(() => {
      reverseTreasurySourceTx(
        db,
        BANK_DEPOSIT_TREASURY_SOURCE_KIND,
        id,
        BANK_DEPOSIT_TREASURY_REVERSAL_TYPE,
        reversalNote,
        actor,
        { postedAtISO: `${String(row.bank_date_iso).slice(0, 10)}T12:00:00.000Z` }
      );
      const gl = tryPostBankDepositReverseGl(db, {
        depositId: id,
        amountNgn,
        entryDateISO: reversalDate,
        branchId: row.branch_id,
        createdByUserId: actorId(actor),
      });
      if (!gl.ok && !gl.skipped) throw new Error(gl.error || 'GL reverse failed.');
      db.prepare(
        `UPDATE bank_deposits SET status = ?, reversed_at_iso = ?, reversed_by_user_id = ?, reversed_by_name = ?,
         reserved_at_iso = NULL, reserved_by_user_id = NULL, reserved_by_name = NULL, reserved_until_iso = NULL
         WHERE id = ?`
      ).run(BANK_DEPOSIT_STATUS_REVERSED, now, actorId(actor), actorName(actor), id);
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  appendAuditLog(db, {
    actor,
    action: 'bank_deposit.reverse',
    entityKind: 'bank_deposit',
    entityId: id,
    note: reversalNote,
    status: 'success',
  });

  return { ok: true, deposit: getBankDepositById(db, id) };
}

/** Reclassify unallocated deposit to non-customer GL (suspense → revenue / inter-branch / etc.). */
export function reclassBankDeposit(db, depositId, actor, { reclassKind, note: reclassNote = '' } = {}) {
  const id = String(depositId ?? '').trim();
  const kind = String(reclassKind ?? '').trim().toUpperCase();
  if (!id) return { ok: false, error: 'Deposit id is required.' };
  if (!BANK_DEPOSIT_RECLASS_KINDS.has(kind)) {
    return { ok: false, error: 'Select a valid reclass type.' };
  }

  const row = db.prepare(`SELECT * FROM bank_deposits WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Bank deposit not found.' };
  if (String(row.status) === BANK_DEPOSIT_STATUS_REVERSED) {
    return { ok: false, error: 'Deposit was reversed.' };
  }
  if (String(row.status) === BANK_DEPOSIT_STATUS_RECLASSED) {
    return { ok: false, error: 'Deposit already reclassified.' };
  }
  if (roundMoney(row.allocated_ngn) > 0) {
    return { ok: false, error: 'Cannot reclass a deposit with linked receipts or advances.' };
  }

  const creditAccount = reclassCreditAccountCode(kind);
  if (!creditAccount) return { ok: false, error: 'Unknown reclass target account.' };

  const reclassDate = new Date().toISOString().slice(0, 10);
  try {
    assertPeriodOpen(db, reclassDate, 'Bank deposit reclass date');
  } catch (e) {
    return { ok: false, error: String(e.message || e), code: 'PERIOD_LOCKED' };
  }

  const amountNgn = roundMoney(row.amount_ngn);
  const note = String(reclassNote || '').trim();
  const now = new Date().toISOString();

  try {
    db.transaction(() => {
      const gl = tryPostBankDepositReclassGl(db, {
        depositId: id,
        amountNgn,
        creditAccountCode: creditAccount,
        entryDateISO: String(row.bank_date_iso || reclassDate).slice(0, 10),
        branchId: row.branch_id,
        createdByUserId: actorId(actor),
        memo: note || `Reclass bank deposit ${id} as ${kind}`,
      });
      if (!gl.ok && !gl.skipped) throw new Error(gl.error || 'GL reclass failed.');

      if (kind === BANK_DEPOSIT_RECLASS_REFUND_OUT) {
        reverseTreasurySourceTx(
          db,
          BANK_DEPOSIT_TREASURY_SOURCE_KIND,
          id,
          BANK_DEPOSIT_TREASURY_REVERSAL_TYPE,
          note || `Refund out reclass ${id}`,
          actor,
          { postedAtISO: `${String(row.bank_date_iso).slice(0, 10)}T12:00:00.000Z` }
        );
      }

      db.prepare(
        `UPDATE bank_deposits SET status = ?, reclass_kind = ?, reclass_note = ?,
         reclassified_at_iso = ?, reclassified_by_user_id = ?, reclassified_by_name = ?,
         reserved_at_iso = NULL, reserved_by_user_id = NULL, reserved_by_name = NULL, reserved_until_iso = NULL
         WHERE id = ?`
      ).run(BANK_DEPOSIT_STATUS_RECLASSED, kind, note || null, now, actorId(actor), actorName(actor), id);
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  appendAuditLog(db, {
    actor,
    action: 'bank_deposit.reclass',
    entityKind: 'bank_deposit',
    entityId: id,
    note: `${kind}${note ? ` · ${note}` : ''}`,
    status: 'success',
    details: { reclassKind: kind, amountNgn },
  });

  return { ok: true, deposit: getBankDepositById(db, id) };
}
