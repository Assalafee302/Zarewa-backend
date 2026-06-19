/**
 * Staff financial obligations — unified loan / purchase / recovery ledger.
 * @module server/staffObligationOps
 */
import crypto from 'node:crypto';
import { getBranchCodeUpper, bumpHumanSerial } from './humanId.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { hrTablesReady, appendHrAuditEvent, nowIso } from './hrOps.js';
import { userHasPermission } from './auth.js';

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

export const OBLIGATION_KIND = {
  LOAN: 'loan',
  PURCHASE: 'purchase',
  RECOVERY: 'recovery',
  LEGACY: 'legacy',
};

export const OBLIGATION_ORIGIN = {
  NEW: 'new',
  MIGRATED: 'migrated',
};

export const OBLIGATION_STATUS = {
  PENDING_APPROVAL: 'pending_approval',
  PENDING_DISBURSEMENT: 'approved_pending_disbursement',
  ACTIVE: 'active',
  PAID_OFF: 'paid_off',
  WRITTEN_OFF: 'closed_written_off',
  SUSPENDED: 'suspended',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
};

export const OBLIGATION_TX_TYPE = {
  OPENING_BALANCE: 'opening_balance',
  DISBURSEMENT: 'disbursement',
  PAYROLL_DEDUCTION: 'payroll_deduction',
  CASH_REPAYMENT: 'cash_repayment',
  PURCHASE_RECOGNITION: 'purchase_recognition',
  ADJUSTMENT: 'adjustment',
  WRITE_OFF: 'write_off',
};

function newTxId() {
  return `OBLTX-${crypto.randomBytes(8).toString('hex')}`;
}

function newReceiptRef(db, branchId) {
  const code = getBranchCodeUpper(db, branchId);
  const yy = String(new Date().getFullYear()).slice(-2);
  const scope = `RCP-STF:${code}:${yy}`;
  const seq = bumpHumanSerial(db, scope);
  return `RCP-STF-${code}-${yy}-${String(seq).padStart(4, '0')}`;
}

export function staffObligationTablesReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_staff_obligation_accounts'`).get()
    );
  } catch {
    try {
      return Boolean(
        db
          .prepare(
            `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'hr_staff_obligation_accounts' LIMIT 1`
          )
          .get()
      );
    } catch {
      return false;
    }
  }
}

function nextObligationId(db, branchId) {
  const code = getBranchCodeUpper(db, branchId);
  const yy = String(new Date().getFullYear()).slice(-2);
  const scope = `OBL:${code}:${yy}`;
  const seq = bumpHumanSerial(db, scope);
  return `OBL-${code}-${yy}-${String(seq).padStart(4, '0')}`;
}

export function mapObligationAccountRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    branchId: row.branch_id,
    kind: row.kind,
    origin: row.origin,
    title: row.title,
    principalOriginalNgn: Math.round(Number(row.principal_original_ngn) || 0),
    principalOutstandingNgn: Math.round(Number(row.principal_outstanding_ngn) || 0),
    installmentNgn: Math.round(Number(row.installment_ngn) || 0),
    termMonths: Math.round(Number(row.term_months) || 0),
    monthsPaid: Math.round(Number(row.months_paid) || 0),
    status: row.status,
    deductionsActive: Boolean(row.deductions_active),
    hrRequestId: row.hr_request_id || null,
    quotationRef: row.quotation_ref || null,
    disciplineCaseId: row.discipline_case_id || null,
    recoveryScheduleId: row.recovery_schedule_id || null,
    financePaymentRequestId: row.finance_payment_request_id || null,
    disbursedAtIso: row.disbursed_at_iso || null,
    dueDateIso: row.due_date_iso || null,
    note: row.note || null,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}

export function mapObligationTransactionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    amountNgn: Math.round(Number(row.amount_ngn) || 0),
    principalBeforeNgn: Math.round(Number(row.principal_before_ngn) || 0),
    principalAfterNgn: Math.round(Number(row.principal_after_ngn) || 0),
    effectiveAtIso: row.effective_at_iso,
    sourceKind: row.source_kind || null,
    sourceId: row.source_id || null,
    paymentReference: row.payment_reference || null,
    note: row.note || null,
    recordedByUserId: row.recorded_by_user_id || null,
    createdAtIso: row.created_at_iso,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} accountId
 * @param {object} tx
 */
