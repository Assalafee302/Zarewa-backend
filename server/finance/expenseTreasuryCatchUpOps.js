/**
 * Catch-up for bulk-imported expenses that never hit till/bank (or GL cash).
 *
 * Import can write `expenses` without a treasury outflow. Those rows show on the
 * expense list but do not change `treasury_accounts.balance` or the bank statement.
 * This module posts the missing cash line (and GL), or voids memo-only import rows.
 */
import { appendAuditLog, assertPeriodOpen } from '../controlOps.js';
import { assertEntityBranchForWorkspaceWrite, assertTreasuryAccountForWorkspace } from '../branchScope.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { roundMoney, tableExists } from '../ap2ReceivedBasisOps.js';
import { resolveListLimit, sqlLimitOffsetClause } from '../listQueryOpts.js';
import { branchWhere } from '../readModel.js';
import { tryPostExpensePaymentGlTx } from '../accountingPostingOps.js';
import { syncFixedAssetFromCapexExpense } from '../fixedAssetAutomationOps.js';
import { insertTreasuryMovementTx } from '../writeOps.js';
import { resolveTreasuryAccountId } from '../expenseBulkImport.js';

const MAX_BULK = 500;

/** Typed exactly to wipe re-importable expenses on the current branch. */
export const EXPENSE_REIMPORT_CONFIRM_PHRASE = 'REIMPORT EXPENSES';

function actorLabel(actor) {
  return String(actor?.displayName || actor?.display_name || actor?.username || actor?.id || 'Finance').trim();
}

function mapExpenseRow(row, flags = {}) {
  return {
    expenseID: row.expense_id,
    expenseType: row.expense_type,
    amountNgn: roundMoney(row.amount_ngn),
    date: row.date,
    category: row.category,
    paymentMethod: row.payment_method,
    reference: row.reference,
    branchId: row.branch_id ?? '',
    missingTreasury: Boolean(flags.missingTreasury),
    missingGl: Boolean(flags.missingGl),
  };
}

function expenseTreasuryMovements(db, expenseId) {
  return db
    .prepare(
      `SELECT id, treasury_account_id, amount_ngn, posted_at_iso
       FROM treasury_movements
       WHERE source_kind = 'EXPENSE' AND source_id = ?
         AND amount_ngn < 0
         AND (reverses_movement_id IS NULL OR TRIM(COALESCE(reverses_movement_id, '')) = '')`
    )
    .all(expenseId);
}

function paidPaymentRequestCount(db, expenseId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM payment_requests
       WHERE expense_id = ? AND COALESCE(paid_amount_ngn, 0) > 0`
    )
    .get(expenseId);
  return Number(row?.n) || 0;
}

/**
 * True when the expense has no cash outflow and no paid payment request — safe to void.
 * @param {import('better-sqlite3').Database} db
 * @param {string} expenseId
 */
export function isExpenseUnpostedForVoid(db, expenseId) {
  const eid = String(expenseId || '').trim();
  if (!eid) return false;
  const exp = db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = ?`).get(eid);
  if (!exp) return false;
  if (expenseTreasuryMovements(db, eid).length) return false;
  if (paidPaymentRequestCount(db, eid) > 0) return false;
  return true;
}

/**
 * Imported / direct expenses that never reduced till/bank, or reduced till but skipped GL cash.
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} [branchScope]
 * @param {{ limit?: number, offset?: number, category?: string }} [opts]
 */
