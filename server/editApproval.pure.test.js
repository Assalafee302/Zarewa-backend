import { describe, it, expect, vi } from 'vitest';
import {
  stripEditApprovalFromBody,
  handlePatchWithEditApproval,
  handlePatchWithEditApprovalQuotation,
  consumeEditApprovalInTransaction,
  createEditApprovalRequest,
} from './editApproval.js';

function mockRes() {
  /** @type {number} */
  let statusCode = 200;
  /** @type {unknown} */
  let payload;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get payload() {
      return payload;
    },
  };
}

/** Minimal db shim: flat transaction, consume UPDATE returns configurable changes. */
function createMockDb({ consumeChanges = 1 } = {}) {
  return {
    exec: vi.fn(),
    transaction(fn) {
      return () => fn();
    },
    prepare(sql) {
      const s = String(sql);
      return {
        run: vi.fn(() => {
          if (/edit_approval_tokens/i.test(s) && /UPDATE/i.test(s)) {
            return { changes: consumeChanges };
          }
          return { changes: 0 };
        }),
        get: vi.fn(),
        all: vi.fn(() => []),
      };
    },
  };
}

describe('editApproval (no MySQL)', () => {
  it('stripEditApprovalFromBody removes editApprovalId', () => {
    expect(stripEditApprovalFromBody({ a: 1, editApprovalId: '123456' })).toEqual({ a: 1 });
    expect(stripEditApprovalFromBody(null)).toBe(null);
  });

  it('handlePatchWithEditApproval: exempt user skips token', () => {
    const res = mockRes();
    const db = createMockDb();
    const admin = { roleKey: 'admin' };
    const body = { status: 'X', editApprovalId: '999999' };
    const executeWrite = vi.fn(() => ({ ok: true }));
    handlePatchWithEditApproval(res, db, admin, body, 'purchase_order', 'PO-1', executeWrite);
    expect(executeWrite).toHaveBeenCalledWith({ status: 'X' }, { withinEditApprovalTransaction: false });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true });
  });

  it('handlePatchWithEditApproval: gated user without token gets 403', () => {
    const res = mockRes();
    const db = createMockDb();
    const finance = { roleKey: 'finance_manager' };
    handlePatchWithEditApproval(res, db, finance, { status: 'Approved' }, 'purchase_order', 'PO-1', () => ({
      ok: true,
    }));
    expect(res.statusCode).toBe(403);
    expect(res.payload?.code).toBe('EDIT_APPROVAL_REQUIRED');
  });

  it('handlePatchWithEditApproval: gated user with token runs write and returns 200', () => {
    const res = mockRes();
    const db = createMockDb({ consumeChanges: 1 });
    const finance = { roleKey: 'finance_manager' };
    const executeWrite = vi.fn(() => ({ ok: true }));
    handlePatchWithEditApproval(
      res,
      db,
      finance,
      { status: 'Approved', editApprovalId: '123456' },
      'purchase_order',
      'PO-1',
      executeWrite
    );
    expect(executeWrite).toHaveBeenCalledWith({ status: 'Approved' }, { withinEditApprovalTransaction: true });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true });
  });

  it('handlePatchWithEditApproval: consume failure returns 400', () => {
    const res = mockRes();
    const db = createMockDb({ consumeChanges: 0 });
    const finance = { roleKey: 'finance_manager' };
    handlePatchWithEditApproval(
      res,
      db,
      finance,
      { status: 'Approved', editApprovalId: '123456' },
      'purchase_order',
      'PO-1',
      () => ({ ok: true })
    );
    expect(res.statusCode).toBe(400);
    expect(String(res.payload?.error || '')).toMatch(/Invalid|expired|already used|mismatched/i);
  });

  it('handlePatchWithEditApprovalQuotation: gated user with token returns quotation envelope', () => {
    const res = mockRes();
    const db = createMockDb({ consumeChanges: 1 });
    const finance = { roleKey: 'finance_manager' };
    const quotation = { id: 'Q-1', status: 'Pending' };
    handlePatchWithEditApprovalQuotation(res, db, finance, { lines: {}, editApprovalId: '123456' }, 'Q-1', () => quotation);
    expect(res.payload).toEqual({ ok: true, quotation, autoOverpayAppliedNgn: 0 });
  });

  it('consumeEditApprovalInTransaction throws when UPDATE affects 0 rows', () => {
    const db = createMockDb({ consumeChanges: 0 });
    expect(() =>
      consumeEditApprovalInTransaction(db, '123456', 'purchase_order', 'PO-1')
    ).toThrow(/Invalid|expired|already used|mismatched/i);
  });

  it('createEditApprovalRequest returns EDIT_APPROVAL_ALREADY_PENDING when a pending row exists', () => {
    const pendingId = '654321';
    const db = {
      exec: vi.fn(),
      prepare(sql) {
        const s = String(sql);
        if (s.includes('SELECT id FROM edit_approval_tokens') && s.includes('pending')) {
          return { get: vi.fn(() => ({ id: pendingId })) };
        }
        return { get: vi.fn(), run: vi.fn(() => { throw new Error('unexpected SQL'); }) };
      },
    };
    const r = createEditApprovalRequest(db, {
      entityKind: 'purchase_order',
      entityId: 'PO-1',
      branchId: 'main',
      actor: { id: 'u1', displayName: 'Alice' },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('EDIT_APPROVAL_ALREADY_PENDING');
    expect(r.existingApprovalId).toBe(pendingId);
  });
});
