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
import { hasColumn, roundMoney, tableExists } from '../ap2ReceivedBasisOps.js';
import { resolveListLimit, sqlLimitOffsetClause } from '../listQueryOpts.js';
import { branchWhere } from '../readModel.js';
import { tryPostExpensePaymentGlTx } from '../accountingPostingOps.js';
import { syncFixedAssetFromCapexExpense } from '../fixedAssetAutomationOps.js';
import { insertTreasuryMovementTx } from '../writeOps.js';
import {
  listBranchTreasuryAccountsForImport,
  resolveDefaultBranchTreasuryAccount,
  resolveTreasuryAccountId,
} from '../expenseBulkImport.js';

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

/**
 * Where this branch’s expenses already sit on cashier books — used when catch-up shows 0 unposted.
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @param {{ category?: string }} [opts]
 */
export function summarizeBranchExpenseCashPosting(db, branchId, opts = {}) {
  const bid = String(branchId || '').trim();
  if (!bid) return { ok: false, error: 'Select a workspace branch first.' };
  const cat = String(opts.category || '').trim();
  const catSql = cat ? ` AND TRIM(e.category) = ?` : '';
  const catArgs = cat ? [cat] : [];

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(e.amount_ngn), 0) AS amt
       FROM expenses e
       WHERE TRIM(COALESCE(e.branch_id, '')) = ?${catSql}`
    )
    .get(bid, ...catArgs);

  const unposted = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(e.amount_ngn), 0) AS amt
       FROM expenses e
       LEFT JOIN treasury_movements tm
         ON tm.source_kind = 'EXPENSE' AND tm.source_id = e.expense_id
        AND tm.amount_ngn < 0
        AND (tm.reverses_movement_id IS NULL OR TRIM(COALESCE(tm.reverses_movement_id, '')) = '')
       WHERE TRIM(COALESCE(e.branch_id, '')) = ?${catSql}
         AND tm.id IS NULL`
    )
    .get(bid, ...catArgs);

  const postedAccounts = db
    .prepare(
      `SELECT ta.id AS treasury_account_id, ta.name AS account_name, ta.type AS account_type,
              COUNT(*) AS expense_count, COALESCE(SUM(ABS(tm.amount_ngn)), 0) AS amount_ngn
       FROM expenses e
       INNER JOIN treasury_movements tm
         ON tm.source_kind = 'EXPENSE' AND tm.source_id = e.expense_id
        AND tm.amount_ngn < 0
        AND (tm.reverses_movement_id IS NULL OR TRIM(COALESCE(tm.reverses_movement_id, '')) = '')
       INNER JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
       WHERE TRIM(COALESCE(e.branch_id, '')) = ?${catSql}
       GROUP BY ta.id, ta.name, ta.type
       ORDER BY amount_ngn DESC, ta.name ASC`
    )
    .all(bid, ...catArgs);

  const categories = db
    .prepare(
      `SELECT TRIM(e.category) AS category, COUNT(*) AS n, COALESCE(SUM(e.amount_ngn), 0) AS amt
       FROM expenses e
       WHERE TRIM(COALESCE(e.branch_id, '')) = ?
       GROUP BY TRIM(e.category)
       ORDER BY n DESC, category ASC`
    )
    .all(bid);

  return {
    ok: true,
    branchId: bid,
    category: cat,
    expenseCount: Number(totals?.n) || 0,
    expenseAmountNgn: roundMoney(totals?.amt),
    unpostedCount: Number(unposted?.n) || 0,
    unpostedAmountNgn: roundMoney(unposted?.amt),
    postedAccounts: postedAccounts.map((row) => ({
      treasuryAccountId: Number(row.treasury_account_id),
      accountName: row.account_name || `#${row.treasury_account_id}`,
      accountType: row.account_type || '',
      expenseCount: Number(row.expense_count) || 0,
      amountNgn: roundMoney(row.amount_ngn),
    })),
    categories: categories.map((row) => ({
      category: row.category || '(blank)',
      count: Number(row.n) || 0,
      amountNgn: roundMoney(row.amt),
    })),
  };
}

/**
 * Cash vs POS from the expense payment column — so refunds do not all land on one default till.
 * @param {import('better-sqlite3').Database} db
 * @param {{ payment_method?: string, reference?: string, branch_id?: string }} exp
 * @param {number} [fallbackAccountId]
 */