function postObligationTransactionTx(db, accountId, tx) {
  const acct = db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(accountId);
  if (!acct) throw new Error('Obligation account not found.');

  const type = String(tx.type || '').trim();
  const amountNgn = Math.max(0, Math.round(Number(tx.amountNgn) || 0));
  const principalBefore = Math.round(Number(acct.principal_outstanding_ngn) || 0);
  let principalAfter = principalBefore;

  const increasesBalance = new Set([
    OBLIGATION_TX_TYPE.OPENING_BALANCE,
    OBLIGATION_TX_TYPE.DISBURSEMENT,
    OBLIGATION_TX_TYPE.PURCHASE_RECOGNITION,
  ]);
  const decreasesBalance = new Set([
    OBLIGATION_TX_TYPE.PAYROLL_DEDUCTION,
    OBLIGATION_TX_TYPE.CASH_REPAYMENT,
    OBLIGATION_TX_TYPE.WRITE_OFF,
  ]);

  if (increasesBalance.has(type)) {
    principalAfter = principalBefore + amountNgn;
  } else if (decreasesBalance.has(type)) {
    if (amountNgn > principalBefore) throw new Error('Transaction exceeds outstanding balance.');
    principalAfter = principalBefore - amountNgn;
  } else if (type === OBLIGATION_TX_TYPE.ADJUSTMENT) {
    const delta = Math.round(Number(tx.adjustmentDeltaNgn) || 0);
    principalAfter = Math.max(0, principalBefore + delta);
  } else {
    throw new Error(`Unknown obligation transaction type: ${type}`);
  }

  const now = nowIso();
  const txId = tx.id || newTxId();
  db.prepare(
    `INSERT INTO hr_staff_obligation_transactions (
      id, account_id, type, amount_ngn, principal_before_ngn, principal_after_ngn,
      effective_at_iso, source_kind, source_id, payment_reference, note, recorded_by_user_id, created_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    txId,
    accountId,
    type,
    amountNgn,
    principalBefore,
    principalAfter,
    String(tx.effectiveAtIso || now).trim(),
    tx.sourceKind ? String(tx.sourceKind) : null,
    tx.sourceId ? String(tx.sourceId) : null,
    tx.paymentReference ? String(tx.paymentReference) : null,
    tx.note ? String(tx.note) : null,
    tx.recordedByUserId ? String(tx.recordedByUserId) : null,
    now
  );

  let status = acct.status;
  let deductionsActive = acct.deductions_active;
  let monthsPaid = Math.round(Number(acct.months_paid) || 0);

  if (type === OBLIGATION_TX_TYPE.PAYROLL_DEDUCTION && amountNgn > 0) {
    monthsPaid += 1;
  }
  if (principalAfter <= 0) {
    status = OBLIGATION_STATUS.PAID_OFF;
    deductionsActive = 0;
    principalAfter = 0;
  } else if (status === OBLIGATION_STATUS.PENDING_DISBURSEMENT && type === OBLIGATION_TX_TYPE.DISBURSEMENT) {
    status = OBLIGATION_STATUS.ACTIVE;
    deductionsActive = 1;
  } else if (
    status === OBLIGATION_STATUS.PENDING_DISBURSEMENT &&
    type === OBLIGATION_TX_TYPE.OPENING_BALANCE &&
    acct.origin === OBLIGATION_ORIGIN.MIGRATED
  ) {
    status = OBLIGATION_STATUS.ACTIVE;
    deductionsActive = 1;
  } else if (status === OBLIGATION_STATUS.PENDING_APPROVAL && type === OBLIGATION_TX_TYPE.PURCHASE_RECOGNITION) {
    status = OBLIGATION_STATUS.ACTIVE;
    deductionsActive = 1;
  }

  db.prepare(
    `UPDATE hr_staff_obligation_accounts SET
      principal_outstanding_ngn = ?,
      months_paid = ?,
      status = ?,
      deductions_active = ?,
      updated_at_iso = ?,
      disbursed_at_iso = COALESCE(?, disbursed_at_iso)
     WHERE id = ?`
  ).run(
    principalAfter,
    monthsPaid,
    status,
    deductionsActive ? 1 : 0,
    now,
    tx.disbursedAtIso || null,
    accountId
  );

  return {
    transaction: mapObligationTransactionRow(db.prepare(`SELECT * FROM hr_staff_obligation_transactions WHERE id = ?`).get(txId)),
    account: mapObligationAccountRow(
      db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(accountId)
    ),
  };
}

export function postObligationTransaction(db, accountId, tx) {
  return postObligationTransactionTx(db, accountId, tx);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} payload
 */
export function insertObligationAccount(db, payload) {
  if (!staffObligationTablesReady(db)) return { ok: false, error: 'Staff obligation ledger not migrated.' };
  const userId = String(payload.userId || '').trim();
  if (!userId) return { ok: false, error: 'userId is required.' };
  const prof = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  const branchId = String(payload.branchId || prof?.branch_id || DEFAULT_BRANCH_ID).trim();
  const id = payload.id || nextObligationId(db, branchId);
  const now = nowIso();
  const principalOriginal = Math.round(Number(payload.principalOriginalNgn) || 0);
  const principalOutstanding = Math.round(
    Number(payload.principalOutstandingNgn ?? payload.principalOriginalNgn) || 0
  );

  db.prepare(
    `INSERT INTO hr_staff_obligation_accounts (
      id, user_id, branch_id, kind, origin, title,
      principal_original_ngn, principal_outstanding_ngn, installment_ngn, term_months, months_paid,
      status, deductions_active, hr_request_id, quotation_ref, discipline_case_id,
      finance_payment_request_id, disbursed_at_iso, due_date_iso, note,
      created_at_iso, updated_at_iso, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    userId,
    branchId,
    String(payload.kind || OBLIGATION_KIND.LOAN),
    String(payload.origin || OBLIGATION_ORIGIN.NEW),
    String(payload.title || 'Staff obligation').trim(),
    principalOriginal,
    principalOutstanding,
    Math.round(Number(payload.installmentNgn) || 0),
    Math.round(Number(payload.termMonths) || 0),
    Math.round(Number(payload.monthsPaid) || 0),
    String(payload.status || OBLIGATION_STATUS.PENDING_DISBURSEMENT),
    payload.deductionsActive === false ? 0 : 1,
    payload.hrRequestId ? String(payload.hrRequestId) : null,
    payload.quotationRef ? String(payload.quotationRef) : null,
    payload.disciplineCaseId ? String(payload.disciplineCaseId) : null,
    payload.financePaymentRequestId ? String(payload.financePaymentRequestId) : null,
    payload.disbursedAtIso ? String(payload.disbursedAtIso) : null,
    payload.dueDateIso ? String(payload.dueDateIso) : null,
    payload.note ? String(payload.note) : null,
    now,
    now,
    payload.createdByUserId ? String(payload.createdByUserId) : null
  );

  return { ok: true, account: mapObligationAccountRow(db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(id)) };
}

/**
 * Open obligation when GM approves a new staff loan (before cashier payout).
 * @param {import('better-sqlite3').Database} db
 * @param {object} requestRow hr_requests row
 * @param {object | null} actor
 */
export function openLoanObligationFromHrApproval(db, requestRow, actor = null) {
  if (!staffObligationTablesReady(db) || !requestRow) return { ok: false, skipped: true };
  if (String(requestRow.kind) !== 'loan') return { ok: false, error: 'Not a loan request.' };
  const hrId = String(requestRow.id);
  const existing = db.prepare(`SELECT id FROM hr_staff_obligation_accounts WHERE hr_request_id = ?`).get(hrId);
  if (existing) {
    return { ok: true, accountId: existing.id, already: true };
  }

  const payload = safeJsonParse(requestRow.payload_json, {});
  const loanRow = db.prepare(`SELECT * FROM hr_request_loan WHERE request_id = ?`).get(hrId);
  const amountNgn = Math.round(Number(loanRow?.amount_ngn ?? payload.amountNgn) || 0);
  const termMonths = Math.round(Number(loanRow?.repayment_months ?? payload.repaymentMonths) || 0);
  const installmentNgn = Math.round(Number(loanRow?.deduction_per_month_ngn ?? payload.deductionPerMonthNgn) || 0);
  const title = String(requestRow.title || loanRow?.purpose || payload.purpose || 'Staff loan').trim();

  const ins = insertObligationAccount(db, {
    userId: requestRow.user_id,
    branchId: requestRow.branch_id,
    kind: OBLIGATION_KIND.LOAN,
    origin: OBLIGATION_ORIGIN.NEW,
    title,
    principalOriginalNgn: amountNgn,
    principalOutstandingNgn: 0,
    installmentNgn,
    termMonths,
    status: OBLIGATION_STATUS.PENDING_DISBURSEMENT,
    deductionsActive: false,
    hrRequestId: hrId,
    financePaymentRequestId: payload.financePaymentRequestId ? String(payload.financePaymentRequestId) : null,
    createdByUserId: actor?.id || null,
  });
  if (!ins.ok) return ins;

  db.prepare(`UPDATE hr_requests SET payload_json = ? WHERE id = ?`).run(
    JSON.stringify({ ...payload, obligationAccountId: ins.account.id }),
    hrId
  );

  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    action: 'hr.obligation.opened',
    entityKind: 'hr_staff_obligation_account',
    entityId: ins.account.id,
    branchId: requestRow.branch_id,
    details: { hrRequestId: hrId, kind: OBLIGATION_KIND.LOAN, origin: OBLIGATION_ORIGIN.NEW },
  });

  return { ok: true, account: ins.account };
}

