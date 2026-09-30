/**
 * Finance corrections for two payout mistakes:
 * - expense charged to the wrong till/bank (move it, even if that account's book is short)
 * - a customer refund posted as an expense (take the cash back so Sales can raise a normal refund)
 *
 * Money: moving an account restores the wrong till and charges the right one.
 * Releasing a refund expense restores the till and removes or zeroes that expense.
 */
import { userHasPermission } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { appendAuditLog, assertPeriodOpen } from '../controlOps.js';
import {
  ensureTreasuryCashGlAccount,
  tryPostExpensePaymentGlTx,
  tryPostExpensePaymentReversalGlTx,
} from '../accountingPostingOps.js';
import { postBalancedJournalTx } from '../glOps.js';
import {
  deleteExpenseRolloutDup,
  expenseOutflowTreasuryMovementCorrectTx,
  insertTreasuryMovementTx,
  reversePaymentRequestTreasuryPayouts,
  reverseTreasurySourceTx,
} from '../writeOps.js';

const MAX_BATCH = 40;

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function actorLabel(actor) {
  return String(actor?.displayName || actor?.username || actor?.name || 'Finance').trim() || 'Finance';
}

function asIdList(value) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

function periodOpen(db, dateISO, label) {
  try {
    assertPeriodOpen(db, dateISO, label);
    return { open: true };
  } catch (e) {
    return { open: false, error: String(e.message || e) };
  }
}

export function userMayMoveExpensePayout(user) {
  return userHasPermission(user, 'finance.pay') || userHasPermission(user, 'finance.post');
}

export function userMayReleaseExpenseRefund(user) {
  return userHasPermission(user, 'finance.reverse');
}

/** Canonical refund categories posted on the expense register instead of Sales → Refunds. */
export function isDirectRefundExpenseCategory(category) {
  const s = String(category || '')
    .trim()
    .toLowerCase();
  return s === 'refund' || s === 'refunds' || s === 'customer refund';
}

function payoutWhereSql() {
  return `
    tm.amount_ngn < 0
    AND (tm.reverses_movement_id IS NULL OR TRIM(COALESCE(tm.reverses_movement_id, '')) = '')
    AND NOT EXISTS (
      SELECT 1 FROM treasury_movements rev WHERE rev.reverses_movement_id = tm.id
    )
    AND (
      (tm.type = 'EXPENSE' AND tm.source_kind = 'EXPENSE')
      OR (tm.type = 'PAYMENT_REQUEST_OUT' AND tm.source_kind = 'PAYMENT_REQUEST')
    )
  `;
}

/**
 * Posted expense payouts still sitting on one till/bank.
 * @param {import('better-sqlite3').Database} db
 */