export function listExpensesMissingBankPosting(db, branchScope = 'ALL', opts = {}) {
  const limit = resolveListLimit({ ...opts, useDefaultLimit: true });
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const lo = sqlLimitOffsetClause(limit, offset);
  const b = branchWhere(db, 'expenses', branchScope);
  const cat = String(opts.category || '').trim();
  const catSql = cat ? ` AND TRIM(e.category) = ?` : '';
  const catArgs = cat ? [cat] : [];
  const glJoin = tableExists(db, 'gl_journal_entries')
    ? `LEFT JOIN gl_journal_entries gl
         ON gl.source_kind = 'EXPENSE_PAYMENT_GL' AND gl.source_id = tm.id`
    : `LEFT JOIN (SELECT NULL AS id, NULL AS source_id) gl ON 1 = 0`;

  const sql = `SELECT e.*,
          tm.id AS treasury_movement_id,
          gl.id AS gl_journal_id
       FROM expenses e
       LEFT JOIN treasury_movements tm
         ON tm.source_kind = 'EXPENSE' AND tm.source_id = e.expense_id
        AND tm.amount_ngn < 0
        AND (tm.reverses_movement_id IS NULL OR TRIM(COALESCE(tm.reverses_movement_id, '')) = '')
       ${glJoin}
       WHERE 1=1${b.sql.replace(/\bbranch_id\b/g, 'e.branch_id')}${catSql}
         AND (tm.id IS NULL OR gl.id IS NULL)
       ORDER BY e.date DESC, e.expense_id DESC${lo.sql}`;

  const rows = db.prepare(sql).all(...b.args, ...catArgs, ...lo.args);
  return rows.map((row) =>
    mapExpenseRow(row, {
      missingTreasury: !row.treasury_movement_id,
      missingGl: Boolean(row.treasury_movement_id) && !row.gl_journal_id,
    })
  );
}

function postGlForExpenseMovement(db, exp, movement, actor) {
  const amt = Math.abs(roundMoney(movement.amount_ngn));
  const glExp = tryPostExpensePaymentGlTx(db, {
    treasuryAccountId: Number(movement.treasury_account_id),
    amountNgn: amt,
    entryDateISO: String(movement.posted_at_iso || exp.date || '').slice(0, 10),
    sourceId: movement.id,
    expenseCategory: exp.category || 'Others',
    branchId: exp.branch_id || null,
    createdByUserId: actor?.id ?? null,
    memo: exp.expense_type || exp.category || `Expense ${exp.expense_id}`,
  });
  if (!glExp.ok && !glExp.skipped && !glExp.duplicate) {
    throw new Error(glExp.error || 'Expense payment GL posting failed.');
  }
  return glExp;
}

function attachTreasuryToExpenseTx(db, exp, treasuryAccountId, actor, opts) {
  const eid = String(exp.expense_id);
  const amountNgn = roundMoney(exp.amount_ngn);
  const expenseDate = String(exp.date || '').trim();
  assertPeriodOpen(db, expenseDate, 'Expense bank posting date');

  const existing = expenseTreasuryMovements(db, eid);
  if (existing.length) {
    const movement = existing[0];
    const gl = postGlForExpenseMovement(db, exp, movement, actor);
    return {
      ok: true,
      expenseID: eid,
      alreadyOnTreasury: true,
      treasuryAccountId: Number(movement.treasury_account_id),
      treasuryMovementId: movement.id,
      glPosted: !gl.skipped,
      glDuplicate: Boolean(gl.duplicate),
    };
  }

  const movement = insertTreasuryMovementTx(db, {
    type: 'EXPENSE',
    treasuryAccountId,
    amountNgn: -amountNgn,
    postedAtISO: expenseDate,
    reference: exp.reference || eid,
    counterpartyKind: 'EXPENSE',
    counterpartyId: eid,
    counterpartyName: exp.category,
    sourceKind: 'EXPENSE',
    sourceId: eid,
    note: exp.expense_type || exp.category,
    createdBy: actorLabel(actor),
    workspaceBranchId: String(opts.workspaceBranchId || exp.branch_id || DEFAULT_BRANCH_ID).trim(),
    workspaceViewAll: Boolean(opts.workspaceViewAll),
    actor,
  });

  postGlForExpenseMovement(
    db,
    exp,
    {
      id: movement.id,
      treasury_account_id: treasuryAccountId,
      amount_ngn: -amountNgn,
      posted_at_iso: expenseDate,
    },
    actor
  );

  const assetSync = syncFixedAssetFromCapexExpense(db, eid, {
    acquisitionDateIso: expenseDate,
    actor,
  });
  if (!assetSync.ok) {
    throw new Error(assetSync.error || 'Could not register fixed asset from capex expense.');
  }

  appendAuditLog(db, {
    actor,
    action: 'expense.attach_treasury',
    entityKind: 'expense',
    entityId: eid,
    note: `Posted imported expense to treasury account ${treasuryAccountId}`,
    details: { amountNgn, treasuryAccountId, treasuryMovementId: movement.id },
  });

  return {
    ok: true,
    expenseID: eid,
    alreadyOnTreasury: false,
    treasuryAccountId,
    treasuryMovementId: movement.id,
    glPosted: true,
    glDuplicate: false,
  };
}

