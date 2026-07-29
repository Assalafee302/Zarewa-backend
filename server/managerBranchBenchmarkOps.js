/**
 * BM-safe branch benchmark — same BI aggregates as exec scorecard (ALL-branch pack).
 */
import { loadBusinessIntelligencePack } from './businessIntelligenceOps.js';
import { buildEnrichedBranchScorecard } from './execDashboardOps.js';

function avg(nums) {
  const list = nums.filter((n) => n != null && Number.isFinite(Number(n))).map(Number);
  if (!list.length) return null;
  return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId: string, periodKey?: string }} scope
 */
export function buildManagerBranchBenchmark(db, scope) {
  const branchId = String(scope.branchId || '').trim();
  if (!branchId) return { ok: false, error: 'branchId is required.' };
  const periodKey = String(scope.periodKey || 'month').trim() || 'month';

  let biPack;
  try {
    biPack = loadBusinessIntelligencePack(db, 'ALL', { periodKey });
  } catch (e) {
    return { ok: false, error: String(e?.message || e || 'BI pack failed') };
  }
  if (!biPack?.ok) {
    return { ok: false, error: biPack?.error || 'Could not load branch breakdown.' };
  }

  const byBranchRows = biPack.branchBreakdown?.byBranch || [];
  const expenseByBranch = biPack.expenseAnalysis?.byBranch || [];
  let enriched = byBranchRows;
  try {
    enriched = buildEnrichedBranchScorecard(
      db,
      byBranchRows,
      new Map(),
      expenseByBranch,
      new Map(),
      new Map()
    );
  } catch {
    enriched = byBranchRows;
  }

  const peers = enriched
    .map((b) => ({
      branchId: b.branchId,
      branchName: b.branchName || b.branchId,
      producedRevenueNgn: Math.round(Number(b.producedRevenueNgn) || 0),
      netCollectedNgn: Math.round(Number(b.netCollectedNgn) || 0),
      internalScore: b.internalScore != null ? Number(b.internalScore) : null,
      producedCollectionRatePct:
        b.producedCollectionRatePct != null ? Number(b.producedCollectionRatePct) : null,
    }))
    .sort((a, b) => (b.producedRevenueNgn || 0) - (a.producedRevenueNgn || 0));

  const you = peers.find((p) => String(p.branchId) === branchId) || null;
  const companyAvg = {
    producedRevenueNgn: avg(peers.map((p) => p.producedRevenueNgn)),
    netCollectedNgn: avg(peers.map((p) => p.netCollectedNgn)),
    internalScore: avg(peers.map((p) => p.internalScore)),
  };

  return {
    ok: true,
    periodKey,
    asOfISO: biPack.asOfISO || null,
    branchId,
    you,
    companyAvg,
    peers,
    yourRank: you ? peers.findIndex((p) => String(p.branchId) === branchId) + 1 : null,
    peerCount: peers.length,
    comparisonAvailable: peers.length > 1,
    source: 'loadBusinessIntelligencePack(ALL) + buildEnrichedBranchScorecard',
  };
}
