/**
 * Fixed-asset sale / disposal → treasury receipt + GL (clear cost, accum. dep, gain/loss).
 * @param {import('better-sqlite3').Database} db
 */

import { capexExpenseAssetMeta, isCapexExpenseCategory } from '../shared/expenseCategories.js';
import { ensureAccountingPhase2Schema, mapFixedAssetRow } from './accountingPhase2Ops.js';
import { assertPeriodOpen } from './controlOps.js';
import { postBalancedJournalTx } from './glOps.js';
import { insertTreasuryMovementTx } from './writeOps.js';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

/** @param {import('better-sqlite3').Database} db @param {object} assetRow */
export function resolveFixedAssetGlAccountCode(db, assetRow) {
  const sourceExpenseId = String(assetRow.source_expense_id || '').trim();
  if (sourceExpenseId) {
    const exp = db.prepare(`SELECT category FROM expenses WHERE expense_id = ?`).get(sourceExpenseId);
    const cat = String(exp?.category || '').trim();
    if (cat && isCapexExpenseCategory(cat)) {
      return capexExpenseAssetMeta(cat).glAccountCode;
    }
  }
  const category = String(assetRow.category || '').trim().toLowerCase();
  switch (category) {
    case 'building':
    case 'land':
      return '1501';
    case 'it':
      return '1502';
    default:
      return '1500';
  }
}

function projectedAssetAtDisposal(assetRow, disposalDateIso) {
  return mapFixedAssetRow({
    ...assetRow,
    status: 'disposed',
    disposal_date_iso: disposalDateIso,
  });
}

function buildDisposalJournalLines({ glAccountCode, costNgn, accumulatedNgn, proceedsNgn, assetName }) {
  const cost = roundMoney(costNgn);
  const accum = roundMoney(accumulatedNgn);
  const proceeds = roundMoney(proceedsNgn);
  const lines = [];
  if (proceeds > 0) {
    lines.push({ accountCode: '1000', debitNgn: proceeds, memo: `${assetName} — sale proceeds` });
  }
  if (accum > 0) {
    lines.push({ accountCode: '1398', debitNgn: accum, memo: `${assetName} — accumulated depreciation` });
  }
  if (cost > 0) {
    lines.push({ accountCode: glAccountCode, creditNgn: cost, memo: `${assetName} — asset cost` });
  }
  const balancing = cost - accum - proceeds;
  if (balancing > 0) {
    lines.push({ accountCode: '6200', debitNgn: balancing, memo: `${assetName} — loss on disposal` });
  } else if (balancing < 0) {
    lines.push({ accountCode: '6200', creditNgn: -balancing, memo: `${assetName} — gain on disposal` });
  }
  return lines;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} assetId
 * @param {{
 *   disposalDateIso?: string;
 *   saleProceedsNgn?: number;
 *   treasuryAccountId?: number;
 *   reference?: string;
 *   note?: string;
 *   workspaceBranchId?: string;
 *   workspaceViewAll?: boolean;
 * }} body
 * @param {{ id?: string, displayName?: string } | null} user
 */