/**
 * Cashier payout completed — activate loan and post disbursement transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {{ paymentRequestId: string; disbursedAtIso?: string; amountNgn?: number }} payload
 */
export function activateLoanObligationOnDisbursement(db, payload) {
  if (!staffObligationTablesReady(db)) return { ok: false, skipped: true };
  const prId = String(payload.paymentRequestId || '').trim();
  if (!prId) return { ok: false, error: 'paymentRequestId required.' };

  let account = db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE finance_payment_request_id = ?`).get(prId);
  if (!account) {
    const rows = db.prepare(`SELECT id, payload_json FROM hr_requests WHERE kind = 'loan' AND status = 'approved'`).all();
    for (const r of rows) {
      const p = safeJsonParse(r.payload_json, {});
      if (String(p.financePaymentRequestId || '') !== prId) continue;
      account = db
        .prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE hr_request_id = ?`)
        .get(r.id);
      if (!account) {
        const opened = openLoanObligationFromHrApproval(db, r, null);
        if (opened.ok && opened.account) {
          account = db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(opened.account.id);
        }
      }
      break;
    }
  }
  if (!account) return { ok: false, skipped: true, reason: 'no_linked_account' };

  const day = String(payload.disbursedAtIso || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const existing = db
    .prepare(
      `SELECT id FROM hr_staff_obligation_transactions WHERE account_id = ? AND type = ? AND source_id = ? LIMIT 1`
    )
    .get(account.id, OBLIGATION_TX_TYPE.DISBURSEMENT, prId);
  if (existing) return { ok: true, already: true, accountId: account.id };

  const amountNgn = Math.round(
    Number(payload.amountNgn) || Number(account.principal_original_ngn) || 0
  );

  const run = db.transaction(() =>
    postObligationTransactionTx(db, account.id, {
      type: OBLIGATION_TX_TYPE.DISBURSEMENT,
      amountNgn,
      effectiveAtIso: `${day}T12:00:00.000Z`,
      sourceKind: 'payment_request',
      sourceId: prId,
      disbursedAtIso: day,
      note: 'Loan disbursement via treasury payout',
    })
  )();

  db.prepare(
    `UPDATE hr_staff_obligation_accounts SET finance_payment_request_id = ?, disbursed_at_iso = ? WHERE id = ?`
  ).run(prId, day, account.id);

  return { ok: true, accountId: account.id, ...run };
}

