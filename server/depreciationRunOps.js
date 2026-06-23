/**
 * Monthly fixed-asset depreciation batch → GL (Dr 6100 / Cr 1398).
 * @param {import('better-sqlite3').Database} db
 */

import { listFixedAssets } from './accountingPhase2Ops.js';
import { monthBounds } from './accountingStatementsOps.js';
import { assertPeriodOpen } from './controlOps.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { postBalancedJournalTx } from './glOps.js';

function groupDepreciationRowsByBranch(rows) {
  /** @type {Map<string, typeof rows>} */
  const byBranch = new Map();
  for (const row of rows || []) {
    const bid = String(row.branchId ?? '').trim() || DEFAULT_BRANCH_ID;
    if (!byBranch.has(bid)) byBranch.set(bid, []);
    byBranch.get(bid).push(row);
  }
  return byBranch;
}

function activeInMonth(asset, periodKey) {
  const b = monthBounds(periodKey);
  if (!b) return false;
  if (asset.acquisitionDateIso > b.end) return false;
  if (asset.status === 'disposed' && asset.disposalDateIso && asset.disposalDateIso < b.start) return false;
  return true;
}

/** @param {import('better-sqlite3').Database} db @param {'ALL' | string} branchScope */
export function previewDepreciationRun(db, periodKey, branchScope = 'ALL') {
  const b = monthBounds(periodKey);
  if (!b) return { ok: false, error: 'periodKey must be YYYY-MM.' };
  const { assets } = listFixedAssets(db, branchScope);
  const rows = [];
  let total = 0;
  for (const a of assets || []) {
    if (!activeInMonth(a, periodKey)) continue;
    if (String(a.category || '').toLowerCase() === 'land') continue;
    const m = Math.round(Number(a.monthlyDepreciationNgn) || 0);
    if (m <= 0) continue;
    rows.push({
      assetId: a.id,
      name: a.name,
      branchId: a.branchId,
      amountNgn: m,
    });
    total += m;
  }
  return {
    ok: true,
    periodKey: b.periodKey,
    branchScope,
    entryDateISO: b.end,
    rows,
    totalDepreciationNgn: total,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} workspaceBranchId Branch tag on journal header when scope is single-branch (legacy; scope wins)
 */
export function postDepreciationRun(db, periodKey, branchScope, user, workspaceBranchId) {
  const pre = previewDepreciationRun(db, periodKey, branchScope);
  if (!pre.ok) return pre;
  if (pre.totalDepreciationNgn <= 0) {
    return { ok: false, error: 'No depreciation to post for this period and scope.' };
  }
  const b = monthBounds(periodKey);
  try {
    assertPeriodOpen(db, b.end, 'Depreciation posting date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const scope = String(branchScope || 'ALL').trim() || 'ALL';
  const branchBatches =
    scope !== 'ALL'
      ? [[scope, pre.rows || []]]
      : [...groupDepreciationRowsByBranch(pre.rows).entries()];

  const journalIds = [];
  let postedTotal = 0;
  let anyDuplicate = false;

  const postBatch = (bid, rows) => {
    const branchId = String(bid || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
    const batchRows = (rows || []).filter((r) => Math.round(Number(r.amountNgn) || 0) > 0);
    if (!batchRows.length) return;
    const batchTotal = batchRows.reduce((s, r) => s + Math.round(Number(r.amountNgn) || 0), 0);
    if (batchTotal <= 0) return;
    const sourceId = `${b.periodKey}:${branchId}`;
    const lines = batchRows.map((row) => ({
      accountCode: '6100',
      debitNgn: row.amountNgn,
      memo: `${row.name || 'Asset'} (${row.assetId})`,
    }));
    lines.push({
      accountCode: '1398',
      creditNgn: batchTotal,
      memo: b.periodKey,
    });
    const r = postBalancedJournalTx(db, {
      entryDateISO: b.end,
      memo: `Monthly depreciation ${b.periodKey} · ${branchId}`,
      sourceKind: 'DEPRECIATION_RUN',
      sourceId,
      branchId,
      createdByUserId: user?.id,
      lines,
    });
    if (!r.ok) throw new Error(r.error || 'Depreciation GL posting failed.');
    if (r.duplicate) anyDuplicate = true;
    else if (r.journalId) journalIds.push(r.journalId);
    postedTotal += batchTotal;
  };

  try {
    db.transaction(() => {
      for (const [bid, rows] of branchBatches) {
        postBatch(bid, rows);
      }
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  if (!journalIds.length && anyDuplicate) {
    return {
      ok: true,
      duplicate: true,
      totalDepreciationNgn: pre.totalDepreciationNgn,
      periodKey: pre.periodKey,
      branchScope: pre.branchScope,
    };
  }

  return {
    ok: true,
    journalId: journalIds[0] || null,
    journalIds,
    duplicate: anyDuplicate && journalIds.length === 0,
    totalDepreciationNgn: postedTotal || pre.totalDepreciationNgn,
    periodKey: pre.periodKey,
    branchScope: pre.branchScope,
  };
}