export function listExpensePayoutsOnAccount(db, opts = {}) {
  const branchId = String(opts.branchId || '').trim();
  const accountId = Number(opts.treasuryAccountId) || 0;
  const q = String(opts.q || '').trim().toLowerCase();
  const like = `%${q}%`;
  const limit = Math.min(80, Math.max(1, Number(opts.limit) || 80));
  if (!branchId || !accountId) return [];
  const rows = db
    .prepare(
      `SELECT tm.id AS movementId,
              tm.amount_ngn AS amountNgn,
              tm.posted_at_iso AS postedAtISO,
              tm.treasury_account_id AS treasuryAccountId,
              tm.source_kind AS sourceKind,
              tm.source_id AS sourceId,
              tm.type AS movementType,
              tm.reference AS movementReference,
              COALESCE(e.expense_id, e2.expense_id) AS expenseId,
              COALESCE(e.category, e2.category) AS category,
              COALESCE(e.expense_type, e2.expense_type) AS expenseType,
              COALESCE(e.reference, e2.reference, tm.reference) AS reference,
              COALESCE(e.date, e2.date) AS expenseDate,
              COALESCE(e.branch_id, e2.branch_id) AS branchId,
              ta.name AS accountName
       FROM treasury_movements tm
       JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
       LEFT JOIN expenses e ON tm.source_kind = 'EXPENSE' AND e.expense_id = tm.source_id
       LEFT JOIN payment_requests pr ON tm.source_kind = 'PAYMENT_REQUEST' AND pr.request_id = tm.source_id
       LEFT JOIN expenses e2 ON e2.expense_id = pr.expense_id
       WHERE ${payoutWhereSql()}
         AND tm.treasury_account_id = ?
         AND COALESCE(e.branch_id, e2.branch_id) = ?
         AND (
           ? = ''
           OR LOWER(COALESCE(e.expense_id, e2.expense_id, '')) LIKE ?
           OR LOWER(COALESCE(e.reference, e2.reference, tm.reference, '')) LIKE ?
           OR LOWER(COALESCE(e.category, e2.category, '')) LIKE ?
           OR LOWER(COALESCE(e.expense_type, e2.expense_type, '')) LIKE ?
           OR LOWER(COALESCE(tm.source_id, '')) LIKE ?
         )
       ORDER BY tm.posted_at_iso DESC, tm.id DESC
       LIMIT ?`
    )
    .all(accountId, branchId, q, like, like, like, like, like, limit);
  return rows.map((row) => ({
    movementId: String(row.movementId),
    amountNgn: Math.abs(roundMoney(row.amountNgn)),
    postedAtISO: row.postedAtISO,
    treasuryAccountId: Number(row.treasuryAccountId),
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    expenseId: row.expenseId || '',
    category: row.category || '',
    expenseType: row.expenseType || '',
    reference: row.reference || '',
    expenseDate: row.expenseDate || '',
    accountName: row.accountName || '',
  }));
}

/**
 * Refund-category expenses that already left a till, so a normal refund would pay twice.
 * @param {import('better-sqlite3').Database} db
 */
export function listDirectExpenseRefunds(db, opts = {}) {
  const branchId = String(opts.branchId || '').trim();
  const limit = Math.min(80, Math.max(1, Number(opts.limit) || 80));
  if (!branchId) return [];
  const rows = db
    .prepare(
      `SELECT tm.id AS movementId,
              tm.amount_ngn AS amountNgn,
              tm.posted_at_iso AS postedAtISO,
              COALESCE(e.expense_id, e2.expense_id) AS expenseId,
              COALESCE(e.category, e2.category) AS category,
              COALESCE(e.expense_type, e2.expense_type) AS expenseType,
              COALESCE(e.reference, e2.reference, tm.reference) AS reference,
              COALESCE(e.date, e2.date) AS expenseDate,
              COALESCE(e.amount_ngn, e2.amount_ngn) AS expenseAmountNgn,
              ta.name AS accountName
       FROM treasury_movements tm
       JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
       LEFT JOIN expenses e ON tm.source_kind = 'EXPENSE' AND e.expense_id = tm.source_id
       LEFT JOIN payment_requests pr ON tm.source_kind = 'PAYMENT_REQUEST' AND pr.request_id = tm.source_id
       LEFT JOIN expenses e2 ON e2.expense_id = pr.expense_id
       WHERE ${payoutWhereSql()}
         AND COALESCE(e.branch_id, e2.branch_id) = ?
         AND LOWER(COALESCE(e.category, e2.category, '')) IN ('refund', 'refunds', 'customer refund')
       ORDER BY tm.posted_at_iso DESC, tm.id DESC
       LIMIT ?`
    )
    .all(branchId, Math.max(limit * 4, limit));
  const byExpense = new Map();
  for (const row of rows) {
    if (!isDirectRefundExpenseCategory(row.category)) continue;
    const expenseId = String(row.expenseId || '').trim();
    if (!expenseId) continue;
    const prev = byExpense.get(expenseId);
    const amountNgn = Math.abs(roundMoney(row.amountNgn));
    if (!prev) {
      byExpense.set(expenseId, {
        expenseId,
        category: row.category,
        expenseType: row.expenseType || '',
        reference: row.reference || '',
        expenseDate: row.expenseDate || '',
        amountNgn,
        accountName: row.accountName || '',
        movementCount: 1,
      });
    } else {
      prev.amountNgn += amountNgn;
      prev.movementCount += 1;
      if (row.accountName && !String(prev.accountName).includes(row.accountName)) {
        prev.accountName = `${prev.accountName}, ${row.accountName}`;
      }
    }
    if (byExpense.size >= limit) break;
  }
  return [...byExpense.values()];
}