/**
 * Register a legacy / pre-ERP staff loan — no finance payout.
 * @param {import('better-sqlite3').Database} db
 * @param {object | null} actor
 * @param {object} body
 */
export function migrateLegacyStaffLoan(db, actor, body = {}) {
  if (!staffObligationTablesReady(db)) return { ok: false, error: 'Staff obligation ledger not migrated.' };
  const userId = String(body.userId || '').trim();
  if (!userId) return { ok: false, error: 'userId is required.' };

  const original = Math.round(Number(body.principalOriginalNgn ?? body.originalAmountNgn) || 0);
  const repaid = Math.round(Number(body.amountRepaidNgn ?? body.alreadyRepaidNgn) || 0);
  const outstanding = Math.round(Number(body.principalOutstandingNgn) || Math.max(0, original - repaid));
  const installmentNgn = Math.round(Number(body.installmentNgn ?? body.deductionPerMonthNgn) || 0);
  const termMonths = Math.round(Number(body.termMonths ?? body.repaymentMonths) || 0);

  if (original <= 0) return { ok: false, error: 'Original loan amount must be greater than zero.' };
  if (outstanding < 0 || outstanding > original) {
    return { ok: false, error: 'Outstanding must be between 0 and original amount.' };
  }
  if (outstanding > 0 && installmentNgn <= 0) {
    return { ok: false, error: 'Monthly installment is required when balance remains.' };
  }

  const prof = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  if (!prof) return { ok: false, error: 'Staff profile not found.' };

  const title = String(body.title || body.purpose || 'Legacy staff loan').trim();
  const disbursedAt = String(body.disbursedAtIso ?? body.originalDisbursementDate ?? '').slice(0, 10) || null;
  const monthsPaid =
    installmentNgn > 0 ? Math.max(0, Math.round((original - outstanding) / installmentNgn)) : 0;

  const ins = insertObligationAccount(db, {
    userId,
    branchId: body.branchId || prof.branch_id,
    kind: OBLIGATION_KIND.LOAN,
    origin: OBLIGATION_ORIGIN.MIGRATED,
    title,
    principalOriginalNgn: original,
    principalOutstandingNgn: 0,
    installmentNgn,
    termMonths,
    monthsPaid: 0,
    status: OBLIGATION_STATUS.ACTIVE,
    deductionsActive: outstanding > 0,
    disbursedAtIso: disbursedAt,
    note: String(body.note || body.reference || 'Pre-ERP loan register').trim(),
    createdByUserId: actor?.id || null,
  });
  if (!ins.ok) return ins;

  const accountId = ins.account.id;
  db.transaction(() => {
    postObligationTransactionTx(db, accountId, {
      type: OBLIGATION_TX_TYPE.OPENING_BALANCE,
      amountNgn: original,
      effectiveAtIso: disbursedAt ? `${disbursedAt}T12:00:00.000Z` : nowIso(),
      note: 'Legacy loan opening balance',
      recordedByUserId: actor?.id || null,
    });
    if (repaid > 0) {
      postObligationTransactionTx(db, accountId, {
        type: OBLIGATION_TX_TYPE.CASH_REPAYMENT,
        amountNgn: repaid,
        effectiveAtIso: nowIso(),
        paymentReference: String(body.priorRepaymentReference || 'legacy-prior-repayments'),
        note: 'Amount already repaid before system migration',
        recordedByUserId: actor?.id || null,
      });
    }
  })();

  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    action: 'hr.obligation.migrate_legacy',
    entityKind: 'hr_staff_obligation_account',
    entityId: accountId,
    branchId: prof.branch_id,
    details: { userId, original, outstanding, installmentNgn },
  });

  return {
    ok: true,
    account: mapObligationAccountRow(db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(accountId)),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object | null} actor
 * @param {string} accountId
 * @param {object} body
 */
