/**
 * Post-pay expense category reclassification — updates register + posts GL reclass journals.
 */
import { userHasPermission } from './auth.js';
import { assertPeriodOpen, appendAuditLog } from './controlOps.js';
import { tryPostExpenseCategoryReclassGlTx } from './accountingPostingOps.js';
import { glAccountForExpenseCategory } from '../shared/lib/expenseCategoryGlMap.js';
import { resolveExpenseCategoryPolicyLimits, validateExpenseCategorySelection } from '../shared/expenseCategoryPolicy.js';
import { getExpenseCategoryLane } from '../shared/expenseCategoryLanes.js';
import { getOrgGovernanceLimits } from './orgPolicy.js';
import { hasColumn } from './ap2ReceivedBasisOps.js';

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function expenseGlDebitFromMovement(db, movementId) {
  const mid = String(movementId || '').trim();
  if (!mid) return null;
  const je = db
    .prepare(
      `SELECT id FROM gl_journal_entries WHERE source_kind = 'EXPENSE_PAYMENT_GL' AND source_id = ?`
    )
    .get(mid);
  if (!je) return null;
  const line = db
    .prepare(
      `SELECT ga.code AS accountCode, jl.debit_ngn AS debitNgn
       FROM gl_journal_lines jl
       JOIN gl_accounts ga ON ga.id = jl.account_id
       WHERE jl.journal_id = ? AND jl.debit_ngn > 0
       ORDER BY jl.debit_ngn DESC
       LIMIT 1`
    )
    .get(je.id);
  if (!line?.accountCode) return null;
  return { accountCode: String(line.accountCode), amountNgn: roundMoney(line.debitNgn) };
}

function listActivePayoutMovements(db, sourceKind, sourceId, outType) {
  return db
    .prepare(
      `SELECT tm.id, tm.amount_ngn, tm.posted_at_iso, tm.treasury_account_id
       FROM treasury_movements tm
       WHERE tm.source_kind = ? AND tm.source_id = ? AND tm.type = ?
         AND NOT EXISTS (
           SELECT 1 FROM treasury_movements rev WHERE rev.reverses_movement_id = tm.id
         )
       ORDER BY tm.posted_at_iso ASC, tm.id ASC`
    )
    .all(sourceKind, sourceId, outType);
}

function updateExpenseCategory(db, expenseId, expenseCategory, categoryJustification) {
  const eid = String(expenseId || '').trim();
  if (!eid) return;
  const categoryLane = getExpenseCategoryLane(expenseCategory);
  const expHasLane = hasColumn(db, 'expenses', 'category_lane');
  const prHasJustification = hasColumn(db, 'payment_requests', 'category_justification');
  if (expHasLane) {
    db.prepare(`UPDATE expenses SET category = ?, category_lane = ? WHERE expense_id = ?`).run(
      expenseCategory,
      categoryLane,
      eid
    );
  } else {
    db.prepare(`UPDATE expenses SET category = ? WHERE expense_id = ?`).run(expenseCategory, eid);
  }
  return { categoryLane, prHasJustification };
}

/**
 * Preview GL impact when reclassifying a paid payment request or expense.
 * @param {import('better-sqlite3').Database} db
 * @param {{ requestId?: string; expenseId?: string; expenseCategory?: string }} payload
 */
export function getPaidExpenseCategoryReclassPreview(db, payload = {}) {
  const requestId = String(payload.requestId || '').trim();
  const expenseIdDirect = String(payload.expenseId || '').trim();
  const toCategory = String(payload.expenseCategory ?? payload.category ?? '').trim();

  let expenseId = expenseIdDirect;
  let priorCategory = '';
  let paidNgn = 0;
  let branchId = '';

  if (requestId) {
    const row = db
      .prepare(
        `SELECT pr.paid_amount_ngn, pr.expense_id, e.category AS expense_category, e.branch_id
         FROM payment_requests pr
         LEFT JOIN expenses e ON e.expense_id = pr.expense_id
         WHERE pr.request_id = ?`
      )
      .get(requestId);
    if (!row) return { ok: false, error: 'Payment request not found.' };
    paidNgn = roundMoney(row.paid_amount_ngn);
    if (paidNgn <= 0) return { ok: false, error: 'Request has no treasury payout — use pre-pay reclass instead.' };
    expenseId = String(row.expense_id || '').trim();
    priorCategory = String(row.expense_category || '').trim() || 'Others';
    branchId = String(row.branch_id || '').trim();
  } else if (expenseIdDirect) {
    const row = db.prepare(`SELECT category, branch_id FROM expenses WHERE expense_id = ?`).get(expenseIdDirect);
    if (!row) return { ok: false, error: 'Expense not found.' };
    priorCategory = String(row.category || '').trim() || 'Others';
    branchId = String(row.branch_id || '').trim();
    const movements = listActivePayoutMovements(db, 'EXPENSE', expenseIdDirect, 'EXPENSE');
    paidNgn = movements.reduce((s, m) => s + Math.abs(roundMoney(m.amount_ngn)), 0);
    if (paidNgn <= 0) return { ok: false, error: 'Expense has no treasury payout to reclass.' };
  } else {
    return { ok: false, error: 'requestId or expenseId is required.' };
  }

  const targetCategory = toCategory || priorCategory;
  const fromGl = glAccountForExpenseCategory(priorCategory, { capexAsAsset: true });
  const toGl = glAccountForExpenseCategory(targetCategory, { capexAsAsset: true });
  const sourceKind = requestId ? 'PAYMENT_REQUEST' : 'EXPENSE';
  const sourceId = requestId || expenseIdDirect;
  const outType = requestId ? 'PAYMENT_REQUEST_OUT' : 'EXPENSE';
  const movements = listActivePayoutMovements(db, sourceKind, sourceId, outType);

  const lines = movements.map((mv) => {
    const amt = Math.abs(roundMoney(mv.amount_ngn));
    const posted = expenseGlDebitFromMovement(db, mv.id);
    return {
      movementId: mv.id,
      amountNgn: amt,
      postedDebitAccountCode: posted?.accountCode || fromGl.accountCode,
      glPosted: Boolean(posted),
    };
  });

  return {
    ok: true,
    requestId: requestId || null,
    expenseId: expenseId || expenseIdDirect,
    priorCategory,
    expenseCategory: targetCategory,
    paidAmountNgn: paidNgn,
    branchId,
    gl: {
      fromAccountCode: fromGl.accountCode,
      toAccountCode: toGl.accountCode,
      willPostReclass: fromGl.accountCode !== toGl.accountCode && lines.some((l) => l.glPosted || true),
    },
    movements: lines,
  };
}

