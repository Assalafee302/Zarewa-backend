/**
 * The appraisal screen's Close button has always sent
 * PATCH /api/hr/appraisal-cycles/:cycleId; there was no handler behind it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { patchHrAppraisalCycle } from './hrOps.js';
import { resetSchemaCache } from './schemaCache.js';

function fakeDb({ cycle = { id: 'HRAPC-1', status: 'open' } } = {}) {
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      const record = (op, args) => {
        calls.push({ op, sql: norm, args });
        if (norm.startsWith('SELECT 1 FROM sqlite_master')) return { 1: 1 };
        if (norm.includes('FROM hr_appraisal_cycles WHERE id')) return cycle;
        return null;
      };
      return {
        all: (...a) => record('all', a) ?? [],
        get: (...a) => record('get', a),
        run: (...a) => {
          record('run', a);
          return { changes: 1 };
        },
      };
    },
  };
  return db;
}

const updates = (db) => db.calls.filter((c) => c.sql.startsWith('UPDATE hr_appraisal_cycles'));

describe('patchHrAppraisalCycle', () => {
  beforeEach(() => resetSchemaCache());

  it('closes an open cycle', () => {
    const db = fakeDb();
    expect(patchHrAppraisalCycle(db, { id: 'HR1' }, 'HRAPC-1', { status: 'closed' })).toEqual({
      ok: true,
      id: 'HRAPC-1',
      status: 'closed',
    });
    expect(updates(db)).toHaveLength(1);
    expect(updates(db)[0].sql).toContain('SET status = ?');
    expect(updates(db)[0].args).toEqual(['closed', 'HRAPC-1']);
  });

  it('reopens a closed cycle', () => {
    const db = fakeDb({ cycle: { id: 'HRAPC-1', status: 'closed' } });
    expect(patchHrAppraisalCycle(db, { id: 'HR1' }, 'HRAPC-1', { status: 'open' }).status).toBe('open');
  });

  it('updates label and due date together', () => {
    const db = fakeDb();
    const r = patchHrAppraisalCycle(db, { id: 'HR1' }, 'HRAPC-1', {
      label: 'Appraisal 2027',
      dueByIso: '2027-03-31',
    });
    expect(r.ok).toBe(true);
    expect(updates(db)[0].args).toEqual(['Appraisal 2027', '2027-03-31', 'HRAPC-1']);
  });

  it('clears the due date when sent empty', () => {
    const db = fakeDb();
    patchHrAppraisalCycle(db, { id: 'HR1' }, 'HRAPC-1', { dueByIso: '' });
    expect(updates(db)[0].args).toEqual([null, 'HRAPC-1']);
  });

  it('writes an audit event naming the transition', () => {
    const db = fakeDb();
    patchHrAppraisalCycle(db, { id: 'HR1' }, 'HRAPC-1', { status: 'closed' });
    const audit = db.calls.find((c) => c.sql.startsWith('INSERT INTO hr_audit_events'));
    expect(audit).toBeDefined();
    expect(audit.args).toContain('hr.appraisal.cycle_close');
    expect(audit.args.join('|')).toContain('"from":"open"');
    expect(audit.args.join('|')).toContain('"to":"closed"');
  });

  it.each([
    [{ status: 'archived' }, 'Status must be open or closed.'],
    [{ label: 'x' }, 'Label is required.'],
    [{ dueByIso: '31/03/2027' }, 'dueByIso must be YYYY-MM-DD.'],
    [{}, 'Nothing to update.'],
  ])('rejects %j', (body, error) => {
    const db = fakeDb();
    expect(patchHrAppraisalCycle(db, { id: 'HR1' }, 'HRAPC-1', body)).toEqual({ ok: false, error });
    expect(updates(db)).toHaveLength(0);
  });

  it('rejects a missing cycle id and an unknown cycle', () => {
    expect(patchHrAppraisalCycle(fakeDb(), {}, '', { status: 'closed' })).toEqual({
      ok: false,
      error: 'cycleId is required.',
    });
    expect(patchHrAppraisalCycle(fakeDb({ cycle: null }), {}, 'NOPE', { status: 'closed' })).toEqual({
      ok: false,
      error: 'Appraisal cycle not found.',
    });
  });
});