export function recordObligationCashRepayment(db, actor, accountId, body = {}) {
  if (!staffObligationTablesReady(db)) return { ok: false, error: 'Staff obligation ledger not migrated.' };
  const id = String(accountId || '').trim();
  const row = db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Obligation account not found.' };
  if (![OBLIGATION_STATUS.ACTIVE, OBLIGATION_STATUS.PENDING_DISBURSEMENT].includes(String(row.status))) {
    return { ok: false, error: 'Only active obligations can receive payments.' };
  }

  const outstanding = Math.round(Number(row.principal_outstanding_ngn) || 0);
  if (outstanding <= 0) return { ok: false, error: 'Nothing outstanding.' };

  const payInFull = body.payInFull === true;
  let amountNgn = payInFull ? outstanding : Math.round(Number(body.amountNgn) || 0);
  if (amountNgn <= 0) return { ok: false, error: 'Payment amount must be greater than zero.' };
  if (amountNgn > outstanding) {
    return { ok: false, error: `Payment cannot exceed outstanding (₦${outstanding.toLocaleString('en-NG')}).` };
  }

  const paymentDate =
    String(body.paymentDateIso ?? body.payment_date_iso ?? '').trim().slice(0, 10) ||
    new Date().toISOString().slice(0, 10);
  const paymentReference =
    String(body.paymentReference ?? body.payment_reference ?? '').trim() ||
    newReceiptRef(db, row.branch_id);
  const note = String(body.note ?? '').trim() || null;

  const result = db.transaction(() =>
    postObligationTransactionTx(db, id, {
      type: OBLIGATION_TX_TYPE.CASH_REPAYMENT,
      amountNgn,
      effectiveAtIso: `${paymentDate}T12:00:00.000Z`,
      sourceKind: 'cash_repayment',
      sourceId: paymentReference,
      paymentReference,
      note,
      recordedByUserId: actor?.id || null,
    })
  )();

  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    action: 'hr.obligation.cash_repayment',
    entityKind: 'hr_staff_obligation_account',
    entityId: id,
    details: { amountNgn, paymentReference, principalAfter: result.account.principalOutstandingNgn },
  });

  if (String(row.kind) === OBLIGATION_KIND.LOAN && row.hr_request_id) {
    syncLoanRequestPayloadFromObligation(db, id);
  }

  return { ok: true, receiptReference: paymentReference, ...result };
}