function loadPayoutMovement(db, movementId) {
  return db
    .prepare(
      `SELECT tm.*,
              COALESCE(e.expense_id, e2.expense_id) AS expense_id,
              COALESCE(e.category, e2.category) AS category,
              COALESCE(e.branch_id, e2.branch_id) AS expense_branch_id
       FROM treasury_movements tm
       LEFT JOIN expenses e ON tm.source_kind = 'EXPENSE' AND e.expense_id = tm.source_id
       LEFT JOIN payment_requests pr ON tm.source_kind = 'PAYMENT_REQUEST' AND pr.request_id = tm.source_id
       LEFT JOIN expenses e2 ON e2.expense_id = pr.expense_id
       WHERE tm.id = ?`
    )
    .get(movementId);
}

function assertPayoutBranch(row, workspaceBranchId, workspaceViewAll, actor) {
  const bid = String(row?.expense_branch_id || '').trim();
  const wb = String(workspaceBranchId || DEFAULT_BRANCH_ID).trim();
  if (!bid || bid === wb) return { ok: true };
  if (workspaceViewAll && (userHasPermission(actor, '*') || userHasPermission(actor, 'finance.cross_branch_post'))) {
    return { ok: true };
  }
  if (userHasPermission(actor, 'finance.cross_branch_post') || userHasPermission(actor, '*')) return { ok: true };
  return { ok: false, error: 'Switch to this expense’s branch, then move the payout.' };
}

function postCashReclassGl(db, payload) {
  const magnitude = Math.abs(roundMoney(payload.amountNgn));
  if (magnitude <= 0) return { ok: true, skipped: true };
  const fromCash = ensureTreasuryCashGlAccount(db, payload.fromTreasuryAccountId);
  const toCash = ensureTreasuryCashGlAccount(db, payload.toTreasuryAccountId);
  if (!fromCash.ok) return fromCash;
  if (!toCash.ok) return toCash;
  const orig = db
    .prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'EXPENSE_PAYMENT_GL' AND source_id = ?`)
    .get(payload.originalMovementId);
  if (!orig) return { ok: true, skipped: true, reason: 'no_original_gl' };
  if (fromCash.accountCode === toCash.accountCode) return { ok: true, skipped: true };
  return postBalancedJournalTx(db, {
    entryDateISO: payload.entryDateISO,
    memo: payload.memo,
    sourceKind: 'EXPENSE_PAYOUT_ACCOUNT_RECLASS_GL',
    sourceId: `${payload.originalMovementId}:to:${payload.toTreasuryAccountId}`,
    branchId: payload.branchId || null,
    createdByUserId: payload.createdByUserId || null,
    lines: [
      { accountCode: fromCash.accountCode, debitNgn: magnitude, memo: payload.memo },
      { accountCode: toCash.accountCode, creditNgn: magnitude, memo: payload.memo },
    ],
  });
}

function postReversalGlIfPresent(db, payload) {
  ensureTreasuryCashGlAccount(db, payload.treasuryAccountId);
  const orig = db
    .prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'EXPENSE_PAYMENT_GL' AND source_id = ?`)
    .get(payload.originalMovementId);
  if (!orig) return { ok: true, skipped: true, reason: 'no_original_gl' };
  return tryPostExpensePaymentReversalGlTx(db, payload);
}

/**
 * When the payout month is locked, restore the wrong account and charge the right one today.
 * The original line stays, marked reversed, so the closed month is not rewritten.
 */
