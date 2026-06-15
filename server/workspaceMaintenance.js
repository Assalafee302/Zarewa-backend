import { runQuotationLifecycleMaintenance } from './quotationLifecycleOps.js';

/**
 * Background-safe maintenance (no per-user work-item sync).
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchScope?: 'ALL' | string }} [opts]
 */
export function runWorkspaceMaintenance(db, opts = {}) {
  const branchScope = opts.branchScope ?? 'ALL';
  if (process.env.NODE_ENV === 'test') return;
  try {
    if (process.env.NODE_ENV !== 'test' || process.env.ZAREWA_TEST_QUOTE_LIFECYCLE === '1') {
      runQuotationLifecycleMaintenance(db, branchScope);
    }
  } catch (e) {
    console.error('[zarewa] quotation lifecycle maintenance failed', e);
  }
}

/**
 * Periodic quotation lifecycle — keeps read paths fast by not running maintenance on every bootstrap.
 * @param {import('better-sqlite3').Database} db
 */
export function scheduleWorkspaceMaintenance(db) {
  if (process.env.NODE_ENV === 'test') return undefined;
  if (String(process.env.ZAREWA_WORKSPACE_MAINTENANCE || '1').trim() === '0') return undefined;

  const intervalMs = Math.min(
    60 * 60 * 1000,
    Math.max(60_000, Number(process.env.ZAREWA_WORKSPACE_MAINTENANCE_MS) || 5 * 60 * 1000)
  );

  const tick = () => {
    try {
      runWorkspaceMaintenance(db, { branchScope: 'ALL' });
    } catch (e) {
      console.error('[zarewa] scheduled workspace maintenance failed', e);
    }
  };

  const bootDelay = Math.max(5_000, Number(process.env.ZAREWA_WORKSPACE_MAINTENANCE_BOOT_MS) || 15_000);
  const bootTimer = setTimeout(tick, bootDelay);
  const interval = setInterval(tick, intervalMs);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();
  if (typeof interval.unref === 'function') interval.unref();

  return () => {
    clearTimeout(bootTimer);
    clearInterval(interval);
  };
}