/**
 * Keep legacy hr_requests.payload_json in sync with the obligation ledger (loan kind only).
 * @param {import('better-sqlite3').Database} db
 * @param {string} accountIdOrHrRequestId obligation account id or hr_requests.id
 */
export function syncLoanRequestPayloadFromObligation(db, accountIdOrHrRequestId) {
  if (!staffObligationTablesReady(db)) return { ok: false, skipped: true };
  const key = String(accountIdOrHrRequestId || '').trim();
  if (!key) return { ok: false, error: 'account or request id required.' };

  let account = db
    .prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ? AND kind = ?`)
    .get(key, OBLIGATION_KIND.LOAN);
  let hrRequestId = account?.hr_request_id || null;
  if (!account) {
    hrRequestId = key;
    account = db
      .prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE hr_request_id = ? AND kind = ?`)
      .get(hrRequestId, OBLIGATION_KIND.LOAN);
  }
  if (!account || !hrRequestId) return { ok: false, skipped: true };

  const loan = db.prepare(`SELECT id, payload_json FROM hr_requests WHERE id = ? AND kind = 'loan'`).get(hrRequestId);
  if (!loan) return { ok: false, skipped: true };

  const p = safeJsonParse(loan.payload_json, {});
  const outstanding = Math.round(Number(account.principal_outstanding_ngn) || 0);
  const monthsPaid = Math.round(Number(account.months_paid) || 0);
  const termMonths = Math.round(Number(account.term_months) || 0);
  const installmentNgn = Math.round(Number(account.installment_ngn) || 0);
  const deductionsActive = Boolean(account.deductions_active);
  const status = String(account.status);
  const today = new Date().toISOString().slice(0, 10);

  const merged = {
    ...p,
    obligationAccountId: account.id,
    principalOutstandingNgn: outstanding,
    deductionsActive,
    loanMonthsDeducted: monthsPaid,
    deductionPerMonthNgn: installmentNgn || p.deductionPerMonthNgn,
    repaymentMonths: termMonths || p.repaymentMonths,
  };
  if (account.disbursed_at_iso && !merged.loanDisbursedAtIso) {
    merged.loanDisbursedAtIso = String(account.disbursed_at_iso).slice(0, 10);
  }
  if (status === OBLIGATION_STATUS.PAID_OFF || outstanding <= 0) {
    merged.deductionsActive = false;
    merged.principalOutstandingNgn = 0;
    if (!merged.loanRepaidByPrincipalAtIso) merged.loanRepaidByPrincipalAtIso = today;
  }
  if (termMonths > 0 && monthsPaid >= termMonths) {
    merged.deductionsActive = false;
    if (!merged.loanRepaidByScheduleAtIso) merged.loanRepaidByScheduleAtIso = today;
  }

  db.prepare(`UPDATE hr_requests SET payload_json = ? WHERE id = ?`).run(JSON.stringify(merged), loan.id);
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} accountId
 * @param {string} userId
 * @param {number} deductedNgn
 * @param {string} [payrollRunId]
 */
