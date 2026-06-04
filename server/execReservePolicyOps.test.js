import { describe, expect, it } from 'vitest';
import {
  buildReservePolicyReadiness,
  getExecReservePolicyResponse,
  RESERVE_POLICY_KEYS,
  setExecReservePolicy,
  validateReservePolicyPutBody,
} from './execReservePolicyOps.js';
import { createDatabase } from './db.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe('execReservePolicyOps', () => {
  it('validateReservePolicyPutBody rejects invalid money and booleans without DB', () => {
    const badMoney = validateReservePolicyPutBody({
      operatingReserveNgn: -100,
      emergencyReserveNgn: 0,
      payrollReserveNgn: 0,
      supplierPaymentReserveNgn: 0,
      stockPurchaseReserveNgn: 0,
      taxStatutoryReserveNgn: 0,
      includeReceivables: false,
      includeInventory: false,
      includePoCommitments: true,
    });
    expect(badMoney.ok).toBe(false);

    const badBool = validateReservePolicyPutBody({
      operatingReserveNgn: 0,
      emergencyReserveNgn: 0,
      payrollReserveNgn: 0,
      supplierPaymentReserveNgn: 0,
      stockPurchaseReserveNgn: 0,
      taxStatutoryReserveNgn: 0,
      includeReceivables: 'no',
      includeInventory: false,
      includePoCommitments: true,
    });
    expect(badBool.ok).toBe(false);

    const good = validateReservePolicyPutBody({
      operatingReserveNgn: 1,
      emergencyReserveNgn: 0,
      payrollReserveNgn: 0,
      supplierPaymentReserveNgn: 0,
      stockPurchaseReserveNgn: 0,
      taxStatutoryReserveNgn: 0,
      includeReceivables: false,
      includeInventory: false,
      includePoCommitments: true,
      policyNotes: ' ok ',
    });
    expect(good.ok).toBe(true);
    expect(good.amounts.operatingReserveNgn).toBe(1);
    expect(good.policyNotes).toBe('ok');
  });

  it.skipIf(!mysqlOk)('GET shape reports missing keys when not configured', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const res = getExecReservePolicyResponse(db);
      expect(res.ok).toBe(true);
      expect(res.configured).toBe(false);
      expect(res.headroomHidden).toBe(true);
      expect(res.missingKeys.length).toBe(RESERVE_POLICY_KEYS.length);
      expect(res.policy.operatingReserveNgn.configured).toBe(false);
      expect(res.note).toMatch(/incomplete/i);
      expect(res.phaseNote).toMatch(/Indicative expansion headroom/i);
    } finally {
      db.close();
    }
  });

  it.skipIf(!mysqlOk)('PUT saves policy and GET reports configured', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const saved = setExecReservePolicy(
        db,
        {
          operatingReserveNgn: 1_000_000,
          emergencyReserveNgn: 500_000,
          payrollReserveNgn: 300_000,
          supplierPaymentReserveNgn: 200_000,
          stockPurchaseReserveNgn: 150_000,
          taxStatutoryReserveNgn: 100_000,
          includeReceivables: false,
          includeInventory: false,
          includePoCommitments: true,
          policyNotes: 'Board approved Q2 assumptions.',
        },
        { id: 'u-md', displayName: 'MD User' }
      );
      expect(saved.ok).toBe(true);
      expect(saved.configured).toBe(true);
      expect(saved.completionPct).toBe(100);
      expect(saved.policy.includeReceivables.value).toBe(false);
      expect(saved.policy.includePoCommitments.value).toBe(true);

      const audit = db
        .prepare(`SELECT COUNT(*) AS c FROM org_policy_audit WHERE policy_key LIKE 'treasury.%'`)
        .get();
      expect(Number(audit?.c)).toBeGreaterThan(0);

      const dash = buildReservePolicyReadiness(db);
      expect(dash.configured).toBe(true);
      expect(dash.headroomHidden).toBe(true);
      expect(dash.note).toMatch(/next phase/i);
    } finally {
      db.close();
    }
  });

  it.skipIf(!mysqlOk)('PUT rejects invalid money values', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const bad = setExecReservePolicy(
        db,
        {
          operatingReserveNgn: -1,
          emergencyReserveNgn: 0,
          payrollReserveNgn: 0,
          supplierPaymentReserveNgn: 0,
          stockPurchaseReserveNgn: 0,
          taxStatutoryReserveNgn: 0,
          includeReceivables: false,
          includeInventory: false,
          includePoCommitments: true,
        },
        { id: 'u1' }
      );
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/operatingReserveNgn/i);
    } finally {
      db.close();
    }
  });

  it.skipIf(!mysqlOk)('PUT rejects invalid booleans', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const bad = setExecReservePolicy(
        db,
        {
          operatingReserveNgn: 0,
          emergencyReserveNgn: 0,
          payrollReserveNgn: 0,
          supplierPaymentReserveNgn: 0,
          stockPurchaseReserveNgn: 0,
          taxStatutoryReserveNgn: 0,
          includeReceivables: 'yes',
          includeInventory: false,
          includePoCommitments: true,
        },
        { id: 'u1' }
      );
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/includeReceivables/i);
    } finally {
      db.close();
    }
  });

  it.skipIf(!mysqlOk)('reads legacy withdrawal headroom keys', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      db.prepare(
        `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso) VALUES (?, ?, datetime('now'))`
      ).run('treasury.withdrawal.include_receivables', 'false');
      const res = getExecReservePolicyResponse(db);
      expect(res.policy.includeReceivables.configured).toBe(true);
      expect(res.policy.includeReceivables.value).toBe(false);
    } finally {
      db.close();
    }
  });
});