/**
 * Reclass category after treasury payout — posts Dr new / Cr old per payout movement when GL exists.
 * @param {import('better-sqlite3').Database} db
 * @param {string} requestID
 * @param {{ expenseCategory?: string; categoryJustification?: string; reclassDateISO?: string }} payload
 * @param {object | null} actor
 */
export function reclassifyPaidPaymentRequestCategory(db, requestID, payload, actor) {
  const rid = String(requestID || '').trim();
  if (!rid) return { ok: false, error: 'Payment request ID is required.' };
  if (!userHasPermission(actor, 'finance.post') && !userHasPermission(actor, '*')) {
    return { ok: false, error: 'finance.post is required to reclassify after treasury payout.' };
  }

  const row = db
    .prepare(
      `SELECT pr.*, e.category AS expense_category, e.branch_id
       FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       WHERE pr.request_id = ?`
    )
    .get(rid);
  if (!row) return { ok: false, error: 'Payment request not found.' };

  const paidNgn = roundMoney(row.paid_amount_ngn);
  if (paidNgn <= 0) {
    return { ok: false, error: 'No treasury payout recorded — use pre-pay reclass instead.' };
  }

  const expenseCategory = String(payload.expenseCategory ?? payload.category ?? '').trim();
  const categoryJustification = String(
    payload.categoryJustification ?? row.category_justification ?? ''
  ).trim();
  const priorCategory = String(row.expense_category || '').trim() || 'Others';
  const amountRequestedNgn = roundMoney(row.amount_requested_ngn);
  const hasAttachment = Boolean(String(row.attachment_data_b64 || '').trim());
  const reclassDate = String(payload.reclassDateISO ?? new Date().toISOString()).slice(0, 10);

  const catCheck = validateExpenseCategorySelection({
    actor,
    category: expenseCategory,
    amountNgn: amountRequestedNgn,
    description: row.description,
    categoryJustification,
    hasAttachment,
    hasPermission: (p) => userHasPermission(actor, p),
    policyLimits: resolveExpenseCategoryPolicyLimits(getOrgGovernanceLimits(db)),
  });
  if (!catCheck.ok) return catCheck;

  if (priorCategory === expenseCategory) {
    return { ok: false, error: 'Select a different category to reclassify.' };
  }

  const fromGl = glAccountForExpenseCategory(priorCategory, { capexAsAsset: true });
  const toGl = glAccountForExpenseCategory(expenseCategory, { capexAsAsset: true });
  const expenseId = String(row.expense_id || '').trim();
  const movements = listActivePayoutMovements(db, 'PAYMENT_REQUEST', rid, 'PAYMENT_REQUEST_OUT');

  try {
    assertPeriodOpen(db, reclassDate, 'Category reclass date');
    const glResults = [];
    db.transaction(() => {
      const { categoryLane, prHasJustification } = updateExpenseCategory(
        db,
        expenseId,
        expenseCategory,
        categoryJustification
      );
      if (prHasJustification) {
        db.prepare(`UPDATE payment_requests SET category_justification = ? WHERE request_id = ?`).run(
          categoryJustification || null,
          rid
        );
      }

      for (const mv of movements) {
        const amt = Math.abs(roundMoney(mv.amount_ngn));
        if (amt <= 0) continue;
        const posted = expenseGlDebitFromMovement(db, mv.id);
        const fromCode = posted?.accountCode || fromGl.accountCode;
        const gl = tryPostExpenseCategoryReclassGlTx(db, {
          amountNgn: amt,
          fromAccountCode: fromCode,
          toAccountCode: toGl.accountCode,
          entryDateISO: reclassDate,
          movementId: mv.id,
          requestId: rid,
          branchId: row.branch_id || null,
          createdByUserId: actor?.id ?? null,
          memo: `Reclass ${priorCategory} → ${expenseCategory} (${rid})`,
        });
        if (!gl.ok && !gl.skipped) throw new Error(gl.error || 'Category reclass GL failed.');
        glResults.push({ movementId: mv.id, ...gl });
      }

      appendAuditLog(db, {
        actor,
        action: 'payment_request.reclassify_category_post_pay',
        entityKind: 'payment_request',
        entityId: rid,
        note: `Category ${priorCategory} → ${expenseCategory} (post-pay)`,
        details: {
          priorCategory,
          expenseCategory,
          categoryLane,
          paidAmountNgn: paidNgn,
          glJournalCount: glResults.filter((g) => g.ok && !g.skipped).length,
        },
      });
    })();
    return {
      ok: true,
      expenseCategory,
      categoryLane: getExpenseCategoryLane(expenseCategory),
      postPay: true,
      glReclassCount: glResults.filter((g) => g.ok && !g.skipped && !g.duplicate).length,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Reclass a direct expense after treasury payout.
 * @param {import('better-sqlite3').Database} db
 * @param {string} expenseID
 * @param {{ expenseCategory?: string; reclassDateISO?: string }} payload
 * @param {object | null} actor
 */
export function reclassifyPaidExpenseCategory(db, expenseID, payload, actor) {
  const eid = String(expenseID || '').trim();
  if (!eid) return { ok: false, error: 'Expense ID is required.' };
  if (!userHasPermission(actor, 'finance.post') && !userHasPermission(actor, '*')) {
    return { ok: false, error: 'finance.post is required to reclassify posted expenses.' };
  }

  const row = db.prepare(`SELECT * FROM expenses WHERE expense_id = ?`).get(eid);
  if (!row) return { ok: false, error: 'Expense not found.' };

  const priorCategory = String(row.category || '').trim() || 'Others';
  const expenseCategory = String(payload.expenseCategory ?? payload.category ?? '').trim();
  const amountNgn = roundMoney(row.amount_ngn);
  const reclassDate = String(payload.reclassDateISO ?? row.date ?? new Date().toISOString()).slice(0, 10);

  const catCheck = validateExpenseCategorySelection({
    actor,
    category: expenseCategory,
    amountNgn,
    description: row.reference || row.expense_type,
    categoryJustification: String(payload.categoryJustification ?? '').trim(),
    hasAttachment: true,
    hasPermission: (p) => userHasPermission(actor, p),
    policyLimits: resolveExpenseCategoryPolicyLimits(getOrgGovernanceLimits(db)),
  });
  if (!catCheck.ok) return catCheck;
  if (priorCategory === expenseCategory) {
    return { ok: false, error: 'Select a different category to reclassify.' };
  }

  const movements = listActivePayoutMovements(db, 'EXPENSE', eid, 'EXPENSE');
  const paidNgn = movements.reduce((s, m) => s + Math.abs(roundMoney(m.amount_ngn)), 0);
  if (paidNgn <= 0) return { ok: false, error: 'Expense has no treasury payout to reclass.' };

  const fromGl = glAccountForExpenseCategory(priorCategory, { capexAsAsset: true });
  const toGl = glAccountForExpenseCategory(expenseCategory, { capexAsAsset: true });

  try {
    assertPeriodOpen(db, reclassDate, 'Category reclass date');
    const glResults = [];
    db.transaction(() => {
      updateExpenseCategory(db, eid, expenseCategory, payload.categoryJustification);
      for (const mv of movements) {
        const amt = Math.abs(roundMoney(mv.amount_ngn));
        if (amt <= 0) continue;
        const posted = expenseGlDebitFromMovement(db, mv.id);
        const fromCode = posted?.accountCode || fromGl.accountCode;
        const gl = tryPostExpenseCategoryReclassGlTx(db, {
          amountNgn: amt,
          fromAccountCode: fromCode,
          toAccountCode: toGl.accountCode,
          entryDateISO: reclassDate,
          movementId: mv.id,
          expenseId: eid,
          branchId: row.branch_id || null,
          createdByUserId: actor?.id ?? null,
          memo: `Reclass ${priorCategory} → ${expenseCategory} (${eid})`,
        });
        if (!gl.ok && !gl.skipped) throw new Error(gl.error || 'Category reclass GL failed.');
        glResults.push(gl);
      }
      appendAuditLog(db, {
        actor,
        action: 'expense.reclassify_category_post_pay',
        entityKind: 'expense',
        entityId: eid,
        note: `Category ${priorCategory} → ${expenseCategory}`,
        details: {
          priorCategory,
          expenseCategory,
          paidAmountNgn: paidNgn,
        },
      });
    })();
    return {
      ok: true,
      expenseCategory,
      categoryLane: getExpenseCategoryLane(expenseCategory),
      postPay: true,
      glReclassCount: glResults.filter((g) => g.ok && !g.skipped && !g.duplicate).length,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