export function settleObligationAfterPayrollDeduction(db, accountId, userId, deductedNgn, payrollRunId = '') {
  if (!staffObligationTablesReady(db)) return;
  const id = String(accountId || '').trim();
  const row = db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ? AND user_id = ?`).get(id, userId);
  if (!row || !row.deductions_active) return;

  const ded = Math.max(0, Math.round(Number(deductedNgn) || 0));
  if (ded <= 0) return;

  const runId = String(payrollRunId || '').trim();
  if (runId) {
    const dup = db
      .prepare(
        `SELECT id FROM hr_staff_obligation_transactions WHERE account_id = ? AND type = ? AND source_id = ? LIMIT 1`
      )
      .get(id, OBLIGATION_TX_TYPE.PAYROLL_DEDUCTION, runId);
    if (dup) return;
  }

  postObligationTransactionTx(db, id, {
    type: OBLIGATION_TX_TYPE.PAYROLL_DEDUCTION,
    amountNgn: ded,
    effectiveAtIso: nowIso(),
    sourceKind: 'payroll_run',
    sourceId: runId || null,
    note: 'Payroll loan recovery',
  });
  if (String(row.kind) === OBLIGATION_KIND.LOAN && row.hr_request_id) {
    syncLoanRequestPayloadFromObligation(db, id);
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function activeObligationBreakdownForPayroll(db, userId, kinds = [OBLIGATION_KIND.LOAN, OBLIGATION_KIND.PURCHASE]) {
  if (!staffObligationTablesReady(db)) return null;
  const kindList = Array.isArray(kinds) ? kinds : [kinds];
  const placeholders = kindList.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM hr_staff_obligation_accounts
       WHERE user_id = ? AND kind IN (${placeholders}) AND deductions_active = 1 AND status = ?
       AND principal_outstanding_ngn > 0`
    )
    .all(userId, ...kindList, OBLIGATION_STATUS.ACTIVE);

  const items = [];
  for (const row of rows) {
    let amountNgn = Math.round(Number(row.installment_ngn) || 0);
    const outstanding = Math.round(Number(row.principal_outstanding_ngn) || 0);
    if (amountNgn <= 0 || outstanding <= 0) continue;
    amountNgn = Math.min(amountNgn, outstanding);
    const termMonths = Math.round(Number(row.term_months) || 0);
    const monthsPaid = Math.round(Number(row.months_paid) || 0);
    if (termMonths > 0 && monthsPaid >= termMonths) continue;
    items.push({
      obligationAccountId: row.id,
      hrRequestId: row.hr_request_id || row.id,
      amountNgn,
      title: row.title || (row.kind === OBLIGATION_KIND.PURCHASE ? 'Staff purchase credit' : row.kind === OBLIGATION_KIND.RECOVERY ? 'Incident recovery' : 'Staff loan'),
      kind: row.kind,
      quotationRef: row.quotation_ref || null,
      recoveryScheduleId: row.recovery_schedule_id || null,
    });
  }
  return {
    total: items.reduce((s, x) => s + x.amountNgn, 0),
    items,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ userId?: string; kind?: string; status?: string; branchId?: string }} filter
 */