/**
 * Post an already-imported expense onto a bank/cash account.
 * Deducts `treasury_accounts.balance` when no EXPENSE movement exists; always ensures GL cash.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} expenseId
 * @param {{ treasuryAccountId?: number, accountKey?: string, workspaceBranchId?: string, workspaceViewAll?: boolean }} payload
 * @param {object|null} actor
 */
export function attachTreasuryToImportedExpense(db, expenseId, payload = {}, actor = null) {
  const eid = String(expenseId || '').trim();
  if (!eid) return { ok: false, error: 'Expense ID is required.' };
  const exp = db.prepare(`SELECT * FROM expenses WHERE expense_id = ?`).get(eid);
  if (!exp) return { ok: false, error: 'Expense not found.' };

  const branchGate = assertEntityBranchForWorkspaceWrite(
    actor,
    exp.branch_id,
    payload.workspaceBranchId,
    Boolean(payload.workspaceViewAll)
  );
  if (!branchGate.ok) return branchGate;

  const existing = expenseTreasuryMovements(db, eid);
  let treasuryAccountId = Number(payload.treasuryAccountId) || 0;
  if (!treasuryAccountId && payload.accountKey) {
    const resolved = resolveTreasuryAccountId(db, payload.accountKey, exp.branch_id);
    if (!resolved.id) return { ok: false, error: resolved.error || 'Treasury account not found.' };
    treasuryAccountId = resolved.id;
  }
  if (!existing.length && !treasuryAccountId) {
    return { ok: false, error: 'Pick the bank/cash account these expenses were paid from.' };
  }
  if (!existing.length) {
    const accGate = assertTreasuryAccountForWorkspace(db, treasuryAccountId, {
      workspaceBranchId: payload.workspaceBranchId,
      workspaceViewAll: Boolean(payload.workspaceViewAll),
      user: actor,
    });
    if (!accGate.ok) return accGate;
  }

  try {
    let result = { ok: false };
    db.transaction(() => {
      result = attachTreasuryToExpenseTx(db, exp, treasuryAccountId, actor, payload);
    })();
    if (!result.ok) return result;
    const account = db
      .prepare(`SELECT id, name, type, bank_name, balance, branch_id FROM treasury_accounts WHERE id = ?`)
      .get(result.treasuryAccountId);
    return {
      ...result,
      amountNgn: roundMoney(exp.amount_ngn),
      accountName: account?.name || '',
      accountType: account?.type || '',
      bankName: account?.bank_name || '',
      balanceAfterNgn: roundMoney(account?.balance),
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} expenseIds
 * @param {{ treasuryAccountId?: number, accountKey?: string, workspaceBranchId?: string, workspaceViewAll?: boolean }} payload
 * @param {object|null} actor
 */
export function attachTreasuryToImportedExpenses(db, expenseIds, payload = {}, actor = null) {
  const ids = [...new Set((expenseIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return { ok: false, error: 'Select at least one imported expense.' };
  if (ids.length > MAX_BULK) {
    return { ok: false, error: `Post at most ${MAX_BULK} expenses at a time.` };
  }

  const posted = [];
  const failed = [];
  for (const expenseId of ids) {
    const r = attachTreasuryToImportedExpense(db, expenseId, payload, actor);
    if (r.ok) posted.push(r);
    else failed.push({ expenseID: expenseId, error: r.error || 'Could not post to bank.' });
  }
  if (!posted.length) {
    return {
      ok: false,
      error: failed[0]?.error || 'Could not post expenses to the bank account.',
      posted,
      failed,
    };
  }
  return {
    ok: true,
    postedCount: posted.length,
    failedCount: failed.length,
    posted,
    failed,
    message: failed.length
      ? `Posted ${posted.length} expense(s) to the bank book; ${failed.length} could not be posted.`
      : `Posted ${posted.length} expense(s) to the bank book. Balance reduced and statement lines created.`,
  };
}

/**
 * Delete an imported expense that never hit till/bank. Period lock does not apply:
 * these rows are memo-only and are not on the cash book.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} expenseId
 * @param {object|null} actor
 * @param {{ workspaceBranchId?: string, workspaceViewAll?: boolean }} [opts]
 */
export function voidUnpostedImportedExpense(db, expenseId, actor = null, opts = {}) {
  const eid = String(expenseId || '').trim();
  if (!eid) return { ok: false, error: 'Expense ID is required.' };
  const exp = db.prepare(`SELECT * FROM expenses WHERE expense_id = ?`).get(eid);
  if (!exp) return { ok: false, error: 'Expense not found.' };

  const branchGate = assertEntityBranchForWorkspaceWrite(
    actor,
    exp.branch_id,
    opts.workspaceBranchId,
    Boolean(opts.workspaceViewAll)
  );
  if (!branchGate.ok) return branchGate;

  if (!isExpenseUnpostedForVoid(db, eid)) {
    return {
      ok: false,
      error:
        'This expense already has a till/bank line. It cannot be voided from import catch-up — reverse the payout instead.',
    };
  }

  try {
    db.transaction(() => {
      const prs = db.prepare(`SELECT request_id FROM payment_requests WHERE expense_id = ?`).all(eid);
      for (const pr of prs) {
        db.prepare(`DELETE FROM treasury_movements WHERE source_kind = 'PAYMENT_REQUEST' AND source_id = ?`).run(
          pr.request_id
        );
        db.prepare(`DELETE FROM payment_requests WHERE request_id = ?`).run(pr.request_id);
      }
      db.prepare(`DELETE FROM expenses WHERE expense_id = ?`).run(eid);
      appendAuditLog(db, {
        actor,
        action: 'expense.void_unposted_import',
        entityKind: 'expense',
        entityId: eid,
        note: 'Voided imported expense that never hit till/bank',
        details: {
          amountNgn: roundMoney(exp.amount_ngn),
          category: exp.category,
          date: exp.date,
          reference: exp.reference,
        },
      });
    })();
    return { ok: true, expenseID: eid };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} expenseIds
 * @param {object|null} actor
 * @param {{ workspaceBranchId?: string, workspaceViewAll?: boolean }} [opts]
 */
export function voidUnpostedImportedExpenses(db, expenseIds, actor = null, opts = {}) {
  const ids = [...new Set((expenseIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return { ok: false, error: 'Select at least one imported expense to undo.' };
  if (ids.length > MAX_BULK) {
    return { ok: false, error: `Undo at most ${MAX_BULK} expenses at a time.` };
  }
  const voided = [];
  const failed = [];
  for (const expenseId of ids) {
    const r = voidUnpostedImportedExpense(db, expenseId, actor, opts);
    if (r.ok) voided.push(r);
    else failed.push({ expenseID: expenseId, error: r.error || 'Could not undo.' });
  }
  if (!voided.length) {
    return {
      ok: false,
      error: failed[0]?.error || 'Could not undo imported expenses.',
      voided,
      failed,
    };
  }
  return {
    ok: true,
    voidedCount: voided.length,
    failedCount: failed.length,
    voided,
    failed,
    message: failed.length
      ? `Removed ${voided.length} imported expense(s); ${failed.length} could not be removed.`
      : `Removed ${voided.length} imported expense(s) that never hit the bank book.`,
  };
}

function capexAssetLinked(db, expenseId) {
  if (!tableExists(db, 'fixed_assets')) return false;
  const row = db.prepare(`SELECT id FROM fixed_assets WHERE source_expense_id = ? LIMIT 1`).get(expenseId);
  return Boolean(row?.id);
}

function restoreExpenseCashAndDeleteTx(db, exp, actor) {
  const eid = String(exp.expense_id);
  const moves = db
    .prepare(
      `SELECT id, treasury_account_id, amount_ngn FROM treasury_movements
       WHERE source_kind = 'EXPENSE' AND source_id = ?`
    )
    .all(eid);
  let restoredNgn = 0;
  for (const tm of moves) {
    const restore = -roundMoney(tm.amount_ngn);
    restoredNgn += restore;
    db.prepare(`UPDATE treasury_accounts SET balance = COALESCE(balance, 0) + ? WHERE id = ?`).run(
      restore,
      tm.treasury_account_id
    );
    if (tableExists(db, 'gl_journal_entries')) {
      db.prepare(
        `DELETE FROM gl_journal_entries WHERE source_kind = 'EXPENSE_PAYMENT_GL' AND source_id = ?`
      ).run(tm.id);
    }
  }
  db.prepare(`DELETE FROM treasury_movements WHERE source_kind = 'EXPENSE' AND source_id = ?`).run(eid);
  const prs = db.prepare(`SELECT request_id FROM payment_requests WHERE expense_id = ?`).all(eid);
  for (const pr of prs) {
    db.prepare(`DELETE FROM treasury_movements WHERE source_kind = 'PAYMENT_REQUEST' AND source_id = ?`).run(
      pr.request_id
    );
    db.prepare(`DELETE FROM payment_requests WHERE request_id = ?`).run(pr.request_id);
  }
  db.prepare(`DELETE FROM expenses WHERE expense_id = ?`).run(eid);
  appendAuditLog(db, {
    actor,
    action: 'expense.clear_for_reimport',
    entityKind: 'expense',
    entityId: eid,
    note: 'Cleared expense so it can be bulk-imported again',
    details: { amountNgn: roundMoney(exp.amount_ngn), restoredNgn, category: exp.category },
  });
  return { restoredNgn };
}

/**
 * Expenses on this branch that can be wiped before a full bulk re-import.
 * Paid payment-request payouts and capitalized capex stay.
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 */
export function listExpensesClearableForReimport(db, branchId) {
  const bid = String(branchId || '').trim();
  if (!bid) return { ok: false, error: 'Select a workspace branch first.' };
  const rows = db
    .prepare(
      `SELECT e.*
       FROM expenses e
       WHERE TRIM(COALESCE(e.branch_id, '')) = ?
       ORDER BY e.date DESC, e.expense_id DESC`
    )
    .all(bid);

  const clearable = [];
  const skippedPaid = [];
  const skippedCapex = [];
  let restoreCashNgn = 0;
  for (const row of rows) {
    if (paidPaymentRequestCount(db, row.expense_id) > 0) {
      skippedPaid.push(mapExpenseRow(row));
      continue;
    }
    if (capexAssetLinked(db, row.expense_id)) {
      skippedCapex.push(mapExpenseRow(row));
      continue;
    }
    const moves = expenseTreasuryMovements(db, row.expense_id);
    const cash = moves.reduce((s, m) => s + Math.abs(roundMoney(m.amount_ngn)), 0);
    restoreCashNgn += cash;
    clearable.push({
      ...mapExpenseRow(row, { missingTreasury: !moves.length, missingGl: false }),
      willRestoreCashNgn: cash,
    });
  }
  return {
    ok: true,
    branchId: bid,
    confirmPhrase: EXPENSE_REIMPORT_CONFIRM_PHRASE,
    clearableCount: clearable.length,
    skippedPaidCount: skippedPaid.length,
    skippedCapexCount: skippedCapex.length,
    restoreCashNgn,
    clearable: clearable.slice(0, MAX_BULK),
    skippedPaid: skippedPaid.slice(0, 50),
    skippedCapex: skippedCapex.slice(0, 50),
    message: skippedPaid.length
      ? `${clearable.length} expense(s) can be removed for re-import. ${skippedPaid.length} paid payment-request expense(s) will be kept.`
      : `${clearable.length} expense(s) can be removed for re-import on this branch.`,
  };
}

/**
 * Wipe re-importable expenses on the workspace branch and restore till/bank for any EXPENSE cash lines.
 * Does not delete paid payment-request payouts.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object|null} actor
 * @param {{ workspaceBranchId?: string, workspaceViewAll?: boolean, confirmPhrase?: string }} opts
 */
export function clearExpensesForReimport(db, actor, opts = {}) {
  const bid = String(opts.workspaceBranchId || '').trim();
  if (!bid) return { ok: false, error: 'Select a single workspace branch before clearing expenses.' };
  if (opts.workspaceViewAll) {
    return { ok: false, error: 'Turn off all-branches view. Clear expenses on one branch at a time.' };
  }
  const phrase = String(opts.confirmPhrase || '').trim();
  if (phrase !== EXPENSE_REIMPORT_CONFIRM_PHRASE) {
    return {
      ok: false,
      error: `Type ${EXPENSE_REIMPORT_CONFIRM_PHRASE} to confirm you will bulk-enter these expenses again.`,
    };
  }

  const preview = listExpensesClearableForReimport(db, bid);
  if (!preview.ok) return preview;
  if (!preview.clearableCount) {
    return {
      ok: false,
      error: preview.skippedPaidCount
        ? 'No expenses can be cleared. Paid payment-request expenses were left in place.'
        : 'There are no expenses on this branch to clear.',
      preview,
    };
  }

  const ids = db
    .prepare(
      `SELECT e.expense_id
       FROM expenses e
       WHERE TRIM(COALESCE(e.branch_id, '')) = ?
       ORDER BY e.date DESC, e.expense_id DESC`
    )
    .all(bid)
    .map((r) => String(r.expense_id));

  const cleared = [];
  const failed = [];
  const skipped = [];
  let restoredCashNgn = 0;
  for (const expenseId of ids) {
    const exp = db.prepare(`SELECT * FROM expenses WHERE expense_id = ?`).get(expenseId);
    if (!exp) continue;
    if (paidPaymentRequestCount(db, expenseId) > 0) {
      skipped.push({ expenseID: expenseId, reason: 'paid_payment_request' });
      continue;
    }
    if (capexAssetLinked(db, expenseId)) {
      skipped.push({ expenseID: expenseId, reason: 'capitalized_capex' });
      continue;
    }
    try {
      let restoredNgn = 0;
      db.transaction(() => {
        restoredNgn = restoreExpenseCashAndDeleteTx(db, exp, actor).restoredNgn;
      })();
      restoredCashNgn += restoredNgn;
      cleared.push({ expenseID: expenseId, restoredNgn });
    } catch (e) {
      failed.push({ expenseID: expenseId, error: String(e.message || e) });
    }
  }

  if (!cleared.length) {
    return {
      ok: false,
      error: failed[0]?.error || 'Could not clear expenses for re-import.',
      cleared,
      failed,
      skipped,
    };
  }
  return {
    ok: true,
    clearedCount: cleared.length,
    failedCount: failed.length,
    skippedCount: skipped.length,
    restoredCashNgn,
    cleared,
    failed,
    skipped,
    message: failed.length
      ? `Removed ${cleared.length} expense(s). ${failed.length} could not be removed. Re-import with AccountKey filled.`
      : `Removed ${cleared.length} expense(s) on this branch. Bank/till cash for those rows was put back. Re-import with AccountKey on every row.`,
  };
}
