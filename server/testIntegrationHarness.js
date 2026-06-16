import { createDatabase } from './db.js';
import { createApp } from './app.js';

/** @type {boolean | null} */
let mysqlAvailableCache = null;

/** Whether local MySQL (Vitest `:memory:` harness) is reachable. */
export function isMysqlAvailableForTests() {
  if (mysqlAvailableCache != null) return mysqlAvailableCache;
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    mysqlAvailableCache = true;
  } catch {
    mysqlAvailableCache = false;
  }
  return mysqlAvailableCache;
}

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

/** Resolve seeded admin actor for direct DB ops in integration tests. */
export function resolveTestActor(db) {
  const admin = db.prepare(`SELECT id, username, display_name FROM app_users WHERE username = 'admin' LIMIT 1`).get();
  return {
    id: admin?.id || 'admin',
    username: admin?.username || 'admin',
    displayName: admin?.display_name || 'Admin',
  };
}

export function isoNow() {
  return new Date().toISOString();
}
