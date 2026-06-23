/**
 * MD Command Centre composition — pulses and champion customer snippets.
 */
import { getOrgGovernanceLimits } from './orgPolicy.js';
import { summarizeExecWorkTrayApprovalTiers } from '../shared/lib/execApprovalTier.js';

const PULSE_GREEN = 'green';
const PULSE_AMBER = 'amber';
const PULSE_RED = 'red';

function pulseStatus(metric, { green, amber }) {
  if (metric == null || Number.isNaN(Number(metric))) return { status: PULSE_AMBER, label: 'Unknown' };
  const n = Number(metric);
  if (n >= green) return { status: PULSE_GREEN, label: 'OK' };
  if (n >= amber) return { status: PULSE_AMBER, label: 'Watch' };
  return { status: PULSE_RED, label: 'Action' };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   branchScope: string;
 *   treasuryCashNgn: number;
 *   outstandingReceivablesNgn: number;
 *   inventoryValueNgn: number;
 *   producedRevenueNgn: number;
 *   targetRevenueNgn: number | null;
 *   completedMetres: number;
 *   targetMetres: number | null;
 *   priceExceptionCount: number;
 *   payrollDraftsAwaitingMd: number;
 *   workTrayItems: object[];
 *   biPack: object | null;
 * }} ctx
 */
export function buildMdCockpitPulses(db, ctx) {
  const limits = ctx?.limits ?? getOrgGovernanceLimits(db);
  const monthlyPayrollProxy = Math.max(
    1,
    Math.round(Number(limits?.expenseExecutiveThresholdNgn) || 200_000) * 15
  );
  const cashWeeks = ctx.treasuryCashNgn / (monthlyPayrollProxy / 4.33);
  const cashPulse = pulseStatus(cashWeeks, { green: 4, amber: 2 });

  let minWeeksCover = null;
  try {
    const families = ctx.biPack?.inventory?.families || [];
    const covers = families
      .map((f) => Number(f.weeksCover))
      .filter((w) => Number.isFinite(w) && w >= 0);
    if (covers.length) minWeeksCover = Math.min(...covers);
  } catch {
    minWeeksCover = null;
  }
  const coilPulse = pulseStatus(minWeeksCover, { green: 3, amber: 2 });

  let metresPct = null;
  if (ctx.targetMetres != null && ctx.targetMetres > 0) {
    metresPct = (Number(ctx.completedMetres) || 0) / ctx.targetMetres;
  }
  const metresPulse =
    metresPct == null
      ? { status: PULSE_AMBER, label: 'No target' }
      : pulseStatus(metresPct, { green: 0.85, amber: 0.7 });

  const marginPulse =
    Number(ctx.priceExceptionCount) > 0
      ? { status: PULSE_RED, label: `${ctx.priceExceptionCount} exception(s)` }
      : { status: PULSE_GREEN, label: 'Clean' };

  const tierSummary = summarizeExecWorkTrayApprovalTiers(ctx.workTrayItems || []);
  const peoplePulse =
    Number(ctx.payrollDraftsAwaitingMd) > 0 || tierSummary.mdOnly > 0
      ? {
          status: PULSE_AMBER,
          label:
            Number(ctx.payrollDraftsAwaitingMd) > 0
              ? 'Payroll sign-off'
              : `${tierSummary.mdOnly} MD item(s)`,
        }
      : { status: PULSE_GREEN, label: 'Clear' };

  return {
    cash: {
      status: cashPulse.status,
      label: cashPulse.label,
      valueNgn: Math.round(ctx.treasuryCashNgn || 0),
      weeksCover: cashWeeks != null && Number.isFinite(cashWeeks) ? Math.round(cashWeeks * 10) / 10 : null,
      estimated: true,
    },
    coil: {
      status: coilPulse.status,
      label: coilPulse.label,
      weeksCover: minWeeksCover != null ? Math.round(minWeeksCover * 10) / 10 : null,
      estimated: true,
    },
    metres: {
      status: metresPulse.status,
      label: metresPulse.label,
      completed: Math.round(Number(ctx.completedMetres) || 0),
      target: ctx.targetMetres != null ? Math.round(ctx.targetMetres) : null,
      estimated: false,
    },
    margin: {
      status: marginPulse.status,
      label: marginPulse.label,
      priceExceptionCount: Number(ctx.priceExceptionCount) || 0,
    },
    people: {
      status: peoplePulse.status,
      label: peoplePulse.label,
      payrollDraftsAwaitingMd: Number(ctx.payrollDraftsAwaitingMd) || 0,
      mdOnlyQueue: tierSummary.mdOnly,
    },
  };
}

/**
 * Champion customer from period payment totals.
 * @param {object[]} topCustomersByPayments
 */
export function buildChampionCustomerSnippet(topCustomersByPayments) {
  const rows = Array.isArray(topCustomersByPayments) ? topCustomersByPayments : [];
  if (!rows.length) {
    return { ok: true, champion: null };
  }
  const best = rows[0];
  const name = String(best.customerName || best.name || best.customer_name || 'Customer').trim();
  const paidNgn = Math.round(Number(best.paidNgn ?? best.totalPaidNgn ?? best.amountNgn) || 0);
  const branchId = String(best.branchId || best.branch_id || '').trim();
  return {
    ok: true,
    champion: {
      customerName: name,
      paidNgn,
      branchId,
      customerId: String(best.customerId || best.customer_id || '').trim() || null,
    },
  };
}