export function listStaffObligationAccounts(db, filter = {}) {
  if (!staffObligationTablesReady(db)) return [];
  let sql = `SELECT o.*, u.display_name AS staff_display_name
    FROM hr_staff_obligation_accounts o
    JOIN app_users u ON u.id = o.user_id WHERE 1=1`;
  const args = [];
  if (filter.userId) {
    sql += ` AND o.user_id = ?`;
    args.push(String(filter.userId));
  }
  if (filter.kind) {
    sql += ` AND o.kind = ?`;
    args.push(String(filter.kind));
  }
  if (filter.status) {
    sql += ` AND o.status = ?`;
    args.push(String(filter.status));
  }
  if (filter.branchId && filter.branchId !== 'ALL') {
    sql += ` AND o.branch_id = ?`;
    args.push(String(filter.branchId));
  }
  sql += ` ORDER BY o.updated_at_iso DESC LIMIT 500`;
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => ({
      ...mapObligationAccountRow(row),
      staffDisplayName: row.staff_display_name || row.user_id,
    }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} accountId
 */
export function getStaffObligationAccountDetail(db, accountId) {
  if (!staffObligationTablesReady(db)) return null;
  const id = String(accountId || '').trim();
  const row = db
    .prepare(
      `SELECT o.*, u.display_name AS staff_display_name, u.username AS staff_username
       FROM hr_staff_obligation_accounts o
       JOIN app_users u ON u.id = o.user_id WHERE o.id = ?`
    )
    .get(id);
  if (!row) return null;
  const transactions = db
    .prepare(
      `SELECT * FROM hr_staff_obligation_transactions WHERE account_id = ? ORDER BY created_at_iso DESC LIMIT 200`
    )
    .all(id)
    .map(mapObligationTransactionRow);
  return {
    ...mapObligationAccountRow(row),
    staffDisplayName: row.staff_display_name,
    staffUsername: row.staff_username,
    transactions,
  };
}

/**
 * Schedule DTO for My Profile (obligation-first).
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function getStaffObligationLoanSchedule(db, userId) {
  if (!staffObligationTablesReady(db)) return null;
  const accounts = listStaffObligationAccounts(db, { userId, kind: OBLIGATION_KIND.LOAN });
  return accounts
    .filter((a) =>
      [
        OBLIGATION_STATUS.ACTIVE,
        OBLIGATION_STATUS.PENDING_DISBURSEMENT,
        OBLIGATION_STATUS.PAID_OFF,
      ].includes(String(a.status))
    )
    .map((a) => ({
      obligationAccountId: a.id,
      requestId: a.hrRequestId || a.id,
      title: a.title,
      amountNgn: a.principalOriginalNgn,
      repaymentMonths: a.termMonths,
      monthlyDeductionNgn: a.installmentNgn,
      monthsPaid: a.monthsPaid,
      outstandingNgn: a.principalOutstandingNgn,
      deductionsActive: a.deductionsActive && a.principalOutstandingNgn > 0,
      status:
        a.principalOutstandingNgn <= 0
          ? 'paid_off'
          : a.status === OBLIGATION_STATUS.PENDING_DISBURSEMENT
            ? 'pending_disbursement'
            : a.deductionsActive
              ? 'active'
              : 'inactive',
      disbursedAtIso: a.disbursedAtIso,
      origin: a.origin,
    }));
}

/**
 * Creditors register items from obligation accounts.
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
export function buildStaffObligationCreditorItems(db, branchScope, kind = OBLIGATION_KIND.LOAN) {
  if (!staffObligationTablesReady(db) || !hrTablesReady(db)) return [];
  const filter = { kind };
  if (branchScope && branchScope !== 'ALL') filter.branchId = branchScope;
  const accounts = listStaffObligationAccounts(db, filter);
  return accounts
    .filter((a) => a.principalOutstandingNgn > 0 && a.status !== OBLIGATION_STATUS.CANCELLED)
    .map((a) => ({
      id: a.id,
      partyName: a.staffDisplayName || a.userId,
      partyRef: a.userId,
      branchId: a.branchId || '',
      amountNgn: a.principalOutstandingNgn,
      reference: a.quotationRef || a.hrRequestId || a.id,
      asAtDateIso: String(a.disbursedAtIso || a.dueDateIso || '').slice(0, 10) || null,
      detail: `${a.kind} · ${a.monthsPaid}/${a.termMonths || '—'} mo · ₦${a.installmentNgn.toLocaleString('en-NG')}/mo`,
      status: a.status,
      entityType: 'staff',
      entityId: a.userId,
      obligationAccountId: a.id,
      obligationKind: a.kind,
    }))
    .sort((a, b) => b.amountNgn - a.amountNgn);
}

/**
 * Backfill obligation accounts from approved loan requests.
 * @param {import('better-sqlite3').Database} db
 */
export function backfillStaffObligationsFromLoans(db) {
  if (!staffObligationTablesReady(db) || !hrTablesReady(db)) return { ok: false, skipped: true };
  const rows = db
    .prepare(`SELECT * FROM hr_requests WHERE kind = 'loan' AND status = 'approved'`)
    .all();
  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    const existing = db.prepare(`SELECT id FROM hr_staff_obligation_accounts WHERE hr_request_id = ?`).get(row.id);
    if (existing) {
      skipped += 1;
      continue;
    }
    const payload = safeJsonParse(row.payload_json, {});
    const disbursed = Boolean(payload.loanDisbursedAtIso);
    const opened = openLoanObligationFromHrApproval(db, row, null);
    if (!opened.ok) continue;
    created += 1;
    if (disbursed && opened.account) {
      const prId = String(payload.financePaymentRequestId || '').trim();
      const amt = Math.round(Number(opened.account.principalOriginalNgn) || Number(payload.amountNgn) || 0);
      if (prId) {
        activateLoanObligationOnDisbursement(db, {
          paymentRequestId: prId,
          disbursedAtIso: payload.loanDisbursedAtIso,
          amountNgn: amt,
        });
      } else if (amt > 0) {
        db.transaction(() => {
          postObligationTransactionTx(db, opened.account.id, {
            type: OBLIGATION_TX_TYPE.DISBURSEMENT,
            amountNgn: amt,
            effectiveAtIso: `${String(payload.loanDisbursedAtIso).slice(0, 10)}T12:00:00.000Z`,
            note: 'Backfill disbursement from legacy HR payload',
          });
        })();
      }
    }
  }
  return { ok: true, created, skipped };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listObligationScheduleIssues(db) {
  if (!staffObligationTablesReady(db)) return [];
  const issues = [];
  const accounts = listStaffObligationAccounts(db, { kind: OBLIGATION_KIND.LOAN, status: OBLIGATION_STATUS.ACTIVE });
  for (const a of accounts) {
    if (a.principalOutstandingNgn > 0 && !a.installmentNgn) {
      issues.push({ userId: a.userId, obligationAccountId: a.id, issue: 'missing_installment' });
    }
    if (a.principalOutstandingNgn <= 0 && a.deductionsActive) {
      issues.push({ userId: a.userId, obligationAccountId: a.id, issue: 'paid_but_active' });
    }
  }
  return issues.slice(0, 100);
}

export function actorMayManageObligations(actor) {
  if (!actor) return false;
  if (userHasPermission(actor, '*')) return true;
  return userHasPermission(actor, 'hr.loans.manage') || userHasPermission(actor, 'hr.staff.manage');
}
