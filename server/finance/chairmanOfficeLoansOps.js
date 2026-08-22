/**
 * Chairman Office loans — money the company is owed (GL 1200), not owner drawings.
 * Borrower is the Chairman or a named person who is not on staff payroll.
 */
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { insertPaymentRequest } from '../controlOps.js';
import {
  HOW_PAYMENT_REQUEST_APPROVE,
  loadPaymentRequestTimelines,
} from './paymentRequestTimelineOps.js';
import { userMayAccessChairmanOffice } from './chairmanOfficeAccess.js';

export const CHAIRMAN_LOAN_CATEGORY = 'Chairman loan';
export const CHAIRMAN_LOAN_BORROWER_KINDS = new Set(['chairman', 'non_staff']);

const HOW_LOAN_REQUEST =
  'Submitted from Chairman Office as a company loan. Cashier pays after Finance/MD approve. GL 1200 Receivable — the borrower owes the company. This is not a drawing and not a staff payroll loan.';
const HOW_LOAN_REPAY =
  'Repayment recorded on Chairman Office. Cash should be receipted on the Finance desk (Dr treasury / Cr 1200). This log does not post GL by itself.';

function roundNgn(n) {
  return Math.round(Number(n) || 0);
}

function nowIso() {
  return new Date().toISOString();
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
  } catch {
    return false;
  }
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function actorLabel(user) {
  return String(user?.displayName || user?.username || user?.id || 'Chairman').trim();
}

