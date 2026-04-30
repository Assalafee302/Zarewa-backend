#!/usr/bin/env node
/**
 * Wrapper for `qa-operations-mega.mjs` with conservative defaults for local/CI smoke runs.
 * Override any variable by setting it before invocation (this file does not overwrite non-empty env).
 */
if (!process.env.MEGA_QUOTE_COUNT) process.env.MEGA_QUOTE_COUNT = '10';
if (!process.env.MEGA_CUSTOMER_COUNT) process.env.MEGA_CUSTOMER_COUNT = '5';
if (!process.env.MEGA_LEDGER_GAP_MS) process.env.MEGA_LEDGER_GAP_MS = '0';
if (!process.env.MEGA_QUOTE_STEP_MS) process.env.MEGA_QUOTE_STEP_MS = '0';
if (!process.env.ZAREWA_TEST_SKIP_RATE_LIMIT) process.env.ZAREWA_TEST_SKIP_RATE_LIMIT = '1';

await import('./qa-operations-mega.mjs');
