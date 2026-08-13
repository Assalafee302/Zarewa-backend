/**
 * Cashier / finance — record bank charges already deducted from a treasury account.
 * Posts expense (GL 6170) + treasury outflow immediately; no BM payment-request wait.
 */
import { actorName, userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendAuditLog, assertPeriodOpen } from './controlOps.js';
import { nextExpenseHumanId } from './humanId.js';
import { hasColumn } from './ap2ReceivedBasisOps.js';
import { tryPostExpensePaymentGlTx } from './accountingPostingOps.js';
import { insertTreasuryMovementTx } from './writeOps.js';
import { validateExpenseCategorySelection } from '../shared/expenseCategoryPolicy.js';
import { getExpenseCategoryLane } from '../shared/expenseCategoryLanes.js';

export const BANK_CHARGES_CATEGORY = 'Bank charges';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} payload
 * @param {string} [branchId]
 * @returns {{ ok: true, expenseID: string, treasuryMovementId: string, amountNgn: number } | { ok: false, error: string }}
 */
export function recordBankCharge(db, payload = {}, branchId = DEFAULT_BRANCH_ID) {
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  const treasuryAccountId = Number(payload.treasuryAccountId);
  const amountNgn = roundMoney(payload.amountNgn);
  const dateISO = String(payload.dateISO || payload.date || '').trim().slice(0, 10);
  const reference = String(payload.reference ?? '').trim();
  const description = String(payload.description ?? payload.expenseType ?? '').trim();
  const actor = payload.actor || null;
  const category = BANK_CHARGES_CATEGORY;
  const expenseType = description || category;

  if (!treasuryAccountId) {
    return { ok: false, error: 'Select the bank or cash account the charge was taken from.' };
  }
  if (amountNgn <= 0) {
    return { ok: false, error: 'Bank charge amount must be positive.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    return { ok: false, error: 'Enter a valid charge date.' };
  }

  const account = db
    .prepare(`SELECT id, name, type FROM treasury_accounts WHERE id = ?`)
    .get(treasuryAccountId);
  if (!account) {
    return { ok: false, error: 'Treasury account not found.' };
  }

  const catCheck = validateExpenseCategorySelection({
    actor,
    category,
    amountNgn,
    description: expenseType,
    hasAttachment: false,
    requireAttachment: false,
    hasPermission: (p) => userHasPermission(actor, p),
  });
  if (!catCheck.ok) return catCheck;

  const paymentMethod = String(account.type || '').trim().toLowerCase() === 'cash' ? 'Cash' : 'Bank';
  const categoryLane = getExpenseCategoryLane(category);

  try {
    assertPeriodOpen(db, dateISO, 'Bank charge date');
    const latestBranchExpense = db
      .prepare(
        `SELECT expense_type, amount_ngn, date, category, payment_method, reference
         FROM expenses
         WHERE branch_id = ?
         ORDER BY date DESC, expense_id DESC
         LIMIT 1`
      )
      .get(bid);
    if (latestBranchExpense) {
      const sameAsLatest =
        roundMoney(latestBranchExpense.amount_ngn) === amountNgn &&
        String(latestBranchExpense.date || '').trim() === dateISO &&
        String(latestBranchExpense.category || '').trim().toLowerCase() === category.toLowerCase() &&
        String(latestBranchExpense.expense_type || '').trim().toLowerCase() === expenseType.toLowerCase() &&
        String(latestBranchExpense.payment_method || '').trim().toLowerCase() === paymentMethod.toLowerCase() &&
        String(latestBranchExpense.reference || '').trim().toLowerCase() === reference.toLowerCase();
      if (sameAsLatest) {
        return {
          ok: false,
          error: 'Duplicate bank charge detected. This entry matches the last saved expense, so it was not recorded twice.',
        };
      }
    }

    const createdBy = String(payload.createdBy || actorName(actor) || 'Finance').trim() || 'Finance';
    const expenseID = nextExpenseHumanId(db, bid);

    const txResult = db.transaction(() => {
      const expHasLane = hasColumn(db, 'expenses', 'category_lane');
      if (expHasLane) {
        db.prepare(
          `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id, category_lane)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(
          expenseID,
          expenseType,
          amountNgn,
          dateISO,
          category,
          paymentMethod,
          reference,
          bid,
          categoryLane
        );
      } else {
        db.prepare(
          `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run(expenseID, expenseType, amountNgn, dateISO, category, paymentMethod, reference, bid);
      }

      const movement = insertTreasuryMovementTx(db, {
        type: 'EXPENSE',
        treasuryAccountId,
        amountNgn: -amountNgn,
        postedAtISO: dateISO,
        reference: reference || expenseID,
        counterpartyKind: 'EXPENSE',
        counterpartyId: expenseID,
        counterpartyName: category,
        sourceKind: 'EXPENSE',
        sourceId: expenseID,
        note: expenseType,
        createdBy,
        workspaceBranchId: bid,
        workspaceViewAll: Boolean(payload.workspaceViewAll),
        actor,
      });

      const glExp = tryPostExpensePaymentGlTx(db, {
        treasuryAccountId,
        amountNgn,
        entryDateISO: dateISO,
        sourceId: movement.id,
        expenseCategory: category,
        branchId: bid,
        createdByUserId: actor?.id ?? null,
        memo: expenseType || `Bank charges ${expenseID}`,
      });
      if (!glExp.ok && !glExp.skipped && !glExp.duplicate) {
        throw new Error(glExp.error || 'Bank charge GL posting failed.');
      }

      appendAuditLog(db, {
        actor,
        action: 'bank_charge.create',
        entityKind: 'expense',
        entityId: expenseID,
        note: expenseType,
        details: { amountNgn, treasuryAccountId, treasuryMovementId: movement.id },
      });

      return { movementId: movement.id };
    })();

    return {
      ok: true,
      expenseID,
      treasuryMovementId: txResult.movementId,
      amountNgn,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