export function disposeFixedAssetWithSettlement(db, assetId, body, user) {
  ensureAccountingPhase2Schema(db);
  const id = String(assetId || '').trim();
  const cur = db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(id);
  if (!cur) return { ok: false, error: 'Asset not found.' };
  if (cur.status === 'disposed') return { ok: false, error: 'Asset is already disposed.' };

  const disposalDateIso = String(body?.disposalDateIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(disposalDateIso)) {
    return { ok: false, error: 'Valid disposal date (YYYY-MM-DD) is required.' };
  }

  const saleProceedsNgn = Math.max(0, roundMoney(body?.saleProceedsNgn));
  const treasuryAccountId = Number(body?.treasuryAccountId);
  if (saleProceedsNgn > 0 && !treasuryAccountId) {
    return { ok: false, error: 'Select a treasury account to record sale proceeds.' };
  }

  try {
    assertPeriodOpen(db, disposalDateIso, 'Fixed asset disposal date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const projected = projectedAssetAtDisposal(cur, disposalDateIso);
  const glAccountCode = resolveFixedAssetGlAccountCode(db, cur);
  const reference = String(body?.reference || '').trim() || id;
  const note = String(body?.note || '').trim() || (saleProceedsNgn > 0 ? 'Fixed asset sale' : 'Fixed asset disposal');
  const branchId = String(cur.branch_id || body?.workspaceBranchId || '').trim();
  const uid = user?.id ? String(user.id) : null;
  const now = new Date().toISOString();

  const glLines = buildDisposalJournalLines({
    glAccountCode,
    costNgn: projected.costNgn,
    accumulatedNgn: projected.accumulatedDepreciationNgn,
    proceedsNgn: saleProceedsNgn,
    assetName: cur.name,
  });

  try {
    const result = db.transaction(() => {
      const gl = postBalancedJournalTx(db, {
        entryDateISO: disposalDateIso,
        memo: saleProceedsNgn > 0 ? `Fixed asset sale — ${cur.name}` : `Fixed asset disposal — ${cur.name}`,
        sourceKind: 'FIXED_ASSET_DISPOSE',
        sourceId: id,
        branchId: branchId || null,
        createdByUserId: uid,
        lines: glLines,
      });
      if (!gl.ok) {
        throw new Error(gl.error || 'Fixed asset disposal GL posting failed.');
      }

      let treasuryMovementId = null;
      if (saleProceedsNgn > 0) {
        const movement = insertTreasuryMovementTx(db, {
          type: 'FIXED_ASSET_SALE',
          treasuryAccountId,
          amountNgn: saleProceedsNgn,
          postedAtISO: disposalDateIso,
          reference,
          counterpartyKind: 'FIXED_ASSET',
          counterpartyId: id,
          counterpartyName: cur.name,
          sourceKind: 'FIXED_ASSET',
          sourceId: id,
          note,
          createdBy: user?.displayName || user?.username || 'Finance',
          workspaceBranchId: branchId,
          workspaceViewAll: Boolean(body?.workspaceViewAll),
          actor: user,
        });
        treasuryMovementId = movement?.id ?? null;
      }

      const disposalNote =
        saleProceedsNgn > 0
          ? `Sold for ₦${saleProceedsNgn.toLocaleString('en-NG')} on ${disposalDateIso}.`
          : `Disposed without sale on ${disposalDateIso}.`;
      const existingNotes = String(cur.notes || '').trim();
      const combinedNotes = existingNotes ? `${existingNotes} ${disposalNote}` : disposalNote;

      db.prepare(
        `UPDATE fixed_assets SET
          status = 'disposed',
          disposal_date_iso = ?,
          disposal_proceeds_ngn = ?,
          updated_at_iso = ?,
          updated_by_user_id = ?,
          notes = ?
        WHERE id = ?`
      ).run(disposalDateIso, saleProceedsNgn, now, uid, combinedNotes, id);

      return { gl, treasuryMovementId };
    })();

    const row = db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(id);
    const gainLossNgn = roundMoney(saleProceedsNgn - projected.netBookValueNgn);
    return {
      ok: true,
      asset: mapFixedAssetRow(row),
      journalId: result.gl.journalId ?? null,
      glDuplicate: Boolean(result.gl.duplicate),
      treasuryMovementId: result.treasuryMovementId,
      saleProceedsNgn,
      netBookValueNgn: projected.netBookValueNgn,
      gainLossNgn,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** @param {import('better-sqlite3').Database} db */
export function disposeFixedAsset(db, assetId, bodyOrDate, user) {
  const body =
    typeof bodyOrDate === 'string'
      ? { disposalDateIso: bodyOrDate }
      : bodyOrDate && typeof bodyOrDate === 'object'
        ? bodyOrDate
        : {};
  return disposeFixedAssetWithSettlement(db, assetId, body, user);
}
