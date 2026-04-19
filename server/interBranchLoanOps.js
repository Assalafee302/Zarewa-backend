import { actorId, actorName, userHasPermission } from './auth.js';
import { appendAuditLog, assertPeriodOpen } from './controlOps.js';
import {
  nextInterBranchLoanHumanId,
  nextInterBranchLoanRepaymentHumanId,
  nextTreasuryTransferBatchHumanId,
} from './humanId.js';
import { insertTreasuryMovementTx } from './writeOps.js';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

function nowIso() {
  return new Date().toISOString();
}

function parseRepaymentPlan(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapLoanRow(row) {
  return {
    loanId: row.loan_id,
    createdAtISO: row.created_at_iso,
    createdByUserId: row.created_by_user_id ?? '',
    createdByName: row.created_by_name ?? '',
    lenderBranchId: row.lender_branch_id,
    borrowerBranchId: row.borrower_branch_id,
    principalNgn: roundMoney(row.principal_ngn),
    repaidNgn: roundMoney(row.repaid_ngn),
    fromTreasuryAccountId: row.from_treasury_account_id,
    toTreasuryAccountId: row.to_treasury_account_id,
    dateISO: row.date_iso,
    reference: row.reference ?? '',
    repaymentPlan: parseRepaymentPlan(row.repayment_plan_json),
    status: row.status,
    proposedNote: row.proposed_note ?? '',
    mdApprovedAtISO: row.md_approved_at_iso ?? '',
    mdApprovedByName: row.md_approved_by_name ?? '',
    mdRejectedAtISO: row.md_rejected_at_iso ?? '',
    mdRejectNote: row.md_reject_note ?? '',
    treasuryBatchId: row.treasury_batch_id ?? '',
    executedAtISO: row.executed_at_iso ?? '',
    outstandingNgn: Math.max(0, roundMoney(row.principal_ngn) - roundMoney(row.repaid_ngn)),
  };
}

function mapRepayRow(row) {
  return {
    id: row.id,
    loanId: row.loan_id,
    postedAtISO: row.posted_at_iso,
    amountNgn: roundMoney(row.amount_ngn),
    fromTreasuryAccountId: row.from_treasury_account_id,
    toTreasuryAccountId: row.to_treasury_account_id,
    treasuryBatchId: row.treasury_batch_id ?? '',
    note: row.note ?? '',
    createdByName: row.created_by_name ?? '',
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
export function listInterBranchLoans(db, branchScope = 'ALL') {
  const useScope = branchScope !== 'ALL' && String(branchScope || '').trim();
  const sql = useScope
    ? `SELECT * FROM inter_branch_loans
       WHERE lender_branch_id = ? OR borrower_branch_id = ?
       ORDER BY created_at_iso DESC`
    : `SELECT * FROM inter_branch_loans ORDER BY created_at_iso DESC`;
  const args = useScope ? [branchScope, branchScope] : [];
  return db.prepare(sql).all(...args).map(mapLoanRow);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} loanId
 */
export function listInterBranchLoanRepayments(db, loanId) {
  return db
    .prepare(
      `SELECT * FROM inter_branch_loan_repayments WHERE loan_id = ? ORDER BY posted_at_iso ASC, id ASC`
    )
    .all(loanId)
    .map(mapRepayRow);
}

/**
 * Net amounts still owed by borrower branch to lender branch (active loans only).
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
export function interBranchLoanBalances(db, branchScope = 'ALL') {
  const loans = listInterBranchLoans(db, branchScope).filter((l) => l.status === 'active');
  const map = new Map();
  for (const l of loans) {
    if (l.outstandingNgn <= 0) continue;
    const key = `${l.lenderBranchId}|${l.borrowerBranchId}`;
    map.set(key, (map.get(key) || 0) + l.outstandingNgn);
  }
  return [...map.entries()].map(([key, outstandingNgn]) => {
    const [lenderBranchId, borrowerBranchId] = key.split('|');
    return { lenderBranchId, borrowerBranchId, outstandingNgn };
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} loanId
 * @param {'ALL' | string} branchScope
 */
export function getInterBranchLoan(db, loanId, branchScope = 'ALL') {
  const row = db.prepare(`SELECT * FROM inter_branch_loans WHERE loan_id = ?`).get(loanId);
  if (!row) return { ok: false, error: 'Loan not found.' };
  const useScope = branchScope !== 'ALL' && String(branchScope || '').trim();
  if (
    useScope &&
    row.lender_branch_id !== useScope &&
    row.borrower_branch_id !== useScope
  ) {
    return { ok: false, error: 'Loan is outside the current branch workspace.' };
  }
  return {
    ok: true,
    loan: mapLoanRow(row),
    repayments: listInterBranchLoanRepayments(db, loanId),
  };
}

function assertBranchExists(db, branchId) {
  const r = db.prepare(`SELECT id FROM branches WHERE id = ?`).get(branchId);
  return Boolean(r);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} body
 * @param {object|null} actor
 */
export function createInterBranchLoan(db, body, actor) {
  const lenderBranchId = String(body?.lenderBranchId || '').trim();
  const borrowerBranchId = String(body?.borrowerBranchId || '').trim();
  const fromId = Number(body?.fromTreasuryAccountId);
  const toId = Number(body?.toTreasuryAccountId);
  const principalNgn = roundMoney(body?.principalNgn);
  const dateISO = String(body?.dateISO || new Date().toISOString().slice(0, 10)).trim();
  const reference = String(body?.reference || '').trim();
  const proposedNote = String(body?.proposedNote || '').trim();
  const repaymentPlan = parseRepaymentPlan(body?.repaymentPlan);

  if (!lenderBranchId || !borrowerBranchId || lenderBranchId === borrowerBranchId) {
    return { ok: false, error: 'Choose two different branches.' };
  }
  if (!assertBranchExists(db, lenderBranchId) || !assertBranchExists(db, borrowerBranchId)) {
    return { ok: false, error: 'Unknown branch id.' };
  }
  if (!fromId || !toId || fromId === toId) {
    return { ok: false, error: 'Choose two different treasury accounts.' };
  }
  if (principalNgn <= 0) {
    return { ok: false, error: 'Principal must be positive.' };
  }

  const fromAcc = db.prepare(`SELECT id FROM treasury_accounts WHERE id = ?`).get(fromId);
  const toAcc = db.prepare(`SELECT id FROM treasury_accounts WHERE id = ?`).get(toId);
  if (!fromAcc || !toAcc) {
    return { ok: false, error: 'Treasury account not found.' };
  }

  const loanId = nextInterBranchLoanHumanId(db);
  const createdAtISO = nowIso();
  const planJson = JSON.stringify(repaymentPlan);

  db.prepare(
    `INSERT INTO inter_branch_loans (
      loan_id, created_at_iso, created_by_user_id, created_by_name,
      lender_branch_id, borrower_branch_id, principal_ngn, repaid_ngn,
      from_treasury_account_id, to_treasury_account_id, date_iso, reference,
      repayment_plan_json, status, proposed_note
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    loanId,
    createdAtISO,
    actorId(actor),
    actorName(actor),
    lenderBranchId,
    borrowerBranchId,
    principalNgn,
    0,
    fromId,
    toId,
    dateISO,
    reference || null,
    planJson,
    'pending_md',
    proposedNote || null
  );

  appendAuditLog(db, {
    actor,
    action: 'inter_branch_loan.propose',
    entityKind: 'inter_branch_loan',
    entityId: loanId,
    note: reference || 'Inter-branch loan proposed',
    details: { lenderBranchId, borrowerBranchId, principalNgn, fromId, toId },
  });

  return { ok: true, loanId, loan: getInterBranchLoan(db, loanId, 'ALL').loan };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} loanId
 * @param {object|null} actor
 */
export function mdApproveInterBranchLoan(db, loanId, actor) {
  if (!userHasPermission(actor, 'inter_branch_loan.md_approve')) {
    return { ok: false, error: 'MD approval permission required.' };
  }

  const row = db.prepare(`SELECT * FROM inter_branch_loans WHERE loan_id = ?`).get(loanId);
  if (!row) return { ok: false, error: 'Loan not found.' };
  if (row.status !== 'pending_md') {
    return { ok: false, error: 'Only loans pending MD approval can be approved.' };
  }

  const amountNgn = roundMoney(row.principal_ngn);
  const fromId = Number(row.from_treasury_account_id);
  const toId = Number(row.to_treasury_account_id);
  if (!fromId || !toId || fromId === toId) {
    return { ok: false, error: 'Invalid treasury accounts on loan.' };
  }

  const ref = String(row.reference || loanId).trim() || loanId;
  const batchId = nextTreasuryTransferBatchHumanId(db);
  const approvedAt = nowIso();
  const createdBy = actorName(actor);

  try {
    assertPeriodOpen(db, row.date_iso || new Date().toISOString().slice(0, 10), 'Inter-branch loan date');
    db.transaction(() => {
      insertTreasuryMovementTx(db, {
        type: 'INTERNAL_TRANSFER_OUT',
        treasuryAccountId: fromId,
        amountNgn: -amountNgn,
        postedAtISO: row.date_iso,
        reference: ref,
        counterpartyKind: 'BRANCH',
        counterpartyId: row.borrower_branch_id,
        counterpartyName: `Borrower branch ${row.borrower_branch_id}`,
        sourceKind: 'INTER_BRANCH_LOAN',
        sourceId: loanId,
        note: `Inter-branch lend out (${loanId})`,
        createdBy,
        batchId,
        workspaceBranchId: row.lender_branch_id,
      });
      insertTreasuryMovementTx(db, {
        type: 'INTERNAL_TRANSFER_IN',
        treasuryAccountId: toId,
        amountNgn,
        postedAtISO: row.date_iso,
        reference: ref,
        counterpartyKind: 'BRANCH',
        counterpartyId: row.lender_branch_id,
        counterpartyName: `Lender branch ${row.lender_branch_id}`,
        sourceKind: 'INTER_BRANCH_LOAN',
        sourceId: loanId,
        note: `Inter-branch lend in (${loanId})`,
        createdBy,
        batchId,
        workspaceBranchId: row.borrower_branch_id,
      });

      db.prepare(
        `UPDATE inter_branch_loans SET
          status = 'active',
          md_approved_at_iso = ?,
          md_approved_by_user_id = ?,
          md_approved_by_name = ?,
          treasury_batch_id = ?,
          executed_at_iso = ?
        WHERE loan_id = ?`
      ).run(
        approvedAt,
        actorId(actor),
        actorName(actor),
        batchId,
        approvedAt,
        loanId
      );

      appendAuditLog(db, {
        actor,
        action: 'inter_branch_loan.md_approve',
        entityKind: 'inter_branch_loan',
        entityId: loanId,
        note: 'MD approved inter-branch disbursement',
        details: { batchId, amountNgn, fromId, toId },
      });
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  return { ok: true, loanId, treasuryBatchId: batchId, loan: getInterBranchLoan(db, loanId, 'ALL').loan };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} loanId
 * @param {object} body
 * @param {object|null} actor
 */
export function mdRejectInterBranchLoan(db, loanId, body, actor) {
  if (!userHasPermission(actor, 'inter_branch_loan.md_approve')) {
    return { ok: false, error: 'MD approval permission required.' };
  }
  const note = String(body?.note || '').trim();
  const row = db.prepare(`SELECT * FROM inter_branch_loans WHERE loan_id = ?`).get(loanId);
  if (!row) return { ok: false, error: 'Loan not found.' };
  if (row.status !== 'pending_md') {
    return { ok: false, error: 'Only loans pending MD approval can be rejected.' };
  }

  db.prepare(
    `UPDATE inter_branch_loans SET
      status = 'rejected',
      md_rejected_at_iso = ?,
      md_reject_note = ?
    WHERE loan_id = ?`
  ).run(nowIso(), note || null, loanId);

  appendAuditLog(db, {
    actor,
    action: 'inter_branch_loan.md_reject',
    entityKind: 'inter_branch_loan',
    entityId: loanId,
    note: note || 'Rejected',
  });

  return { ok: true, loanId };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} loanId
 * @param {object} body
 * @param {object|null} actor
 */
export function recordInterBranchLoanRepayment(db, loanId, body, actor) {
  const row = db.prepare(`SELECT * FROM inter_branch_loans WHERE loan_id = ?`).get(loanId);
  if (!row) return { ok: false, error: 'Loan not found.' };
  if (row.status !== 'active') {
    return { ok: false, error: 'Repayments are only allowed on active loans.' };
  }

  const amountNgn = roundMoney(body?.amountNgn);
  const fromId = Number(body?.fromTreasuryAccountId);
  const toId = Number(body?.toTreasuryAccountId);
  const dateISO = String(body?.dateISO || new Date().toISOString().slice(0, 10)).trim();
  const note = String(body?.note || '').trim();

  if (amountNgn <= 0) return { ok: false, error: 'Repayment amount must be positive.' };
  if (!fromId || !toId || fromId === toId) {
    return { ok: false, error: 'Choose two different treasury accounts.' };
  }

  const principal = roundMoney(row.principal_ngn);
  const repaid = roundMoney(row.repaid_ngn);
  const outstanding = Math.max(0, principal - repaid);
  if (amountNgn > outstanding) {
    return { ok: false, error: 'Repayment exceeds outstanding balance.' };
  }

  const batchId = nextTreasuryTransferBatchHumanId(db);
  const repayId = nextInterBranchLoanRepaymentHumanId(db);
  const createdBy = actorName(actor);

  try {
    assertPeriodOpen(db, dateISO, 'Inter-branch repayment date');
    db.transaction(() => {
      insertTreasuryMovementTx(db, {
        type: 'INTERNAL_TRANSFER_OUT',
        treasuryAccountId: fromId,
        amountNgn: -amountNgn,
        postedAtISO: dateISO,
        reference: `Repay ${loanId}`,
        counterpartyKind: 'BRANCH',
        counterpartyId: row.lender_branch_id,
        counterpartyName: `Repay to lender ${row.lender_branch_id}`,
        sourceKind: 'INTER_BRANCH_LOAN_REPAY',
        sourceId: loanId,
        note: note || `Inter-branch repayment (${loanId})`,
        createdBy,
        batchId,
        workspaceBranchId: row.borrower_branch_id,
      });
      insertTreasuryMovementTx(db, {
        type: 'INTERNAL_TRANSFER_IN',
        treasuryAccountId: toId,
        amountNgn,
        postedAtISO: dateISO,
        reference: `Repay ${loanId}`,
        counterpartyKind: 'BRANCH',
        counterpartyId: row.borrower_branch_id,
        counterpartyName: `Repayment from borrower ${row.borrower_branch_id}`,
        sourceKind: 'INTER_BRANCH_LOAN_REPAY',
        sourceId: loanId,
        note: note || `Inter-branch repayment (${loanId})`,
        createdBy,
        batchId,
        workspaceBranchId: row.lender_branch_id,
      });

      const nextRepaid = repaid + amountNgn;
      const nextStatus = nextRepaid >= principal ? 'closed' : 'active';
      db.prepare(`UPDATE inter_branch_loans SET repaid_ngn = ?, status = ? WHERE loan_id = ?`).run(
        nextRepaid,
        nextStatus,
        loanId
      );

      db.prepare(
        `INSERT INTO inter_branch_loan_repayments (
          id, loan_id, posted_at_iso, amount_ngn,
          from_treasury_account_id, to_treasury_account_id, treasury_batch_id, note,
          created_by_user_id, created_by_name
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        repayId,
        loanId,
        dateISO,
        amountNgn,
        fromId,
        toId,
        batchId,
        note || null,
        actorId(actor),
        createdBy
      );

      appendAuditLog(db, {
        actor,
        action: 'inter_branch_loan.repay',
        entityKind: 'inter_branch_loan',
        entityId: loanId,
        note: note || 'Repayment',
        details: { amountNgn, batchId, repayId, nextStatus },
      });
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  return { ok: true, repaymentId: repayId, loan: getInterBranchLoan(db, loanId, 'ALL').loan };
}
