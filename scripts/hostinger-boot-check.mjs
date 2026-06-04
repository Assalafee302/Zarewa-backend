#!/usr/bin/env node
/**
 * Quick import check before Hostinger Node restart (no DB required).
 * Usage: node scripts/hostinger-boot-check.mjs
 */
import { readFinanceFeatureFlags } from '../server/financeFeatureFlags.js';
import { wrapFinanceQuerySource } from '../server/financeTrialExceptions.js';

const flags = readFinanceFeatureFlags();
if (flags.strictCashierRbac || flags.enforceDualControlPayments) {
  console.warn('[hostinger-boot-check] Warning: strict finance flags are enabled in env.');
}
wrapFinanceQuerySource({ prepare: () => ({ all: () => [] }) });
console.log(
  JSON.stringify({
    ok: true,
    phase: flags.phase,
    trialExceptionsB3a: 'v1',
    message: 'Finance B3a modules load OK. Restart Node app in hPanel if /api/health is still 503.',
  })
);