function movePayoutOnOpenDateTx(db, row, toAccount, actor, note, today) {
  const magnitude = Math.abs(roundMoney(row.amount_ngn));
  const fromName = String(
    db.prepare(`SELECT name FROM treasury_accounts WHERE id = ?`).get(row.treasury_account_id)?.name || 'the old account'
  );
  const toName = String(toAccount.name || 'the correct account');
  const postedAtISO = `${today}T12:00:00.000Z`;
  const memo =
    note ||
    `Payout was on ${fromName}. The cash left ${toName}. ${String(row.posted_at_iso || '').slice(0, 7)} is locked, so this correction is dated ${today}.`;
  const reversalType = String(row.type) === 'PAYMENT_REQUEST_OUT' ? 'PAYMENT_REQUEST_REVERSAL_IN' : 'EXPENSE_REVERSAL_IN';
  const reversal = insertTreasuryMovementTx(db, {
    type: reversalType,
    treasuryAccountId: row.treasury_account_id,
    amountNgn: magnitude,
    postedAtISO,
    reference: row.reference,
    counterpartyKind: row.counterparty_kind,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    note: memo,
    createdBy: actorLabel(actor),
    reversesMovementId: row.id,
    allowNegativeBalance: true,
    branchId: row.expense_branch_id || undefined,
  });
  const charge = insertTreasuryMovementTx(db, {
    type: row.type,
    treasuryAccountId: toAccount.id,
    amountNgn: -magnitude,
    postedAtISO,
    reference: row.reference,
    counterpartyKind: row.counterparty_kind,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    note: memo,
    createdBy: actorLabel(actor),
    allowNegativeBalance: true,
    branchId: row.expense_branch_id || undefined,
  });
  const glRev = postReversalGlIfPresent(db, {
    treasuryAccountId: row.treasury_account_id,
    amountNgn: magnitude,
    entryDateISO: today,
    sourceId: reversal.id,
    originalMovementId: row.id,
    expenseCategory: row.category || 'Others',
    paymentRequestId: row.source_kind === 'PAYMENT_REQUEST' ? row.source_id : undefined,
    branchId: row.expense_branch_id || null,
    createdByUserId: actor?.id != null ? String(actor.id) : null,
    memo,
  });
  if (!glRev.ok && !glRev.skipped && !glRev.duplicate) {
    throw new Error(glRev.error || 'Could not reverse the expense on the general ledger.');
  }
  if (!glRev.skipped || glRev.duplicate) {
    const glNew = tryPostExpensePaymentGlTx(db, {
      treasuryAccountId: toAccount.id,
      amountNgn: magnitude,
      entryDateISO: today,
      sourceId: charge.id,
      expenseCategory: row.category || 'Others',
      paymentRequestId: row.source_kind === 'PAYMENT_REQUEST' ? row.source_id : undefined,
      branchId: row.expense_branch_id || null,
      createdByUserId: actor?.id != null ? String(actor.id) : null,
      memo,
    });
    if (!glNew.ok && !glNew.skipped && !glNew.duplicate) {
      throw new Error(glNew.error || 'Could not charge the correct account on the general ledger.');
    }
  }
  const stamp = `Corrected ${today}: restored here and charged to ${toName}.`;
  const prevNote = String(row.note || '');
  if (!prevNote.includes(stamp)) {
    db.prepare(`UPDATE treasury_movements SET note = ? WHERE id = ?`).run(
      prevNote ? `${prevNote} — ${stamp}` : stamp,
      row.id
    );
  }
  appendAuditLog(db, {
    actor,
    action: 'treasury.expense_payout_reclass_open_date',
    entityKind: 'treasury_movement',
    entityId: String(row.id),
    note: memo,
    details: {
      fromTreasuryAccountId: Number(row.treasury_account_id),
      toTreasuryAccountId: Number(toAccount.id),
      amountNgn: magnitude,
      reversalMovementId: reversal.id,
      chargeMovementId: charge.id,
      correctionDate: today,
    },
  });
  return {
    ok: true,
    movementId: String(row.id),
    mode: 'open_period_adjustment',
    fromTreasuryAccountId: Number(row.treasury_account_id),
    toTreasuryAccountId: Number(toAccount.id),
    amountNgn: magnitude,
  };
}

