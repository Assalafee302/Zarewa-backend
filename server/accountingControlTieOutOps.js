/**
 * Register ↔ GL control tie-out (management reconciliation).
 * See docs/ACCOUNTING_SYSTEM_ARCHITECTURE.md §7
 */
import { ACCOUNTING_OPENING_DATE_ISO } from '../shared/lib/accountingCutover.js';
import { monthBounds } from './accountingStatementsOps.js';
import { trialBalanceRows } from './glOps.js';
import {
  rollupCreditorsSources,
  rollupDebtorsSources,
  rollupInventorySource,
  ASSET_CATEGORY_TO_GL,
} from './accountingOpeningPackOps.js';
import { listFixedAssets } from './accountingPhase2Ops.js';
import { listTreasuryAccounts } from './readModel.js';

const DEFAULT_VARIANCE_PCT = 0.01;
const MATERIAL_FLOOR_NGN = 50_000;

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

/**
 * @param {number} registerNgn
 * @param {number} glNgn
 * @param {number} [thresholdPct]
 */
export function assessControlVariance(registerNgn, glNgn, thresholdPct = DEFAULT_VARIANCE_PCT) {
  const reg = roundMoney(registerNgn);
  const gl = roundMoney(glNgn);
  const varianceNgn = reg - gl;
  const base = Math.max(Math.abs(reg), Math.abs(gl), 1);
  const variancePct = Math.abs(varianceNgn) / base;
  const immaterial =
    reg === 0 && gl === 0
      ? true
      : Math.abs(varianceNgn) <= MATERIAL_FLOOR_NGN || variancePct <= thresholdPct;
  return {
    registerNgn: reg,
    glNgn: gl,
    varianceNgn,
    variancePct: Math.round(variancePct * 10_000) / 100,
    status: immaterial ? 'ok' : 'warn',
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} endISO
 */
function glBalanceMap(db, endISO) {
  const startISO = ACCOUNTING_OPENING_DATE_ISO.slice(0, 10);
  const tb = trialBalanceRows(db, startISO, endISO);
  if (!tb.ok || !Array.isArray(tb.rows)) return { ok: false, error: tb.error || 'Trial balance unavailable.' };
  /** @type {Record<string, { debitNgn: number; creditNgn: number; netNgn: number }>} */
  const map = {};
  for (const r of tb.rows) {
    map[r.accountCode] = {
      debitNgn: roundMoney(r.debitNgn),
      creditNgn: roundMoney(r.creditNgn),
      netNgn: roundMoney(r.netNgn ?? r.debitNgn - r.creditNgn),
    };
  }
  return { ok: true, map, startISO, endISO };
}

/** @param {Record<string, object>} map @param {string} code @param {'debit'|'credit'} normalSide */
function glSignedBalance(map, code, normalSide) {
  const row = map[code];
  if (!row) return 0;
  const net = roundMoney(row.netNgn);
  return normalSide === 'debit' ? Math.max(net, 0) : Math.max(-net, 0);
}

function sumGlCodes(map, codes, normalSide) {
  return codes.reduce((s, c) => s + glSignedBalance(map, c, normalSide), 0);
}

function sumGlCodePrefix(map, prefix, normalSide) {
  return Object.keys(map).reduce((s, code) => {
    if (!code.startsWith(prefix)) return s;
    return s + glSignedBalance(map, code, normalSide);
  }, 0);
}

/**
 * @param {object[]} sources
 * @param {string} code
 * @param {'debit'|'credit'} side
 */
function registerTotal(sources, code, side) {
  return sources
    .filter((s) => s.glAccountCode === code && s.side === side)
    .reduce((sum, s) => sum + roundMoney(s.amountNgn), 0);
}

function registerPrefixTotal(sources, prefix, side) {
  return sources
    .filter((s) => String(s.glAccountCode || '').startsWith(prefix) && s.side === side)
    .reduce((sum, s) => sum + roundMoney(s.amountNgn), 0);
}

/**
 * @param {object} p
 */
function tieCheck(p) {
  const assessed = assessControlVariance(p.registerNgn, p.glNgn, p.thresholdPct);
  return {
    id: p.id,
    label: p.label,
    glAccountCode: p.glAccountCode,
    normalSide: p.normalSide,
    drillDownTab: p.drillDownTab || '',
    ...assessed,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   periodKey: string;
 *   branchScope?: 'ALL' | string;
 *   thresholdPct?: number;
 * }} opts
 */
export function buildControlTieOutReport(db, opts) {
  const periodKey = String(opts.periodKey || '').trim();
  const b = monthBounds(periodKey);
  if (!b) return { ok: false, error: 'periodKey must be YYYY-MM.' };

  const branchScope = opts.branchScope || 'ALL';
  const thresholdPct = Number(opts.thresholdPct) > 0 ? Number(opts.thresholdPct) : DEFAULT_VARIANCE_PCT;

  const gl = glBalanceMap(db, b.end);
  if (!gl.ok) return { ok: false, error: gl.error };

  const sources = [
    ...rollupCreditorsSources(db, branchScope),
    ...rollupDebtorsSources(db, branchScope),
    rollupInventorySource(db, periodKey, branchScope),
    ...rollupTreasuryFromAssets(db, branchScope),
  ];

  const assetCodes = [...new Set(Object.values(ASSET_CATEGORY_TO_GL))];
  const { assets = [] } = listFixedAssets(db, branchScope);
  const activeAssets = assets.filter((a) => String(a.status || 'active') === 'active');
  const registerAssetCost = activeAssets.reduce((s, a) => s + roundMoney(a.costNgn), 0);
  const registerAccDep = activeAssets.reduce((s, a) => s + roundMoney(a.accumulatedDepreciationNgn), 0);

  const checks = [
    tieCheck({
      id: 'trade_receivable',
      label: 'Trade receivable',
      glAccountCode: '1200',
      normalSide: 'debit',
      registerNgn: registerTotal(sources, '1200', 'debit'),
      glNgn: glSignedBalance(gl.map, '1200', 'debit'),
      drillDownTab: 'creditors',
      thresholdPct,
    }),
    tieCheck({
      id: 'supplier_prepay',
      label: 'Supplier prepayments',
      glAccountCode: '1400',
      normalSide: 'debit',
      registerNgn: registerTotal(sources, '1400', 'debit'),
      glNgn: glSignedBalance(gl.map, '1400', 'debit'),
      drillDownTab: 'creditors',
      thresholdPct,
    }),
    tieCheck({
      id: 'inter_branch_recv',
      label: 'Inter-branch receivable',
      glAccountCode: '1800',
      normalSide: 'debit',
      registerNgn: registerTotal(sources, '1800', 'debit'),
      glNgn: glSignedBalance(gl.map, '1800', 'debit'),
      drillDownTab: 'interBranch',
      thresholdPct,
    }),
    tieCheck({
      id: 'trade_payable',
      label: 'Trade payables',
      glAccountCode: '2000',
      normalSide: 'credit',
      registerNgn: registerTotal(sources, '2000', 'credit'),
      glNgn: glSignedBalance(gl.map, '2000', 'credit'),
      drillDownTab: 'debtors',
      thresholdPct,
    }),
    tieCheck({
      id: 'customer_deposits',
      label: 'Customer deposits',
      glAccountCode: '2500',
      normalSide: 'credit',
      registerNgn: registerTotal(sources, '2500', 'credit'),
      glNgn: glSignedBalance(gl.map, '2500', 'credit'),
      drillDownTab: 'debtors',
      thresholdPct,
    }),
    tieCheck({
      id: 'bank_suspense',
      label: 'Bank suspense',
      glAccountCode: '2150',
      normalSide: 'credit',
      registerNgn: registerTotal(sources, '2150', 'credit'),
      glNgn: glSignedBalance(gl.map, '2150', 'credit'),
      drillDownTab: 'debtors',
      thresholdPct,
    }),
    tieCheck({
      id: 'inter_branch_pay',
      label: 'Inter-branch payable',
      glAccountCode: '2800',
      normalSide: 'credit',
      registerNgn: registerTotal(sources, '2800', 'credit'),
      glNgn: glSignedBalance(gl.map, '2800', 'credit'),
      drillDownTab: 'interBranch',
      thresholdPct,
    }),
    tieCheck({
      id: 'inventory',
      label: `Inventory (${periodKey})`,
      glAccountCode: '1300',
      normalSide: 'debit',
      registerNgn: registerTotal(sources, '1300', 'debit'),
      glNgn: glSignedBalance(gl.map, '1300', 'debit'),
      drillDownTab: 'costing',
      thresholdPct,
    }),
    tieCheck({
      id: 'fixed_assets_cost',
      label: 'Fixed assets (cost)',
      glAccountCode: '1500',
      normalSide: 'debit',
      registerNgn: registerAssetCost,
      glNgn: sumGlCodes(gl.map, assetCodes, 'debit'),
      drillDownTab: 'assets',
      thresholdPct,
    }),
    tieCheck({
      id: 'accumulated_depreciation',
      label: 'Accumulated depreciation',
      glAccountCode: '1398',
      normalSide: 'credit',
      registerNgn: registerAccDep,
      glNgn: glSignedBalance(gl.map, '1398', 'credit'),
      drillDownTab: 'assets',
      thresholdPct,
    }),
    tieCheck({
      id: 'cash_per_bank',
      label: 'Cash per bank',
      glAccountCode: '1001',
      normalSide: 'debit',
      registerNgn: registerPrefixTotal(sources, '100', 'debit'),
      glNgn: sumGlCodePrefix(gl.map, '100', 'debit'),
      drillDownTab: 'reconciliation',
      thresholdPct,
    }),
  ];

  const warnings = checks.filter((c) => c.status === 'warn').length;
  const blockers = 0;

  return {
    ok: true,
    periodKey: b.periodKey,
    range: { start: b.start, end: b.end },
    branchScope,
    thresholdPct,
    checks,
    warnings,
    blockers,
    allClear: warnings === 0,
    label: 'Register ↔ GL control tie-out',
    disclaimer: 'Management tie-out only — compare operational registers to GL control balances.',
    summary:
      warnings === 0
        ? 'All control accounts within tolerance.'
        : `${warnings} control account(s) outside ${Math.round(thresholdPct * 100)}% tolerance — review registers and GL postings.`,
  };
}

/**
 * Treasury rollup for tie-out (mirrors opening pack without GL account creation).
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
function rollupTreasuryFromAssets(db, branchScope) {
  const accounts = listTreasuryAccounts(db, branchScope);
  return accounts.map((ta) => {
    const code = String(1000 + Number(ta.id));
    const bal = roundMoney(ta.balance ?? ta.openingBalanceNgn ?? 0);
    return {
      id: `treasury_${ta.id}`,
      module: 'treasury',
      label: `Cash — ${ta.name || ta.bankName || `Account ${ta.id}`}`,
      glAccountCode: code,
      side: 'debit',
      amountNgn: bal,
      rowCount: 1,
      drillDownTab: 'reconciliation',
      status: bal > 0 ? 'ok' : 'empty',
    };
  });
}