export function resolveTillForExpense(db, exp, fallbackAccountId = 0) {
  const bid = String(exp?.branch_id || '').trim();
  const paymentMethod = String(exp?.payment_method || '').trim();
  if (paymentMethod) {
    const exact = resolveTreasuryAccountId(db, paymentMethod, bid);
    if (exact.id) return Number(exact.id);
  }
  const accounts = listBranchTreasuryAccountsForImport(db, bid);
  if (/pos/i.test(paymentMethod)) {
    const pos = accounts.find((a) => /pos/i.test(String(a.name || '')));
    if (pos) return Number(pos.id);
  }
  if (/cash/i.test(paymentMethod)) {
    const namedCash = accounts.find((a) => /^cash$/i.test(String(a.name || '').trim()));
    if (namedCash) return Number(namedCash.id);
    const cashType = accounts.find((a) => String(a.type || '').trim().toLowerCase() === 'cash');
    if (cashType) return Number(cashType.id);
  }
  const fallback = Number(fallbackAccountId) || 0;
  if (fallback) return fallback;
  return Number(resolveDefaultBranchTreasuryAccount(db, bid).id) || 0;
}

/**
 * Set live till/bank balances to opening + every cash-book line (fixes drift when a movement
 * existed but `treasury_accounts.balance` was not updated).
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 */
export function rebuildTreasuryBalancesFromLedger(db, branchId) {
  const bid = String(branchId || '').trim();
  if (!bid) return { ok: false, error: 'Select a workspace branch first.' };
  const hasOpening = hasColumn(db, 'treasury_accounts', 'opening_balance_ngn');
  const openingSql = hasOpening ? 'opening_balance_ngn' : '0';
  const accounts = db
    .prepare(
      `SELECT id, name, type, balance, ${openingSql} AS opening_balance_ngn, branch_id
       FROM treasury_accounts
       WHERE TRIM(COALESCE(branch_id, '')) = ?
          OR (TRIM(COALESCE(branch_id, '')) = '' AND ? = ?)
       ORDER BY id`
    )
    .all(bid, bid, DEFAULT_BRANCH_ID);
  const sumStmt = db.prepare(
    `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements WHERE treasury_account_id = ?`
  );
  const upd = db.prepare(`UPDATE treasury_accounts SET balance = ? WHERE id = ?`);
  const rebuilt = [];
  for (const acc of accounts) {
    const id = Number(acc.id);
    const opening = roundMoney(acc.opening_balance_ngn);
    const movementSum = roundMoney(sumStmt.get(id)?.s);
    const next = roundMoney(opening + movementSum);
    const prev = roundMoney(acc.balance);
    if (next !== prev) upd.run(next, id);
    rebuilt.push({
      treasuryAccountId: id,
      accountName: acc.name || `#${id}`,
      accountType: acc.type || '',
      previousBalanceNgn: prev,
      nextBalanceNgn: next,
      deltaNgn: roundMoney(next - prev),
    });
  }
  return { ok: true, branchId: bid, accounts: rebuilt };
}

/**
 * Post every expense still missing a till line onto Cash/POS from its payment method, then
 * rebuild live balances so Cashier desk matches the cash book.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object|null} actor
 * @param {{ workspaceBranchId?: string, workspaceViewAll?: boolean, treasuryAccountId?: number, category?: string }} payload
 */