function moveOnePayoutTx(db, movementId, toAccount, actor, payload, today) {
  const row = loadPayoutMovement(db, movementId);
  if (!row) return { ok: false, error: `Payout ${movementId} was not found.` };
  const type = String(row.type || '');
  const sourceKind = String(row.source_kind || '');
  const allowed =
    (type === 'EXPENSE' && sourceKind === 'EXPENSE') ||
    (type === 'PAYMENT_REQUEST_OUT' && sourceKind === 'PAYMENT_REQUEST');
  if (!allowed) return { ok: false, error: 'Only an expense payout can be moved to another account.' };
  if (row.reverses_movement_id) return { ok: false, error: 'This line is already a reversal.' };
  const reversed = db.prepare(`SELECT id FROM treasury_movements WHERE reverses_movement_id = ?`).get(row.id);
  if (reversed) return { ok: false, error: 'This payout was already corrected.' };
  if (roundMoney(row.amount_ngn) >= 0) return { ok: false, error: 'This line is not an outflow.' };
  const branch = assertPayoutBranch(row, payload.workspaceBranchId, payload.workspaceViewAll, actor);
  if (!branch.ok) return branch;

  const oldAcc = Number(row.treasury_account_id);
  if (oldAcc === Number(toAccount.id)) {
    return { ok: true, skipped: true, movementId: String(row.id) };
  }

  const movementDay = String(row.posted_at_iso || '').slice(0, 10);
  const locked = periodOpen(db, movementDay, 'Expense pay-from correction date');
  const note = String(payload.note || '').trim();
  if (!locked.open) {
    const todayOpen = periodOpen(db, today, 'Payout account correction date');
    if (!todayOpen.open) {
      return {
        ok: false,
        error: `${locked.error} Today is locked as well. Unlock the current month in Settings → Governance, then move the payout.`,
      };
    }
    return movePayoutOnOpenDateTx(db, row, toAccount, actor, note, today);
  }

  const moved = expenseOutflowTreasuryMovementCorrectTx(
    db,
    String(row.id),
    {
      treasuryAccountId: Number(toAccount.id),
      note: note || `Payout moved to ${toAccount.name || 'the account that paid'}`,
      workspaceBranchId: payload.workspaceBranchId,
      workspaceViewAll: Boolean(payload.workspaceViewAll),
      allowDestinationShortfall: true,
    },
    actor
  );
  if (!moved.ok) return moved;
  const gl = postCashReclassGl(db, {
    originalMovementId: String(row.id),
    fromTreasuryAccountId: oldAcc,
    toTreasuryAccountId: Number(toAccount.id),
    amountNgn: Math.abs(roundMoney(row.amount_ngn)),
    entryDateISO: movementDay,
    branchId: row.expense_branch_id || null,
    createdByUserId: actor?.id != null ? String(actor.id) : null,
    memo: note || `Payout account correction ${row.source_id || row.id}`,
  });
  if (!gl.ok && !gl.skipped && !gl.duplicate) {
    throw new Error(gl.error || 'The till moved, but the general ledger cash account did not.');
  }
  return {
    ok: true,
    movementId: String(row.id),
    mode: 'in_place',
    fromTreasuryAccountId: oldAcc,
    toTreasuryAccountId: Number(toAccount.id),
    amountNgn: Math.abs(roundMoney(row.amount_ngn)),
  };
}

/**
 * Move selected expense payouts onto the account that actually paid.
 * Destination book balance may go negative: the cash has already left that account.
 * @param {import('better-sqlite3').Database} db
 * @param {{ movementIds?: string[], toTreasuryAccountId?: number, note?: string, workspaceBranchId?: string, workspaceViewAll?: boolean }} payload
 * @param {object | null} actor
 */
