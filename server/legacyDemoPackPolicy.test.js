import { describe, it, expect, afterEach, vi } from 'vitest';
import { createDatabase } from './db.js';
import { applyAdminDataReset, ADMIN_DATA_RESET_CONFIRM_PHRASE } from './adminDataResetOps.js';
import {
  legacyDemoPackActive,
  POLICY_KEY_SUPPRESS_LEGACY_DEMO,
} from './legacyDemoPackPolicy.js';

describe('legacyDemoPackPolicy', () => {
  let db;

  afterEach(() => {
    db?.close();
    vi.unstubAllEnvs();
  });

  it('legacyDemoPackActive is false in production unless ZAREWA_LEGACY_DEMO_PACK is on', () => {
    vi.stubEnv('NODE_ENV', 'production');
    db = createDatabase(':memory:', { seed: false });
    expect(legacyDemoPackActive(db)).toBe(false);
    vi.stubEnv('ZAREWA_LEGACY_DEMO_PACK', '1');
    expect(legacyDemoPackActive(db)).toBe(true);
  });

  it('legacyDemoPackActive is false when org policy suppresses', () => {
    db = createDatabase(':memory:');
    expect(legacyDemoPackActive(db)).toBe(true);
    db.prepare(
      `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
       VALUES (?,?,?,?,?)`
    ).run(POLICY_KEY_SUPPRESS_LEGACY_DEMO, JSON.stringify(true), new Date().toISOString(), null, null);
    expect(legacyDemoPackActive(db)).toBe(false);
  });

  it('createDatabase omits NDA demo rows in production without opt-in', () => {
    vi.stubEnv('NODE_ENV', 'production');
    db = createDatabase(':memory:');
    expect(db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get('CUS-NDA')).toBeUndefined();
    expect(db.prepare(`SELECT id FROM quotations WHERE id = ?`).get('QT-2026-027')).toBeUndefined();
    expect(db.prepare(`SELECT id FROM sales_receipts WHERE id = ?`).get('RC-2026-1849')).toBeUndefined();
    expect(db.prepare(`SELECT id FROM cutting_lists WHERE id = ?`).get('CL-2026-1592')).toBeUndefined();
  });

  it('operations_core admin reset records suppression', () => {
    db = createDatabase(':memory:');
    expect(db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get('CUS-NDA')?.customer_id).toBe(
      'CUS-NDA'
    );
    const r = applyAdminDataReset(db, ['operations_core'], ADMIN_DATA_RESET_CONFIRM_PHRASE, {
      actorId: 'u-test',
    });
    expect(r.ok).toBe(true);
    expect(legacyDemoPackActive(db)).toBe(false);
    const row = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(POLICY_KEY_SUPPRESS_LEGACY_DEMO);
    expect(JSON.parse(String(row.value_json))).toBe(true);
  });
});
