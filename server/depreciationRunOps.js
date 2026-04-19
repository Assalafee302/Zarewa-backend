/**
 * Monthly fixed-asset depreciation batch → GL (Dr 6100 / Cr 1398).
 * @param {import('better-sqlite3').Database} db
 */

import { listFixedAssets } from './accountingPhase2Ops.js';
import { monthBounds } from './accountingStatementsOps.js';
import { assertPeriodOpen } from './controlOps.js';
import { postBalancedJournal } from './glOps.js';

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
 * @param {string} workspaceBranchId Branch tag on journal header (optional)
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
  const sourceId = `${b.periodKey}:${branchScope || 'ALL'}`;
  const lines = (pre.rows || []).map((row) => ({
    accountCode: '6100',
    debitNgn: row.amountNgn,
    memo: `${row.name || 'Asset'} (${row.assetId})`,
  }));
  lines.push({
    accountCode: '1398',
    creditNgn: pre.totalDepreciationNgn,
    memo: b.periodKey,
  });
  const r = postBalancedJournal(db, {
    entryDateISO: b.end,
    memo: `Monthly depreciation ${b.periodKey}`,
    sourceKind: 'DEPRECIATION_RUN',
    sourceId,
    branchId: workspaceBranchId || null,
    createdByUserId: user?.id,
    lines,
  });
  if (!r.ok) return r;
  return {
    ok: true,
    journalId: r.journalId,
    duplicate: Boolean(r.duplicate),
    totalDepreciationNgn: pre.totalDepreciationNgn,
    periodKey: pre.periodKey,
    branchScope: pre.branchScope,
  };
}
