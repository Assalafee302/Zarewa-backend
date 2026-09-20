/**
 * Which finance surfaces stay in Zarewa vs move to an external accounting product.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/localAccountingSurfaces.js
 *
 * Ops money (cash, collections) always stays. Local GL / statements hide when
 * `glPostingEnabled` is false (`ZAREWA_GL_POSTING_ENABLED=0`).
 */

/** @typedef {'creditors'|'debtors'|'treasury'|'receipts'|'wallets'|'bankReconciliation'|'fixedAssetsRegister'|'glAccounts'|'glJournals'|'trialBalance'|'statements'|'openingPack'|'monthEndClose'|'depreciation'|'controlTieOut'|'cutoverPlan'|'accountingDeskOverview'|'payrollGl'} LocalAccountingSurfaceId */

/** Always available in this ERP (transactions and who-owes-whom). */
export const ZAREWA_OPS_MONEY_SURFACES = Object.freeze([
  'creditors',
  'debtors',
  'treasury',
  'receipts',
  'wallets',
  'bankReconciliation',
  'fixedAssetsRegister',
]);

/** Statutory books — hide in the SPA when local GL posting is off. */
export const LOCAL_GL_SURFACES = Object.freeze([
  'glAccounts',
  'glJournals',
  'trialBalance',
  'statements',
  'openingPack',
  'monthEndClose',
  'depreciation',
  'controlTieOut',
  'cutoverPlan',
  'accountingDeskOverview',
  'payrollGl',
]);

/**
 * @param {boolean} glPostingEnabled
 * @returns {{
 *   glPostingEnabled: boolean,
 *   opsMoney: true,
 *   creditorsDebtors: true,
 *   localGl: boolean,
 *   surfaces: Record<LocalAccountingSurfaceId, boolean>,
 * }}
 */
export function localAccountingCapabilities(glPostingEnabled) {
  const localGl = Boolean(glPostingEnabled);
  /** @type {Record<string, boolean>} */
  const surfaces = {};
  for (const id of ZAREWA_OPS_MONEY_SURFACES) surfaces[id] = true;
  for (const id of LOCAL_GL_SURFACES) surfaces[id] = localGl;
  return {
    glPostingEnabled: localGl,
    opsMoney: true,
    creditorsDebtors: true,
    localGl,
    surfaces: /** @type {Record<LocalAccountingSurfaceId, boolean>} */ (surfaces),
  };
}

/**
 * Accounting sidebar stays (creditors/debtors). Relabel when books have moved out.
 * @param {{ id?: string, sublabel?: string, keywords?: string[] }} cmd
 * @param {boolean} glPostingEnabled
 */
export function accountingNavForLocalGl(cmd, glPostingEnabled) {
  if (cmd?.id !== 'nav-accounting' || glPostingEnabled) return cmd;
  return {
    ...cmd,
    sublabel: 'Collections & registers',
    keywords: ['accounting', 'creditors', 'debtors', 'collections', 'receivable', 'payable'],
  };
}
