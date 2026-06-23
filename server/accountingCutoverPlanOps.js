/**
 * HoA / MD cutover action plan — structured readiness from Opening Pack, AP1c, and policy flags.
 */
import { ACCOUNTING_OPENING_PERIOD_KEY } from '../shared/lib/accountingCutover.js';
import { buildOpeningPackReport } from './accountingOpeningPackOps.js';
import { getOpeningBalanceStatus } from './accountingPostingOps.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import { buildAp1cDryRunTrialSummary } from './ap1cDryRunOps.js';
import { buildCreditorsRegister, buildDebtorsRegister } from './accountingSubledgerOps.js';
import { getPeriodLock } from './accountingCloseOps.js';

/**
 * @param {'ok'|'warn'|'fail'|'pending'} status
 * @param {string} id
 * @param {string} label
 * @param {string} detail
 * @param {string} [focusTab]
 */
function planItem(status, id, label, detail, focusTab = '') {
  return { id, label, status, detail, focusTab };
}

function scoreItems(items) {
  if (!items.length) return 0;
  const weights = { ok: 1, warn: 0.5, pending: 0.25, fail: 0 };
  const sum = items.reduce((acc, i) => acc + (weights[i.status] ?? 0), 0);
  return Math.round((sum / items.length) * 100);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} [branchScope]
 * @param {{ pack?: object; skipUnlinkedScan?: boolean }} [opts]
 */
export function buildCutoverActionPlan(db, branchScope = 'ALL', opts = {}) {
  const opening = getOpeningBalanceStatus(db);
  const flags = readFinanceFeatureFlags();
  const pack = opts.pack?.ok ? opts.pack : buildOpeningPackReport(db, { branchScope, summaryOnly: true });
  const ap1c = buildAp1cDryRunTrialSummary(db, branchScope);

  let unlinkedLegacy = 0;
  if (!opts.skipUnlinkedScan) {
    try {
      const registerBranch = branchScope === 'ALL' ? 'ALL' : branchScope;
      const cred = buildCreditorsRegister(db, { branchId: registerBranch });
      const debt = buildDebtorsRegister(db, { branchId: registerBranch });
      unlinkedLegacy =
        Number(cred?.summary?.unlinkedLegacyCount ?? 0) + Number(debt?.summary?.unlinkedLegacyCount ?? 0);
    } catch {
      unlinkedLegacy = 0;
    }
  }

  const legacyReceipts = Number(ap1c.receiptsBeforeProductionCredited1200Count) || 0;
  const ap1cClear =
    legacyReceipts === 0 &&
    Number(ap1c.receiptReversalsMissingResolvableMetaCount) === 0 &&
    Number(ap1c.mixedLegacyAp1cRefundRiskCount) === 0;

  const policyLive =
    flags.accountingPolicyV1ReceiptGl &&
    flags.accountingPolicyV1ProductionRelease;

  const cutoverPeriodLock = getPeriodLock(db, ACCOUNTING_OPENING_PERIOD_KEY);

  const prepare = [
    planItem(
      pack.ok && !(pack.blockers?.length) ? (pack.readinessScore >= 90 ? 'ok' : 'warn') : 'fail',
      'opening_pack_ready',
      'Opening Pack readiness',
      pack.alreadyPosted
        ? 'Opening journal posted.'
        : pack.blockers?.length
          ? pack.blockers.join(' ')
          : `${pack.readinessScore ?? 0}% ready — target ≥ 90% before post.`,
      'opening'
    ),
    planItem(
      unlinkedLegacy === 0 ? 'ok' : 'warn',
      'legacy_linked',
      'Legacy register lines linked',
      unlinkedLegacy === 0
        ? 'No unlinked inherited creditor/debtor lines.'
        : `${unlinkedLegacy} inherited line(s) need party master links.`,
      'creditors'
    ),
    planItem(
      (pack.warnings || []).some((w) => /stock|inventory/i.test(w)) ? 'warn' : 'ok',
      'inventory_costed',
      'May inventory costed',
      (pack.warnings || []).find((w) => /stock|inventory/i.test(w)) ||
        'Stock register basis loaded for opening inventory (1300).',
      'opening'
    ),
  ];

  const cutover = [
    planItem(
      opening.posted ? 'ok' : 'pending',
      'opening_posted',
      'Opening Pack posted to GL',
      opening.posted ? 'Cutover bridge journal exists.' : 'Post Opening Pack after HoA confirms capital and rollups.',
      'opening'
    ),
    planItem(
      ap1cClear ? 'ok' : 'warn',
      'ap1c_dry_run',
      'AP1c dry-run clear',
      ap1cClear
        ? 'No material receipt/deposit policy conflicts detected.'
        : `${legacyReceipts} receipt(s) on AR before production — resolve on Deposits tab before policy go-live.`,
      'policy'
    ),
    planItem(
      policyLive ? 'ok' : 'warn',
      'policy_flags',
      'Revenue policy live in GL',
      policyLive
        ? 'Receipt GL and production release flags enabled.'
        : 'Enable AP1c flags after dry-run sign-off (HoA + DevOps).',
      'policy'
    ),
  ];

  const run = [
    planItem(
      flags.accountingPolicyV1Diagnostics ? 'ok' : 'warn',
      'diagnostics_on',
      'Policy diagnostics enabled',
      flags.accountingPolicyV1Diagnostics
        ? 'Trial diagnostics active for exception monitoring.'
        : 'Set ACCOUNTING_POLICY_V1_DIAGNOSTICS=1 during pilot month.',
      'overview'
    ),
    planItem(
      cutoverPeriodLock?.locked ? 'ok' : 'pending',
      'first_period_lock',
      `Lock ${ACCOUNTING_OPENING_PERIOD_KEY}`,
      cutoverPeriodLock?.locked
        ? `Period locked — ${cutoverPeriodLock.reason || 'month-end complete'}.`
        : 'Complete month-end close checklist and lock the cutover month.',
      'close'
    ),
  ];

  const phases = [
    { id: 'prepare', title: 'Prepare operational truth', items: prepare },
    { id: 'cutover', title: 'Cutover & policy go-live', items: cutover },
    { id: 'run', title: 'First locked month', items: run },
  ];

  const allItems = [...prepare, ...cutover, ...run];
  const progressPct = scoreItems(allItems);
  const blockers = allItems.filter((i) => i.status === 'fail').length;
  const warnings = allItems.filter((i) => i.status === 'warn').length;
  const complete = allItems.filter((i) => i.status === 'ok').length;

  return {
    ok: true,
    cutoverPeriodKey: ACCOUNTING_OPENING_PERIOD_KEY,
    branchScope,
    progressPct,
    complete,
    total: allItems.length,
    blockers,
    warnings,
    phases,
    disclaimer:
      'Management cutover plan — not statutory sign-off. HoA and MD should issue a written cutover memo when complete.',
    summary:
      opening.posted && policyLive && cutoverPeriodLock?.locked
        ? 'Cutover path complete — maintain monthly close discipline.'
        : blockers > 0
          ? `${blockers} blocker(s) on cutover plan — resolve before board reliance.`
          : `${complete}/${allItems.length} steps complete (${progressPct}%) — continue month-end close.`,
  };
}
