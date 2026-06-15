import { createDatabase } from './db.js';
import { createApp } from './app.js';

/** @type {{ db: import('./db.js').Database; app: import('express').Express } | null} */
let cached = null;
let refCount = 0;

/**
 * Reuse one seeded MySQL test DB + Express app per Vitest worker (singleFork).
 * Avoids repeated wipe+seed that triggers vitest worker IPC timeouts.
 */
export function acquireIntegrationHarness() {
  process.env.NODE_ENV = 'test';
  process.env.ZAREWA_TEST_ENFORCE_CSRF = '1';
  refCount += 1;
  if (!cached) {
    const db = createDatabase(':memory:');
    cached = { db, app: createApp(db) };
  }
  return cached;
}

export function releaseIntegrationHarness() {
  refCount = Math.max(0, refCount - 1);
}

/** Call when the Vitest worker exits. */
export function closeIntegrationHarness() {
  if (cached) {
    cached.db?.close();
    cached = null;
    refCount = 0;
  }
}
