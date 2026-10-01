import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { appendAuditLog, periodKeyFromDate, upsertTreasuryAccount } from '../controlOps.js';
import { insertTreasuryMovementTx } from './treasuryMovementWrite.js';
import {
  computeTreasuryBalanceIntegrity,
  previewTreasuryBalanceRebuild,
  setTreasuryAccountStrictCache,
} from './treasuryBalanceIntegrityOps.js';
import { runWithTreasuryContext } from './treasuryRequestContext.js';
import { treasuryMoneyRoute } from '../http/treasuryMoneyRoute.js';
import {
  deleteTreasuryTransfer,
  ledgerReceiptTreasuryMovementCorrectTx,
  transferTreasuryFunds,
} from '../writeOps.js';
import { lagosCalendarDay } from '../../shared/lib/isoTimestamp.js';

function dbAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const dbOk = dbAvailable();

const ADMIN = {
  id: 'usr-t21-admin',
  displayName: 'Phase 21 Admin',
  roleKey: 'admin',
  permissions: ['*'],
};

const CASHIER = {
  id: 'usr-t21-cashier',
  displayName: 'Phase 21 Cashier',
  roleKey: 'cashier',
  permissions: ['treasury.manage'],
};

function daysAgo(n) {
  return lagosCalendarDay(new Date(Date.now() - n * 86400000));
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env[name];
    else process.env[name] = prev;
  }
}

async function withEnvAsync(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env[name];
    else process.env[name] = prev;
  }
}

function captureError(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected an error');
}

describe('periodKeyFromDate (Phase 2.1)', () => {
  it('throws on TM-2780 instead of returning 262026-09', () => {
    expect(() => periodKeyFromDate('262026-09-T12:00:00.000Z')).toThrow(/Invalid date/);
  });
});