export function syncImportedExpensesToCashier(db, actor, payload = {}) {
  const bid = String(payload.workspaceBranchId || '').trim();
  if (!bid) return { ok: false, error: 'Select a workspace branch first.' };
  if (payload.workspaceViewAll) {
    return { ok: false, error: 'Turn off all-branches view. Update one branch at a time.' };
  }

  const category = String(payload.category || '').trim();
  const fallbackId =
    Number(payload.treasuryAccountId) || Number(resolveDefaultBranchTreasuryAccount(db, bid).id) || 0;
  const catSql = category ? ` AND TRIM(e.category) = ?` : '';
  const catArgs = category ? [category] : [];
  const missing = db
    .prepare(
      `SELECT e.*
       FROM expenses e
       LEFT JOIN treasury_movements tm
         ON tm.source_kind = 'EXPENSE' AND tm.source_id = e.expense_id
        AND tm.amount_ngn < 0
        AND (tm.reverses_movement_id IS NULL OR TRIM(COALESCE(tm.reverses_movement_id, '')) = '')
       WHERE TRIM(COALESCE(e.branch_id, '')) = ?${catSql}
         AND tm.id IS NULL
       ORDER BY e.date ASC, e.expense_id ASC
       LIMIT ${MAX_BULK}`
    )
    .all(bid, ...catArgs);

  const posted = [];
  const failed = [];
  for (const exp of missing) {
    const tillId = resolveTillForExpense(db, exp, fallbackId);
    if (!tillId) {
      failed.push({
        expenseID: exp.expense_id,
        error: 'Pick the Cash or POS account this refund was paid from.',
      });
      continue;
    }
    const r = attachTreasuryToImportedExpense(
      db,
      exp.expense_id,
      {
        treasuryAccountId: tillId,
        workspaceBranchId: bid,
        workspaceViewAll: false,
      },
      actor
    );
    if (r.ok) posted.push(r);
    else failed.push({ expenseID: exp.expense_id, error: r.error || 'Could not deduct.' });
  }

  const rebuilt = rebuildTreasuryBalancesFromLedger(db, bid);
  if (!rebuilt.ok) return rebuilt;
  const changed = (rebuilt.accounts || []).filter((a) => a.deltaNgn !== 0);
  const newlyPosted = posted.filter((p) => !p.alreadyOnTreasury);
  const summary = summarizeBranchExpenseCashPosting(db, bid, { category });

  const bits = [];
  if (newlyPosted.length) {
    bits.push(`Deducted ${newlyPosted.length} expense(s) from Cash/POS`);
  } else if (!missing.length) {
    bits.push('Every expense on this branch already has a till line');
  }
  if (changed.length) {
    bits.push(
      `corrected ${changed.length} live balance(s): ${changed
        .map((a) => `${a.accountName} ₦${a.previousBalanceNgn.toLocaleString('en-NG')} → ₦${a.nextBalanceNgn.toLocaleString('en-NG')}`)
        .join('; ')}`
    );
  } else {
    bits.push('live till balances already match the cash book');
  }
  if (failed.length) bits.push(`${failed.length} row(s) could not post`);

  return {
    ok: failed.length === 0 || newlyPosted.length > 0 || changed.length > 0,
    postedCount: newlyPosted.length,
    failedCount: failed.length,
    posted,
    failed,
    rebuiltAccounts: rebuilt.accounts,
    balanceChangedCount: changed.length,
    summary,
    message: `${bits.join('. ')}.`,
  };
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
    allowNegativeBalance: true,
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
 * Post every expense on this branch that has no till/bank outflow onto one treasury account.
 * @param {import('better-sqlite3').Database} db
 * @param {object|null} actor
 * @param {{ treasuryAccountId?: number, accountKey?: string, workspaceBranchId?: string, workspaceViewAll?: boolean }} payload
 */
export function attachAllUnpostedImportedExpenses(db, actor, payload = {}) {
  const bid = String(payload.workspaceBranchId || '').trim();
  if (!bid) return { ok: false, error: 'Select a single workspace branch first.' };
  if (payload.workspaceViewAll) {
    return { ok: false, error: 'Turn off all-branches view. Post unposted expenses on one branch at a time.' };
  }
  const rows = listExpensesMissingBankPosting(db, bid, { limit: MAX_BULK });
  const ids = rows.filter((r) => r.missingTreasury).map((r) => r.expenseID);
  if (!ids.length) {
    return {
      ok: false,
      error:
        'No expenses on this branch are missing a bank/cash line. They may already be on the statement, or you are on the wrong branch.',
    };
  }
  let paidFrom = payload;
  if (!Number(payload.treasuryAccountId) && !String(payload.accountKey || '').trim()) {
    const fallback = resolveDefaultBranchTreasuryAccount(db, bid);
    if (!fallback.id) return { ok: false, error: fallback.error };
    paidFrom = { ...payload, treasuryAccountId: fallback.id };
  }
  return attachTreasuryToImportedExpenses(db, ids, paidFrom, actor);
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

/**
 * Delete every memo-only imported expense on this branch (no till/bank line yet).
 * @param {import('better-sqlite3').Database} db
 * @param {object|null} actor
 * @param {{ workspaceBranchId?: string, workspaceViewAll?: boolean }} [opts]
 */
export function voidAllUnpostedImportedExpenses(db, actor, opts = {}) {
  const bid = String(opts.workspaceBranchId || '').trim();
  if (!bid) return { ok: false, error: 'Select a single workspace branch first.' };
  if (opts.workspaceViewAll) {
    return { ok: false, error: 'Turn off all-branches view. Undo unposted expenses on one branch at a time.' };
  }
  const rows = listExpensesMissingBankPosting(db, bid, { limit: MAX_BULK });
  const ids = rows.filter((r) => r.missingTreasury).map((r) => r.expenseID);
  if (!ids.length) {
    return { ok: false, error: 'No unposted imported expenses on this branch to delete.' };
  }
  return voidUnpostedImportedExpenses(db, ids, actor, opts);
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

function duplicateGroupKey(row) {
  const ref = String(row.reference || '').trim().toLowerCase();
  const date = String(row.date || '').trim().slice(0, 10);
  const cat = String(row.category || '').trim().toLowerCase();
  const amt = roundMoney(row.amount_ngn);
  const fallback = String(row.expense_type || '').trim().toLowerCase();
  return `${date}|${cat}|${amt}|${ref || fallback}`;
}

/**
 * Imported expenses that share date, category, amount, and reference on this branch.
 * The oldest expense_id in each group is the keeper.
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 */
export function listDuplicateImportedExpenseGroups(db, branchId) {
  const bid = String(branchId || '').trim();
  if (!bid) return { ok: false, error: 'Select a workspace branch first.' };
  const rows = db
    .prepare(
      `SELECT expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id
       FROM expenses
       WHERE TRIM(COALESCE(branch_id, '')) = ?
       ORDER BY expense_id ASC`
    )
    .all(bid);

  const byKey = new Map();
  for (const row of rows) {
    const key = duplicateGroupKey(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const groups = [];
  for (const [, members] of byKey) {
    if (members.length < 2) continue;
    const keep = members[0];
    const extras = members.slice(1);
    groups.push({
      date: keep.date,
      category: keep.category,
      amountNgn: roundMoney(keep.amount_ngn),
      reference: keep.reference || '',
      keepExpenseID: keep.expense_id,
      extraExpenseIDs: extras.map((r) => r.expense_id),
      extraCount: extras.length,
      restoreCashNgn: extras.reduce((s, r) => s + roundMoney(r.amount_ngn), 0),
    });
  }
  return {
    ok: true,
    branchId: bid,
    groupCount: groups.length,
    extraCount: groups.reduce((s, g) => s + g.extraCount, 0),
    restoreCashNgn: groups.reduce((s, g) => s + g.restoreCashNgn, 0),
    groups,
  };
}

/**
 * Delete extra copies in duplicate groups. Puts till/bank cash back for any EXPENSE lines.
 * @param {import('better-sqlite3').Database} db
 * @param {object|null} actor
 * @param {{ workspaceBranchId?: string, workspaceViewAll?: boolean, expenseIds?: string[] }} opts
 */
export function deleteDuplicateImportedExpenses(db, actor, opts = {}) {
  const bid = String(opts.workspaceBranchId || '').trim();
  if (!bid) return { ok: false, error: 'Select a single workspace branch first.' };
  if (opts.workspaceViewAll) {
    return { ok: false, error: 'Turn off all-branches view. Remove duplicates on one branch at a time.' };
  }
  const preview = listDuplicateImportedExpenseGroups(db, bid);
  if (!preview.ok) return preview;
  const allowed = new Set(preview.groups.flatMap((g) => g.extraExpenseIDs));
  let ids = [...new Set((opts.expenseIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) ids = [...allowed];
  ids = ids.filter((id) => allowed.has(id));
  if (!ids.length) {
    return { ok: false, error: 'No duplicate extra copies on this branch to delete.' };
  }

  const deleted = [];
  const failed = [];
  let restoredCashNgn = 0;
  for (const expenseId of ids) {
    const exp = db.prepare(`SELECT * FROM expenses WHERE expense_id = ?`).get(expenseId);
    if (!exp) continue;
    if (paidPaymentRequestCount(db, expenseId) > 0) {
      failed.push({ expenseID: expenseId, error: 'This copy has a paid payment request. Reverse that payout first.' });
      continue;
    }
    if (capexAssetLinked(db, expenseId)) {
      failed.push({ expenseID: expenseId, error: 'This copy is linked to a fixed asset.' });
      continue;
    }
    try {
      let restoredNgn = 0;
      db.transaction(() => {
        restoredNgn = restoreExpenseCashAndDeleteTx(db, exp, actor).restoredNgn;
      })();
      restoredCashNgn += restoredNgn;
      deleted.push({ expenseID: expenseId, restoredNgn });
    } catch (e) {
      failed.push({ expenseID: expenseId, error: String(e.message || e) });
    }
  }
  if (!deleted.length) {
    return {
      ok: false,
      error: failed[0]?.error || 'Could not delete duplicate expenses.',
      deleted,
      failed,
    };
  }
  return {
    ok: true,
    deletedCount: deleted.length,
    failedCount: failed.length,
    restoredCashNgn,
    deleted,
    failed,
    message: failed.length
      ? `Removed ${deleted.length} duplicate expense(s) and put cash back. ${failed.length} could not be removed.`
      : `Removed ${deleted.length} duplicate expense(s). Till/bank cash for those copies was put back.`,
  };
}