function insertLoanEvent(db, { loanId, kind, amountNgn = 0, actor, how, note }) {
  db.prepare(
    `INSERT INTO chairman_office_loan_events
      (id, loan_id, kind, amount_ngn, at_iso, actor_user_id, actor_name, how, note)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    newId('CHLE'),
    loanId,
    kind,
    roundNgn(amountNgn),
    nowIso(),
    actor?.id || null,
    actorLabel(actor),
    how || '',
    String(note || '').trim()
  );
}

function listLoanEvents(db, loanIds) {
  if (!tableExists(db, 'chairman_office_loan_events') || !loanIds.length) return new Map();
  const map = new Map(loanIds.map((id) => [id, []]));
  const rows = db
    .prepare(
      `SELECT id, loan_id, kind, amount_ngn, at_iso, actor_user_id, actor_name, how, note
       FROM chairman_office_loan_events
       WHERE loan_id IN (${loanIds.map(() => '?').join(',')})
       ORDER BY at_iso ASC, id ASC`
    )
    .all(...loanIds);
  for (const row of rows) {
    const list = map.get(row.loan_id);
    if (!list) continue;
    list.push({
      id: `loan:${row.id}`,
      atIso: row.at_iso,
      kind: row.kind,
      title: row.kind === 'repayment' ? 'Repayment recorded' : row.kind === 'requested' ? 'Loan requested' : row.kind,
      actorName: row.actor_name || '',
      actorUserId: row.actor_user_id || '',
      how: row.how || '',
      note: row.note || '',
      amountNgn: roundNgn(row.amount_ngn),
    });
  }
  return map;
}

function repaymentTotal(events) {
  return (events || [])
    .filter((e) => e.kind === 'repayment')
    .reduce((sum, e) => sum + roundNgn(e.amountNgn), 0);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listChairmanOfficeLoans(db) {
  if (!tableExists(db, 'chairman_office_loans')) return [];
  const rows = db
    .prepare(
      `SELECT l.*,
              pr.approval_status, pr.approved_by, pr.approved_at_iso, pr.approval_note,
              pr.paid_amount_ngn, pr.paid_at_iso, pr.paid_by, pr.payment_note,
              pr.request_date, pr.description
       FROM chairman_office_loans l
       LEFT JOIN payment_requests pr ON pr.request_id = l.payment_request_id
       ORDER BY l.created_at_iso DESC
       LIMIT 200`
    )
    .all();

  const requestIds = rows.map((r) => r.payment_request_id).filter(Boolean);
  const loanIds = rows.map((r) => r.id);
  const prTimelines = loadPaymentRequestTimelines(db, requestIds, {
    glCode: '1200',
    glLabel: 'Receivable (company loan)',
  });
  const loanEvents = listLoanEvents(db, loanIds);

  return rows.map((row) => {
    const requested = roundNgn(row.amount_ngn);
    const disbursed = roundNgn(row.paid_amount_ngn);
    const events = loanEvents.get(row.id) || [];
    const repaid = repaymentTotal(events);
    const outstandingNgn = Math.max(0, disbursed - repaid);
    const status = String(row.approval_status || 'Pending').trim() || 'Pending';
    const unpaidDisbursement = disbursed < requested && status.toLowerCase() !== 'rejected';
    const prEvents = (prTimelines.get(row.payment_request_id) || []).filter((e) => e.kind !== 'requested');
    const timeline = [...events, ...prEvents].sort((a, b) =>
      String(a.atIso || '').localeCompare(String(b.atIso || ''))
    );
    return {
      id: row.id,
      borrowerKind: row.borrower_kind,
      borrowerName: row.borrower_name,
      borrowerRelationship: row.borrower_relationship || '',
      amountNgn: requested,
      purpose: row.purpose || '',
      repaymentMonths: Number(row.repayment_months) || 0,
      repaymentMethod: row.repayment_method || 'cash_transfer',
      payeeName: row.payee_name || '',
      payeeBankName: row.payee_bank_name || '',
      payeeAccountNo: row.payee_account_no || '',
      paymentRequestId: row.payment_request_id || '',
      createdByName: row.created_by_name || '',
      createdAtIso: row.created_at_iso || '',
      approvalStatus: status,
      approvedBy: row.approved_by || '',
      approvedAtISO: row.approved_at_iso || '',
      approvalNote: row.approval_note || '',
      disbursedNgn: disbursed,
      paidBy: row.paid_by || '',
      paidAtISO: row.paid_at_iso || '',
      paymentNote: row.payment_note || '',
      repaidNgn: repaid,
      outstandingNgn,
      unpaidDisbursement,
      howApprove: HOW_PAYMENT_REQUEST_APPROVE,
      howPay:
        'Cashier pays from a named treasury account (finance.pay). GL 1200 Receivable — the borrower owes the company. Not drawings, not a staff payroll loan.',
      timeline,
    };
  });
}

/**
 * Validate a Chairman Office loan request without touching the database.
 * @param {object} user
 * @param {object} body
 */
export function parseChairmanOfficeLoanRequest(user, body = {}) {
  if (!userMayAccessChairmanOffice(user)) {
    return { ok: false, error: 'You cannot request a chairman office loan.', code: 'FORBIDDEN' };
  }
  const borrowerKind = String(body.borrowerKind || '').trim().toLowerCase();
  if (!CHAIRMAN_LOAN_BORROWER_KINDS.has(borrowerKind)) {
    return {
      ok: false,
      error: 'Say whether this loan is for the Chairman or for someone who is not staff.',
      code: 'VALIDATION_ERROR',
    };
  }
  const borrowerName = String(
    body.borrowerName || (borrowerKind === 'chairman' ? user?.displayName || 'Chairman' : '')
  ).trim();
  if (borrowerName.length < 2) {
    return { ok: false, error: 'Enter the borrower name.', code: 'VALIDATION_ERROR' };
  }
  const purpose = String(body.purpose || body.reason || '').trim();
  if (purpose.length < 8) {
    return {
      ok: false,
      error: 'Add a short purpose (at least 8 characters) so finance know why the company is lending.',
      code: 'VALIDATION_ERROR',
    };
  }
  const amountNgn = roundNgn(body.amountNgn ?? body.amount);
  if (amountNgn <= 0) {
    return { ok: false, error: 'Enter a loan amount greater than zero.', code: 'VALIDATION_ERROR' };
  }
  const repaymentMonths = Math.max(0, Math.round(Number(body.repaymentMonths) || 0));
  const repaymentMethod = String(body.repaymentMethod || 'cash_transfer').trim() || 'cash_transfer';
  const relationship =
    borrowerKind === 'chairman'
      ? 'self'
      : String(body.borrowerRelationship || body.relationship || '').trim();
  if (borrowerKind === 'non_staff' && relationship.length < 2) {
    return {
      ok: false,
      error: 'Say how this person is related to the office (family, associate, other).',
      code: 'VALIDATION_ERROR',
    };
  }
  return {
    ok: true,
    parsed: {
      borrowerKind,
      borrowerName,
      purpose,
      amountNgn,
      repaymentMonths,
      repaymentMethod,
      relationship: borrowerKind === 'chairman' ? 'self' : relationship,
      payeeName: String(body.payeeName || borrowerName).trim(),
      payeeAccountNo: String(body.payeeAccountNo || '').trim(),
      payeeBankName: String(body.payeeBankName || '').trim(),
      branchId: String(body.workspaceBranchId || body.branchId || '').trim() || DEFAULT_BRANCH_ID,
      kindLabel: borrowerKind === 'chairman' ? 'Chairman' : 'Non-staff',
    },
  };
}

/**
 * @param {{ disbursedNgn?: number; outstandingNgn?: number } | null} loan
 * @param {object} body
 */
export function parseChairmanOfficeLoanRepayment(loan, body = {}) {
  if (!loan) return { ok: false, error: 'Loan not found.', code: 'NOT_FOUND' };
  if (roundNgn(loan.disbursedNgn) <= 0) {
    return {
      ok: false,
      error: 'Finance has not paid this loan out yet. Record a repayment after cashier disbursement.',
      code: 'VALIDATION_ERROR',
    };
  }
  const amountNgn = roundNgn(body.amountNgn ?? body.amount);
  if (amountNgn <= 0) {
    return { ok: false, error: 'Enter a repayment amount greater than zero.', code: 'VALIDATION_ERROR' };
  }
  if (amountNgn > roundNgn(loan.outstandingNgn)) {
    return {
      ok: false,
      error: `Outstanding on this loan is ₦${roundNgn(loan.outstandingNgn).toLocaleString('en-NG')}.`,
      code: 'VALIDATION_ERROR',
    };
  }
  const how = String(body.how || body.note || '').trim();
  if (how.length < 8) {
    return {
      ok: false,
      error: 'Say how the money came back (cash received, bank transfer, and which till or bank).',
      code: 'VALIDATION_ERROR',
    };
  }
  return { ok: true, parsed: { amountNgn, how } };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} body
 */
export function requestChairmanOfficeLoan(db, user, body = {}) {
  const parsedReq = parseChairmanOfficeLoanRequest(user, body);
  if (!parsedReq.ok) return parsedReq;
  if (!tableExists(db, 'chairman_office_loans')) {
    return { ok: false, error: 'Loan register is not ready. Run database migrate.', code: 'NOT_READY' };
  }
  const {
    borrowerKind,
    borrowerName,
    purpose,
    amountNgn,
    repaymentMonths,
    repaymentMethod,
    relationship,
    payeeName,
    payeeAccountNo,
    payeeBankName,
    branchId,
    kindLabel,
  } = parsedReq.parsed;

  const inserted = insertPaymentRequest(
    db,
    {
      expenseCategory: CHAIRMAN_LOAN_CATEGORY,
      description: `Chairman office loan — ${kindLabel} — ${borrowerName} — ${purpose}`,
      categoryJustification: purpose,
      requestDate: nowIso().slice(0, 10),
      workspaceBranchId: branchId,
      payeeName,
      payeeAccountNo,
      payeeBankName,
      lineItems: [
        {
          item: purpose,
          unit: 1,
          unitPriceNgn: amountNgn,
          lineTotalNgn: amountNgn,
        },
      ],
    },
    user
  );
  if (!inserted?.ok) {
    return { ok: false, error: inserted?.error || 'Could not create the loan payment request.', code: 'REQUEST_FAILED' };
  }

  const id = newId('CHLN');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO chairman_office_loans (
      id, borrower_kind, borrower_name, borrower_relationship, amount_ngn, purpose,
      repayment_months, repayment_method, payee_name, payee_bank_name, payee_account_no,
      payment_request_id, created_by_user_id, created_by_name, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    borrowerKind,
    borrowerName,
    relationship,
    amountNgn,
    purpose,
    repaymentMonths || null,
    repaymentMethod,
    payeeName,
    payeeBankName,
    payeeAccountNo,
    inserted.requestID,
    user?.id || null,
    actorLabel(user),
    ts,
    ts
  );
  insertLoanEvent(db, {
    loanId: id,
    kind: 'requested',
    amountNgn,
    actor: user,
    how: HOW_LOAN_REQUEST,
    note: purpose,
  });

  return { ok: true, loanId: id, requestID: inserted.requestID };
}

/**
 * Record a cash repayment against a disbursed chairman-office loan.
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {string} loanId
 * @param {object} body
 */
export function recordChairmanOfficeLoanRepayment(db, user, loanId, body = {}) {
  if (!userMayAccessChairmanOffice(user)) {
    return { ok: false, error: 'You cannot record this repayment.', code: 'FORBIDDEN' };
  }
  const id = String(loanId || '').trim();
  const loans = listChairmanOfficeLoans(db);
  const loan = loans.find((l) => l.id === id);
  const parsed = parseChairmanOfficeLoanRepayment(loan, body);
  if (!parsed.ok) return parsed;
  insertLoanEvent(db, {
    loanId: id,
    kind: 'repayment',
    amountNgn: parsed.parsed.amountNgn,
    actor: user,
    how: HOW_LOAN_REPAY,
    note: parsed.parsed.how,
  });
  db.prepare(`UPDATE chairman_office_loans SET updated_at_iso = ? WHERE id = ?`).run(nowIso(), id);
  return { ok: true, loanId: id };
}

/**
 * Totals for the Chairman Office impact strip.
 * @param {ReturnType<typeof listChairmanOfficeLoans>} loans
 */
export function summarizeChairmanOfficeLoans(loans = []) {
  let pendingDisbursementNgn = 0;
  let outstandingNgn = 0;
  let pendingCount = 0;
  for (const loan of loans) {
    outstandingNgn += roundNgn(loan.outstandingNgn);
    if (loan.unpaidDisbursement) {
      pendingDisbursementNgn += Math.max(0, roundNgn(loan.amountNgn) - roundNgn(loan.disbursedNgn));
      pendingCount += 1;
    }
  }
  return { pendingDisbursementNgn, outstandingNgn, pendingCount };
}