describe.skipIf(!dbOk)('treasury movement write (Phase 2.1)', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  let accountId;

  function addAccount(accNo, balance, opening) {
    db.prepare(
      `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id, opening_balance_ngn)
       VALUES (?, 'Test', ?, 'Bank', ?, ?, ?)`
    ).run(`T21 ${accNo}`, balance, accNo, DEFAULT_BRANCH_ID, opening);
    return Number(db.prepare(`SELECT id FROM treasury_accounts WHERE acc_no = ?`).get(accNo)?.id);
  }

  function storedBalance(id) {
    return Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(id).balance);
  }

  beforeAll(() => {
    process.env.ZAREWA_EMPTY_SEED = '1';
    db = createDatabase(':memory:');
    for (const u of [ADMIN, CASHIER]) {
      db.prepare(
        `INSERT INTO app_users (id, username, display_name, password_hash, role_key, status, created_at_iso)
         VALUES (?, ?, ?, 'x', ?, 'active', ?)`
      ).run(u.id, u.id, u.displayName, u.roleKey, new Date().toISOString());
    }
    accountId = addAccount('T21-DRIFT', 1000000, 0);
    expect(accountId).toBeGreaterThan(0);
  }, 120_000);

  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    delete process.env.ZAREWA_EMPTY_SEED;
  });

  it('rejects zero insert and the wrong sign', () => {
    expect(() =>
      insertTreasuryMovementTx(db, {
        type: 'RECEIPT_IN',
        treasuryAccountId: accountId,
        amountNgn: 0,
        postedAtISO: '2026-09-15',
      })
    ).toThrow(/non-zero/);
    expect(() =>
      insertTreasuryMovementTx(db, {
        type: 'RECEIPT_IN',
        treasuryAccountId: accountId,
        amountNgn: -500,
        postedAtISO: '2026-09-15',
      })
    ).toThrow(/positive/);
  });

  it('keeps stored_after = stored_before + delta while drifted, and records the user', () => {
    const before = storedBalance(accountId);
    const row = insertTreasuryMovementTx(db, {
      type: 'REFUND_PAYOUT',
      treasuryAccountId: accountId,
      amountNgn: -4000,
      postedAtISO: '2026-09-16',
      actor: ADMIN,
      createdBy: 'test',
      sourceKind: 'TEST',
      sourceId: 'T21-REF-1',
    });
    expect(row.storedAfter).toBe(row.storedBefore + row.amountNgn);
    expect(row.storedBefore).toBe(before);
    expect(storedBalance(accountId)).toBe(before - 4000);
    const saved = db
      .prepare(`SELECT created_by_user_id, created_at_iso FROM treasury_movements WHERE id = ?`)
      .get(row.id);
    expect(saved.created_by_user_id).toBe(ADMIN.id);
    expect(String(saved.created_at_iso)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const computed = previewTreasuryBalanceRebuild(db, DEFAULT_BRANCH_ID).accounts.find(
      (a) => a.treasuryAccountId === accountId
    );
    expect(computed.storedBalanceNgn).not.toBe(computed.computedBalanceNgn);
  });

  it('requires a floor reason for a ₦1 receipt when strict amounts are on', () => {
    withEnv('ZAREWA_TREASURY_STRICT_AMOUNTS', '1', () => {
      expect(() =>
        insertTreasuryMovementTx(db, {
          type: 'RECEIPT_IN',
          treasuryAccountId: accountId,
          amountNgn: 1,
          postedAtISO: '2026-09-17',
          actor: ADMIN,
        })
      ).toThrow(/confirmation reason/);
      const row = insertTreasuryMovementTx(db, {
        type: 'RECEIPT_IN',
        treasuryAccountId: accountId,
        amountNgn: 1,
        postedAtISO: '2026-09-17',
        actor: ADMIN,
        amountFloorReason: 'rounding residue',
      });
      expect(db.prepare(`SELECT amount_floor_reason FROM treasury_movements WHERE id = ?`).get(row.id).amount_floor_reason).toBe(
        'rounding residue'
      );
    });
  });

  it('transfers: 1-7 days back need a reason, older needs Admin/MD (strict dates on)', () => {
    withEnv('ZAREWA_TREASURY_STRICT_DATES', '1', () => {
      const base = {
        type: 'INTERNAL_TRANSFER_OUT',
        treasuryAccountId: accountId,
        amountNgn: -100,
        counterpartyId: '999',
      };
      const noReason = captureError(() =>
        insertTreasuryMovementTx(db, { ...base, postedAtISO: daysAgo(3), actor: CASHIER })
      );
      expect(noReason.code).toBe('DATE_REASON_REQUIRED');
      const ok = insertTreasuryMovementTx(db, {
        ...base,
        postedAtISO: daysAgo(3),
        actor: CASHIER,
        dateOverrideReason: 'bank advice arrived late',
      });
      expect(db.prepare(`SELECT date_override_reason FROM treasury_movements WHERE id = ?`).get(ok.id).date_override_reason).toBe(
        'bank advice arrived late'
      );
      const old = captureError(() =>
        insertTreasuryMovementTx(db, {
          ...base,
          postedAtISO: daysAgo(10),
          actor: CASHIER,
          dateOverrideReason: 'cashier reason',
        })
      );
      expect(old.code).toBe('DATE_ADMIN_REQUIRED');
      insertTreasuryMovementTx(db, {
        ...base,
        postedAtISO: daysAgo(10),
        actor: ADMIN,
        dateOverrideReason: 'statement backfill',
      });
      const future = captureError(() =>
        insertTreasuryMovementTx(db, { ...base, postedAtISO: lagosCalendarDay(new Date(Date.now() + 2 * 86400000)), actor: CASHIER })
      );
      expect(future.code).toBe('FUTURE_DATE');
    });
  });

  it('documents: posting more than 7 days from the source document date needs a reason', () => {
    withEnv('ZAREWA_TREASURY_STRICT_DATES', '1', () => {
      const e = captureError(() =>
        insertTreasuryMovementTx(db, {
          type: 'RECEIPT_IN',
          treasuryAccountId: accountId,
          amountNgn: 5000,
          postedAtISO: daysAgo(20),
          sourceDocDate: daysAgo(2),
          sourceKind: 'LEDGER_RECEIPT',
          sourceId: 'LE-T21-DOC',
          actor: CASHIER,
        })
      );
      expect(e.code).toBe('DATE_REASON_REQUIRED');
      const row = insertTreasuryMovementTx(db, {
        type: 'RECEIPT_IN',
        treasuryAccountId: accountId,
        amountNgn: 5000,
        postedAtISO: daysAgo(4),
        sourceDocDate: daysAgo(2),
        sourceKind: 'LEDGER_RECEIPT',
        sourceId: 'LE-T21-DOC',
        actor: CASHIER,
      });
      expect(db.prepare(`SELECT source_doc_date FROM treasury_movements WHERE id = ?`).get(row.id).source_doc_date).toBe(
        daysAgo(2)
      );
    });
  });

  it('blocks a repeat inside 120 s unless a reason is given; same-day repeat needs a confirmation', () => {
    withEnv('ZAREWA_TREASURY_STRICT_DUPLICATES', '1', () => {
      const line = {
        type: 'REFUND_PAYOUT',
        treasuryAccountId: accountId,
        amountNgn: -700,
        postedAtISO: '2026-09-20',
        sourceKind: 'REFUND',
        sourceId: 'RF-T21-DUP',
        actor: ADMIN,
      };
      runWithTreasuryContext({ actor: ADMIN }, () => {
        insertTreasuryMovementTx(db, line);
        // Same request (split lines): not a duplicate of itself.
        insertTreasuryMovementTx(db, line);
      });
      const blocked = runWithTreasuryContext({ actor: ADMIN }, () => {
        const e = captureError(() => insertTreasuryMovementTx(db, line));
        return e;
      });
      expect(blocked.code).toBe('DUPLICATE_BLOCK');
      const forced = runWithTreasuryContext(
        { actor: ADMIN, confirmations: { duplicateOverrideReason: 'second instalment, same day' } },
        () => insertTreasuryMovementTx(db, line)
      );
      expect(
        db.prepare(`SELECT duplicate_override_reason FROM treasury_movements WHERE id = ?`).get(forced.id)
          .duplicate_override_reason
      ).toBe('second instalment, same day');

      db.prepare(
        `UPDATE treasury_movements SET created_at_iso = ? WHERE source_id = 'RF-T21-DUP'`
      ).run(new Date(Date.now() - 3600_000).toISOString());
      const sameDay = runWithTreasuryContext({ actor: ADMIN }, () =>
        captureError(() => insertTreasuryMovementTx(db, line))
      );
      expect(sameDay.code).toBe('DUPLICATE_SAME_DAY');
      runWithTreasuryContext({ actor: ADMIN, confirmations: { duplicateSameDayConfirmed: true } }, () =>
        insertTreasuryMovementTx(db, line)
      );
      // Outside a request context (system jobs) the check does not run.
      insertTreasuryMovementTx(db, line);
    });
  });

  it('ignores typed balance on upsert and locks opening to Admin with a reason', () => {
    const storedBefore = storedBalance(accountId);
    const cashier = upsertTreasuryAccount(
      db,
      { id: accountId, name: 'KD Drift Bank', type: 'Bank', accNo: 'T21-DRIFT', balance: 999, openingBalanceNgn: 50 },
      CASHIER
    );
    expect(cashier.ok).toBe(false);
    expect(String(cashier.error || '')).toMatch(/opening balance/i);
    expect(storedBalance(accountId)).toBe(storedBefore);

    const metaOnly = upsertTreasuryAccount(
      db,
      { id: accountId, name: 'KD Drift Bank renamed', type: 'Bank', accNo: 'T21-DRIFT', balance: 999 },
      CASHIER
    );
    expect(metaOnly.ok).toBe(true);
    expect(storedBalance(accountId)).toBe(storedBefore);

    const adminNoReason = upsertTreasuryAccount(
      db,
      { id: accountId, name: 'KD Drift Bank', type: 'Bank', accNo: 'T21-DRIFT', openingBalanceNgn: 50 },
      ADMIN
    );
    expect(adminNoReason.ok).toBe(false);

    const adminOk = upsertTreasuryAccount(
      db,
      {
        id: accountId,
        name: 'KD Drift Bank',
        type: 'Bank',
        accNo: 'T21-DRIFT',
        balance: 999,
        openingBalanceNgn: 50,
        openingChangeReason: 'Phase 2.1 lock test',
      },
      ADMIN
    );
    expect(adminOk.ok).toBe(true);
    const after = db.prepare(`SELECT balance, opening_balance_ngn FROM treasury_accounts WHERE id = ?`).get(accountId);
    expect(Number(after.balance)).toBe(storedBefore);
    expect(Number(after.opening_balance_ngn)).toBe(50);
    const audit = db
      .prepare(
        `SELECT details_json FROM audit_log WHERE action = 'treasury_account.opening_change' AND entity_id = ?`
      )
      .get(String(accountId));
    expect(JSON.parse(audit.details_json)).toEqual({ oldOpening: 0, newOpening: 50, reason: 'Phase 2.1 lock test' });

    const created = upsertTreasuryAccount(
      db,
      { name: 'T21 New Till', type: 'Cash', accNo: 'T21-NEW', balance: 999, openingBalanceNgn: 250 },
      CASHIER
    );
    expect(created.ok).toBe(true);
    const neu = db.prepare(`SELECT balance, opening_balance_ngn FROM treasury_accounts WHERE id = ?`).get(created.id);
    expect(Number(neu.opening_balance_ngn)).toBe(250);
    expect(Number(neu.balance)).toBe(250);
  });

  it('receipt and payout line corrections need a reason and audit old → new', () => {
    const mv = insertTreasuryMovementTx(db, {
      type: 'RECEIPT_IN',
      treasuryAccountId: accountId,
      amountNgn: 20000,
      postedAtISO: '2026-08-07',
      sourceKind: 'LEDGER_RECEIPT',
      sourceId: 'LE-T21-CORR',
      actor: ADMIN,
    });
    let r = null;
    db.transaction(() => {
      r = ledgerReceiptTreasuryMovementCorrectTx(db, mv.id, { postedAtISO: '2026-04-05' }, ADMIN, {});
    })();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CORRECTION_REASON_REQUIRED');
    expect(r.old.postedAtISO).toBe('2026-08-07T12:00:00.000Z');
    expect(r.new.postedAtISO).toBe('2026-04-05T12:00:00.000Z');
    expect(db.prepare(`SELECT posted_at_iso FROM treasury_movements WHERE id = ?`).get(mv.id).posted_at_iso).toBe(
      '2026-08-07T12:00:00.000Z'
    );

    db.transaction(() => {
      r = ledgerReceiptTreasuryMovementCorrectTx(
        db,
        mv.id,
        { postedAtISO: '2026-08-05', correctionReason: 'Bank statement shows 05/08' },
        ADMIN,
        {}
      );
    })();
    expect(r.ok).toBe(true);
    const audit = db
      .prepare(
        `SELECT details_json FROM audit_log WHERE action = 'treasury.ledger_receipt_correct' AND entity_id = ? ORDER BY occurred_at_iso DESC`
      )
      .get(mv.id);
    const d = JSON.parse(audit.details_json);
    expect(d.correctionReason).toBe('Bank statement shows 05/08');
    expect(d.oldPostedAtISO).toBe('2026-08-07T12:00:00.000Z');
    expect(d.newPostedAtISO).toBe('2026-08-05T12:00:00.000Z');
  });

  it('strict cache: Admin/MD only, only at ₦0 difference, then every write checks cache = computed', () => {
    const cleanId = addAccount('T21-CLEAN', 10000, 10000);
    expect(setTreasuryAccountStrictCache(db, cleanId, { enabled: true, reason: 'x' }, CASHIER).ok).toBe(false);
    expect(setTreasuryAccountStrictCache(db, cleanId, { enabled: true }, ADMIN).ok).toBe(false);
    const drifted = setTreasuryAccountStrictCache(db, accountId, { enabled: true, reason: 'try' }, ADMIN);
    expect(drifted.ok).toBe(false);
    expect(drifted.error).toMatch(/differs/);

    const on = setTreasuryAccountStrictCache(db, cleanId, { enabled: true, reason: 'difference is zero' }, ADMIN);
    expect(on.ok).toBe(true);
    insertTreasuryMovementTx(db, {
      type: 'RECEIPT_IN',
      treasuryAccountId: cleanId,
      amountNgn: 500,
      postedAtISO: '2026-09-21',
      actor: ADMIN,
    });
    db.prepare(`UPDATE treasury_accounts SET balance = balance + 7 WHERE id = ?`).run(cleanId);
    const e = captureError(() =>
      insertTreasuryMovementTx(db, {
        type: 'RECEIPT_IN',
        treasuryAccountId: cleanId,
        amountNgn: 500,
        postedAtISO: '2026-09-21',
        actor: ADMIN,
      })
    );
    expect(e.code).toBe('STRICT_CACHE_MISMATCH');

    const report = computeTreasuryBalanceIntegrity(db, DEFAULT_BRANCH_ID);
    const row = report.accounts.find((a) => a.treasuryAccountId === cleanId);
    expect(row.strictCacheEnabled).toBe(true);
    expect(row.strictCacheReason).toBe('difference is zero');
    expect(row.strictCacheChangedBy).toBe(ADMIN.displayName);
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'treasury_account.strict_cache_on' AND entity_id = ?`).get(
        String(cleanId)
      ).c
    ).toBe(1);
  });

  it('integrity report dates the last non-movement balance change and counts negative days', () => {
    const id = addAccount('T21-NEG', 0, 0);
    for (const [day, amt] of [
      ['2026-09-01', 100],
      ['2026-09-02', -300],
      ['2026-09-03', 500],
    ]) {
      insertTreasuryMovementTx(db, {
        type: amt > 0 ? 'RECEIPT_IN' : 'REFUND_PAYOUT',
        treasuryAccountId: id,
        amountNgn: amt,
        postedAtISO: day,
        allowNegativeBalance: true,
        actor: ADMIN,
      });
    }
    appendAuditLog(db, {
      actor: ADMIN,
      action: 'treasury_account.update',
      entityKind: 'treasury_account',
      entityId: String(id),
      note: 'legacy save',
      details: { balance: 12345, openingBalanceNgn: 0 },
    });
    upsertTreasuryAccount(db, { id, name: 'T21 T21-NEG', type: 'Bank', accNo: 'T21-NEG' }, ADMIN);
    const row = computeTreasuryBalanceIntegrity(db, DEFAULT_BRANCH_ID).accounts.find((a) => a.treasuryAccountId === id);
    expect(row.lastNonMovementChangeKind).toBe('Typed balance on account save');
    expect(row.lastNonMovementChangeAtISO).toMatch(/^\d{4}-/);
    expect(row.negativeDayCount).toBe(1);
    expect(row.firstNegativeDay).toBe('2026-09-02');
    expect(row.lowestBalanceNgn).toBe(-200);
    expect(row.lowestBalanceDay).toBe('2026-09-02');
  });

  it('reverses a transfer instead of deleting the original legs', () => {
    const fromId = addAccount('T21-FROM', 80000, 80000);
    const toId = addAccount('T21-TO', 10000, 10000);
    const posted = transferTreasuryFunds(db, {
      fromId,
      toId,
      amountNgn: 5000,
      dateISO: '2026-09-18',
      actor: ADMIN,
      createdBy: 'test',
    });
    expect(posted.ok, JSON.stringify(posted)).toBe(true);
    expect(
      Number(db.prepare(`SELECT COUNT(*) AS c FROM treasury_movements WHERE source_id = ?`).get(posted.batchId)?.c)
    ).toBe(2);
    const deleted = deleteTreasuryTransfer(db, posted.batchId, ADMIN, { note: 'test reverse' });
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    const rows = db
      .prepare(`SELECT type, reverses_movement_id FROM treasury_movements WHERE source_id = ? ORDER BY id`)
      .all(posted.batchId);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.reverses_movement_id).length).toBe(2);
    expect(storedBalance(fromId)).toBe(80000);
    expect(storedBalance(toId)).toBe(10000);
  });

  it('dry-run rebuild prints deltas and writes zero rows', () => {
    const before = db.prepare(`SELECT id, balance FROM treasury_accounts`).all();
    const preview = previewTreasuryBalanceRebuild(db, DEFAULT_BRANCH_ID);
    expect(preview.wroteRows).toBe(0);
    expect(preview.accounts.length).toBeGreaterThan(0);
    const after = db.prepare(`SELECT id, balance FROM treasury_accounts`).all();
    expect(after.map((r) => `${r.id}:${r.balance}`).sort()).toEqual(before.map((r) => `${r.id}:${r.balance}`).sort());
  });

  describe('money-route middleware', () => {
    function makeApp() {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.user = ADMIN;
        next();
      });
      app.post('/pay', treasuryMoneyRoute(db, 'test.pay'), (req, res) => {
        try {
          const row = db.transaction(() =>
            insertTreasuryMovementTx(db, {
              type: 'PAYMENT_REQUEST_OUT',
              treasuryAccountId: accountId,
              amountNgn: -Number(req.body.amountNgn),
              postedAtISO: '2026-09-22',
              sourceKind: 'PAYMENT_REQUEST',
              sourceId: String(req.body.sourceId),
              allowNegativeBalance: true,
            })
          )();
          res.status(201).json({ ok: true, id: row.id });
        } catch (e) {
          res.status(400).json({ ok: false, error: String(e.message || e) });
        }
      });
      return app;
    }

    it('replays a completed request for the same key instead of paying twice', async () => {
      const app = makeApp();
      const body = { amountNgn: 900, sourceId: 'PR-T21-IDEM' };
      const first = await request(app).post('/pay').set('Idempotency-Key', 'k-1').send(body);
      expect(first.status).toBe(201);
      const second = await request(app).post('/pay').set('Idempotency-Key', 'k-1').send(body);
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(second.body.id).toBe(first.body.id);
      expect(
        db.prepare(`SELECT COUNT(*) AS c FROM treasury_movements WHERE source_id = 'PR-T21-IDEM'`).get().c
      ).toBe(1);
      expect(
        db.prepare(`SELECT idempotency_key, created_by_user_id FROM treasury_movements WHERE id = ?`).get(first.body.id)
      ).toEqual({ idempotency_key: 'k-1', created_by_user_id: ADMIN.id });
    });

    it('tells the screen what to confirm when a posting is refused, and frees the key', async () => {
      await withEnvAsync('ZAREWA_TREASURY_STRICT_DUPLICATES', '1', async () => {
        const app = makeApp();
        const body = { amountNgn: 400, sourceId: 'PR-T21-CONFIRM' };
        expect((await request(app).post('/pay').set('Idempotency-Key', 'c-1').send(body)).status).toBe(201);
        const refused = await request(app).post('/pay').set('Idempotency-Key', 'c-2').send(body);
        expect(refused.status).toBe(400);
        expect(refused.body.code, JSON.stringify(refused.body)).toBe('DUPLICATE_BLOCK');
        expect(refused.body.confirmRequired.code).toBe('DUPLICATE_BLOCK');
        const confirmed = await request(app)
          .post('/pay')
          .set('Idempotency-Key', 'c-2')
          .send({ ...body, treasuryConfirm: { duplicateOverrideReason: 'two invoices, same amount' } });
        expect(confirmed.status).toBe(201);
      });
    });
  });
});
