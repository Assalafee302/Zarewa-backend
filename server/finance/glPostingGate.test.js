import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  glPostingDisabledPayload,
  isGlPostingEnabled,
  refuseIfGlPostingDisabled,
  requireLocalGlPosting,
  skippedGlPostingResult,
} from './glPostingGate.js';
import { createDatabase } from '../db.js';
import { postBalancedJournalTx, tryPostCustomerReceiptGl } from '../glOps.js';

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
const FLAG = 'ZAREWA_GL_POSTING_ENABLED';

describe('glPostingGate', () => {
  let prev;

  beforeEach(() => {
    prev = process.env[FLAG];
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  it('defaults on so live journals keep posting', () => {
    expect(isGlPostingEnabled()).toBe(true);
  });

  it('turns off for 0 / false / off', () => {
    process.env[FLAG] = '0';
    expect(isGlPostingEnabled()).toBe(false);
    process.env[FLAG] = 'false';
    expect(isGlPostingEnabled()).toBe(false);
    process.env[FLAG] = 'off';
    expect(isGlPostingEnabled()).toBe(false);
  });

  it('skip result is ok so money paths do not throw', () => {
    const r = skippedGlPostingResult();
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('GL_POSTING_DISABLED');
    expect(r.ok === false).toBe(false);
    expect(!r.ok && !r.skipped).toBe(false);
  });

  it('refuseIfGlPostingDisabled is a no-op when posting is on', () => {
    const res = { status: () => ({ json: () => {} }) };
    expect(refuseIfGlPostingDisabled(res)).toBe(false);
  });

  it('refuseIfGlPostingDisabled returns 409 when posting is off', () => {
    process.env[FLAG] = '0';
    /** @type {{ code?: number, body?: unknown }} */
    const captured = {};
    const res = {
      status(code) {
        captured.code = code;
        return {
          json(body) {
            captured.body = body;
          },
        };
      },
    };
    expect(refuseIfGlPostingDisabled(res)).toBe(true);
    expect(captured.code).toBe(409);
    expect(captured.body).toEqual(glPostingDisabledPayload());
  });

  it('requireLocalGlPosting calls next when posting is on', () => {
    let nextCalls = 0;
    requireLocalGlPosting({}, {}, () => {
      nextCalls += 1;
    });
    expect(nextCalls).toBe(1);
  });
});

describe.skipIf(!mysqlOk)('glPostingGate journal choke point', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  let prev;

  beforeEach(() => {
    prev = process.env[FLAG];
    delete process.env[FLAG];
    db = createDatabase(':memory:', { seed: false });
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  it('postBalancedJournalTx writes nothing when disabled', () => {
    process.env[FLAG] = '0';
    const r = postBalancedJournalTx(db, {
      entryDateISO: '2026-07-01',
      memo: 'should not post',
      sourceKind: 'TEST_GL',
      sourceId: 'skip-1',
      lines: [
        { accountCode: '1000', debitNgn: 100 },
        { accountCode: '1200', creditNgn: 100 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM gl_journal_entries`).get()?.n ?? 0;
    expect(Number(n)).toBe(0);
  });

  it('tryPostCustomerReceiptGl does not fail the receipt when GL is off', () => {
    process.env[FLAG] = '0';
    const gl = tryPostCustomerReceiptGl(db, {
      ledgerEntryId: 'LE-SKIP',
      amountNgn: 50_000,
      entryDateISO: '2026-07-01',
    });
    expect(gl.ok).toBe(true);
    expect(gl.skipped).toBe(true);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM gl_journal_entries`).get()?.n ?? 0;
    expect(Number(n)).toBe(0);
  });
});
