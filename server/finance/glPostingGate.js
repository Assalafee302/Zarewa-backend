/**
 * Kill-switch for local general-ledger posting.
 *
 * Invariant: operational money (treasury, receipts, payouts, GRN, payroll cash)
 * must succeed when this is off. Accounting Desk mutations should refuse with
 * GL_POSTING_DISABLED instead of writing a fake journal.
 *
 * Default ON so live books stay unchanged until ZAREWA_GL_POSTING_ENABLED=0.
 */

function envFlag(name, defaultOn) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return defaultOn;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** @returns {boolean} */
export function isGlPostingEnabled() {
  return envFlag('ZAREWA_GL_POSTING_ENABLED', true);
}

/**
 * Success-shaped skip so tryPost* callers that throw on `ok === false` still commit cash.
 * @returns {{ ok: true, skipped: true, reason: 'GL_POSTING_DISABLED', journalId: null }}
 */
export function skippedGlPostingResult() {
  return { ok: true, skipped: true, reason: 'GL_POSTING_DISABLED', journalId: null };
}

export function glPostingDisabledPayload() {
  return {
    ok: false,
    code: 'GL_POSTING_DISABLED',
    error:
      'Local general-ledger posting is turned off. Book this in the external accounting system. Cash and operational records in Zarewa are unchanged.',
  };
}

/**
 * @param {{ status: (n: number) => { json: (body: unknown) => void } }} res
 * @returns {boolean} true when the handler should return
 */
export function refuseIfGlPostingDisabled(res) {
  if (isGlPostingEnabled()) return false;
  res.status(409).json(glPostingDisabledPayload());
  return true;
}

/**
 * Express middleware for statutory GL/statements routes.
 * Operational money paths must not use this — they skip via postBalancedJournalTx.
 */
export function requireLocalGlPosting(_req, res, next) {
  if (refuseIfGlPostingDisabled(res)) return;
  next();
}