export function reassignExpensePayouts(db, payload = {}, actor = null) {
  if (!userMayMoveExpensePayout(actor)) {
    return { ok: false, error: 'Finance pay or post permission is required to move a payout to another account.' };
  }
  const ids = asIdList(payload.movementIds);
  if (!ids.length) return { ok: false, error: 'Select at least one payout to move.' };
  if (ids.length > MAX_BATCH) return { ok: false, error: `Move at most ${MAX_BATCH} payouts at a time.` };
  const toId = Number(payload.toTreasuryAccountId);
  if (!toId) return { ok: false, error: 'Choose the account that actually paid.' };
  const toAccount = db.prepare(`SELECT id, name, branch_id FROM treasury_accounts WHERE id = ?`).get(toId);
  if (!toAccount) return { ok: false, error: 'That bank account was not found.' };

  const today = new Date().toISOString().slice(0, 10);
  const moved = [];
  let skipped = 0;
  try {
    db.transaction(() => {
      for (const movementId of ids) {
        const result = moveOnePayoutTx(db, movementId, toAccount, actor, payload, today);
        if (!result.ok) throw new Error(result.error || 'Could not move that payout.');
        if (result.skipped) skipped += 1;
        else moved.push(result);
      }
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  if (!moved.length) {
    return { ok: true, moved, skipped, message: 'Those payouts are already on that account.' };
  }
  const adjusted = moved.filter((row) => row.mode === 'open_period_adjustment').length;
  const name = String(toAccount.name || 'the correct account');
  const message = adjusted
    ? `Moved ${moved.length} payout(s) to ${name}. ${adjusted} original month(s) are locked, so those corrections are dated today.`
    : `Moved ${moved.length} payout(s) to ${name}.`;
  return { ok: true, moved, skipped, message };
}

function zeroReleasedExpense(db, expense, note) {
  const stamp = 'Released so a normal refund can be raised';
  const reference = String(expense.reference || '').trim();
  const nextRef = reference.includes(stamp) ? reference : reference ? `${reference} — ${stamp}` : stamp;
  db.prepare(`UPDATE expenses SET amount_ngn = 0, reference = ? WHERE expense_id = ?`).run(nextRef, expense.expense_id);
  const requests = db.prepare(`SELECT request_id FROM payment_requests WHERE expense_id = ?`).all(expense.expense_id);
  for (const pr of requests) {
    db.prepare(
      `UPDATE payment_requests
       SET approval_status = 'Cancelled', paid_amount_ngn = 0, paid_at_iso = '', paid_by = '', payment_note = ?
       WHERE request_id = ?`
    ).run(note, pr.request_id);
  }
}

function releaseOneExpenseRefundTx(db, expenseId, actor, payload, today) {
  const expense = db.prepare(`SELECT * FROM expenses WHERE expense_id = ?`).get(expenseId);
  if (!expense) return { ok: false, error: `Expense ${expenseId} was not found.` };
  if (!isDirectRefundExpenseCategory(expense.category)) {
    return {
      ok: false,
      error: `${expenseId} is not an expense refund. Only a Refund category expense can be cleared here.`,
    };
  }
  const branch = assertPayoutBranch(
    { expense_branch_id: expense.branch_id },
    payload.workspaceBranchId,
    payload.workspaceViewAll,
    actor
  );
  if (!branch.ok) return branch;

  const expenseDate = String(expense.date || '').slice(0, 10) || today;
  const expensePeriod = periodOpen(db, expenseDate, 'Remove expense refund');
  const note =
    String(payload.note || '').trim() ||
    `Expense refund ${expenseId} cleared so it can be raised as a normal refund.`;

  if (expensePeriod.open) {
    const requests = db.prepare(`SELECT request_id, paid_amount_ngn FROM payment_requests WHERE expense_id = ?`).all(expenseId);
    for (const pr of requests) {
      if (roundMoney(pr.paid_amount_ngn) <= 0) continue;
      const reversed = reversePaymentRequestTreasuryPayouts(
        db,
        pr.request_id,
        {
          note,
          actedAtISO: `${today}T12:00:00.000Z`,
          workspaceBranchId: payload.workspaceBranchId,
          workspaceViewAll: Boolean(payload.workspaceViewAll),
          skipInnerTransaction: true,
        },
        actor
      );
      if (!reversed.ok) return reversed;
    }
    const deleted = deleteExpenseRolloutDup(db, expenseId, actor, { skipInnerTransaction: true });
    if (!deleted.ok) return deleted;
    return { ok: true, expenseId, mode: 'deleted' };
  }

  const todayOpen = periodOpen(db, today, 'Remove expense refund');
  if (!todayOpen.open) {
    return {
      ok: false,
      error: `${expensePeriod.error} Today is locked as well. Unlock the current month in Settings → Governance, then remove the expense refund.`,
    };
  }

  const requests = db.prepare(`SELECT request_id, paid_amount_ngn FROM payment_requests WHERE expense_id = ?`).all(expenseId);
  for (const pr of requests) {
    if (roundMoney(pr.paid_amount_ngn) <= 0) continue;
    const reversed = reversePaymentRequestTreasuryPayouts(
      db,
      pr.request_id,
      {
        note,
        actedAtISO: `${today}T12:00:00.000Z`,
        workspaceBranchId: payload.workspaceBranchId,
        workspaceViewAll: Boolean(payload.workspaceViewAll),
        skipInnerTransaction: true,
      },
      actor
    );
    if (!reversed.ok) return reversed;
  }

  const reversals = reverseTreasurySourceTx(db, 'EXPENSE', expenseId, 'EXPENSE_REVERSAL_IN', note, actor, {
    postedAtISO: `${today}T12:00:00.000Z`,
  });
  for (const mv of reversals) {
    const reversalRow = db.prepare(`SELECT reverses_movement_id, amount_ngn, treasury_account_id FROM treasury_movements WHERE id = ?`).get(mv.id);
    const origId = String(reversalRow?.reverses_movement_id || '').trim();
    if (!origId) continue;
    const glRev = postReversalGlIfPresent(db, {
      treasuryAccountId: reversalRow.treasury_account_id,
      amountNgn: Math.abs(roundMoney(reversalRow.amount_ngn)),
      entryDateISO: today,
      sourceId: mv.id,
      originalMovementId: origId,
      expenseCategory: expense.category || 'Refund',
      branchId: expense.branch_id || null,
      createdByUserId: actor?.id != null ? String(actor.id) : null,
      memo: note,
    });
    if (!glRev.ok && !glRev.skipped && !glRev.duplicate) {
      throw new Error(glRev.error || 'Could not reverse the expense refund on the general ledger.');
    }
  }

  zeroReleasedExpense(db, expense, note);
  appendAuditLog(db, {
    actor,
    action: 'expense.release_direct_refund',
    entityKind: 'expense',
    entityId: expenseId,
    note,
    details: { mode: 'zeroed', expenseDate, correctionDate: today },
  });
  return { ok: true, expenseId, mode: 'zeroed' };
}

/**
 * Undo a refund that was posted as an expense, restoring the till.
 * When the expense month is open the row is deleted. When it is locked the amount is zeroed
 * and the cash is restored today, so Sales can raise a normal refund without paying twice.
 * @param {import('better-sqlite3').Database} db
 * @param {{ expenseIds?: string[], note?: string, workspaceBranchId?: string, workspaceViewAll?: boolean }} payload
 * @param {object | null} actor
 */
export function releaseDirectExpenseRefunds(db, payload = {}, actor = null) {
  if (!userMayReleaseExpenseRefund(actor)) {
    return {
      ok: false,
      error: 'finance.reverse is required to remove an expense refund. Ask a finance manager.',
    };
  }
  const ids = asIdList(payload.expenseIds);
  if (!ids.length) return { ok: false, error: 'Select at least one expense refund to remove.' };
  if (ids.length > MAX_BATCH) return { ok: false, error: `Remove at most ${MAX_BATCH} expense refunds at a time.` };

  const today = new Date().toISOString().slice(0, 10);
  const released = [];
  try {
    db.transaction(() => {
      for (const expenseId of ids) {
        const result = releaseOneExpenseRefundTx(db, expenseId, actor, payload, today);
        if (!result.ok) throw new Error(result.error || 'Could not remove that expense refund.');
        released.push(result);
      }
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  const zeroed = released.filter((row) => row.mode === 'zeroed').length;
  const message = zeroed
    ? `Cleared ${released.length} expense refund(s) and put the cash back. ${zeroed} sit in a locked month, so those rows were zeroed instead of deleted. Raise each one under Sales → Refunds and pay it from the account that sent the money.`
    : `Removed ${released.length} expense refund(s) and put the cash back. Raise each one under Sales → Refunds and pay it from the account that sent the money.`;
  return { ok: true, released, message };
}
