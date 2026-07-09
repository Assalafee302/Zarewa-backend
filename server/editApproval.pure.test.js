import { describe, it, expect, vi } from 'vitest';
import {
  stripEditApprovalFromBody,
  handlePatchWithEditApproval,
  handlePatchWithEditApprovalQuotation,
  consumeEditApprovalInTransaction,
  createEditApprovalRequest,
  buildEditApprovalRecordContext,
  getEditApprovalDetail,
  receiptFinanceSettlementRequiresEditApproval,
  expenseOutflowCorrectionRequiresEditApproval,
  salesReceiptReconciliationIsFinalized,
  cuttingListEditRequiresEditApproval,
  cuttingListIsPushedToProduction,
  quotationEditRequiresEditApproval,
  quotationHasActiveSalesReceipts,
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

  it('handlePatchWithEditApprovalQuotation: gated user without receipts skips token', () => {
    const res = mockRes();
    const db = {
      exec: vi.fn(),
      transaction(fn) {
        return () => fn();
      },
      prepare(sql) {
        const s = String(sql);
        if (s.includes('FROM sales_receipts') && s.includes('quotation_ref')) {
          return { get: vi.fn(() => ({ c: 0 })) };
        }
        return { get: vi.fn(), run: vi.fn(() => ({ changes: 0 })), all: vi.fn(() => []) };
      },
    };
    const sales = { roleKey: 'sales_staff' };
    const quotation = { id: 'Q-1', status: 'Pending' };
    const executeWrite = vi.fn(() => quotation);
    handlePatchWithEditApprovalQuotation(res, db, sales, { lines: {} }, 'Q-1', executeWrite);
    expect(executeWrite).toHaveBeenCalled();
    expect(res.payload).toEqual({ ok: true, quotation, autoOverpayAppliedNgn: 0 });
  });

  it('handlePatchWithEditApprovalQuotation: gated user with receipts requires token', () => {
    const res = mockRes();
    const db = {
      exec: vi.fn(),
      transaction(fn) {
        return () => fn();
      },
      prepare(sql) {
        const s = String(sql);
        if (s.includes('FROM sales_receipts') && s.includes('quotation_ref')) {
          return { get: vi.fn(() => ({ c: 1 })) };
        }
        return { get: vi.fn(), run: vi.fn(() => ({ changes: 0 })), all: vi.fn(() => []) };
      },
    };
    const sales = { roleKey: 'sales_staff' };
    handlePatchWithEditApprovalQuotation(res, db, sales, { lines: {} }, 'Q-1', () => ({ id: 'Q-1' }));
    expect(res.statusCode).toBe(403);
    expect(res.payload?.code).toBe('EDIT_APPROVAL_REQUIRED');
    expect(String(res.payload?.error || '')).toMatch(/receipts on file/i);
  });

  it('quotationEditRequiresEditApproval: no receipts means open edit for sales staff', () => {
    const db = {
      prepare(sql) {
        const s = String(sql);
        if (s.includes('FROM sales_receipts') && s.includes('quotation_ref')) {
          return { get: vi.fn(() => ({ c: 0 })) };
        }
        return { get: vi.fn() };
      },
    };
    expect(quotationHasActiveSalesReceipts(db, 'Q-1')).toBe(false);
    expect(quotationEditRequiresEditApproval(db, { roleKey: 'sales_staff' }, 'Q-1')).toBe(false);
    expect(quotationEditRequiresEditApproval(db, { roleKey: 'admin' }, 'Q-1')).toBe(false);
  });

  it('cuttingListEditRequiresEditApproval: waiting list is open; pushed list needs token', () => {
    const db = {
      prepare(sql) {
        const s = String(sql);
        if (s.includes('production_registered FROM cutting_lists')) {
          return {
            get: vi.fn((id) =>
              id === 'CL-PUSHED' ? { production_registered: 1 } : { production_registered: 0 }
            ),
          };
        }
        return { get: vi.fn() };
      },
    };
    expect(cuttingListIsPushedToProduction(db, 'CL-WAIT')).toBe(false);
    expect(cuttingListIsPushedToProduction(db, 'CL-PUSHED')).toBe(true);
    expect(cuttingListEditRequiresEditApproval(db, { roleKey: 'sales_staff' }, 'CL-WAIT')).toBe(false);
    expect(cuttingListEditRequiresEditApproval(db, { roleKey: 'sales_staff' }, 'CL-PUSHED')).toBe(true);
    expect(cuttingListEditRequiresEditApproval(db, { roleKey: 'admin' }, 'CL-PUSHED')).toBe(false);
  });

  it('consumeEditApprovalInTransaction throws when UPDATE affects 0 rows', () => {
    const db = createMockDb({ consumeChanges: 0 });
    expect(() =>
      consumeEditApprovalInTransaction(db, '123456', 'purchase_order', 'PO-1')
    ).toThrow(/Invalid|expired|already used|mismatched/i);
  });

  it('receipt finance settlement: first and revised reconcile skip token', () => {
    const db = {
      prepare(sql) {
        const s = String(sql);
        if (s.includes('finance_reconciliation_saved_at_iso FROM sales_receipts')) {
          return {
            get: vi.fn((id) =>
              id === 'RC-FINAL' ? { finance_reconciliation_saved_at_iso: '2026-05-01' } : { finance_reconciliation_saved_at_iso: null }
            ),
          };
        }
        return { get: vi.fn(), run: vi.fn(), all: vi.fn(() => []) };
      },
    };
    const finance = { roleKey: 'finance_officer', permissions: ['finance.post'] };
    expect(salesReceiptReconciliationIsFinalized(db, 'RC-FINAL')).toBe(true);
    expect(salesReceiptReconciliationIsFinalized(db, 'RC-NEW')).toBe(false);
    expect(receiptFinanceSettlementRequiresEditApproval(db, finance, 'RC-NEW')).toBe(false);
    expect(receiptFinanceSettlementRequiresEditApproval(db, finance, 'RC-FINAL')).toBe(false);
    expect(receiptFinanceSettlementRequiresEditApproval(db, { roleKey: 'admin' }, 'RC-FINAL')).toBe(false);
  });

  it('handlePatchWithEditApproval: finance first receipt reconcile skips token', () => {
    const res = mockRes();
    const db = {
      exec: vi.fn(),
      transaction(fn) {
        return () => fn();
      },
      prepare(sql) {
        const s = String(sql);
        if (s.includes('finance_reconciliation_saved_at_iso FROM sales_receipts')) {
          return { get: vi.fn(() => ({ finance_reconciliation_saved_at_iso: null })) };
        }
        return { get: vi.fn(), run: vi.fn(() => ({ changes: 0 })), all: vi.fn(() => []) };
      },
    };
    const finance = { roleKey: 'finance_officer' };
    const executeWrite = vi.fn(() => ({ ok: true }));
    handlePatchWithEditApproval(
      res,
      db,
      finance,
      { bankReceivedAmountNgn: 1000 },
      'sales_receipt',
      'RC-NEW',
      executeWrite,
      {
        requiresEditApproval: (database, user, receiptId) =>
          receiptFinanceSettlementRequiresEditApproval(database, user, receiptId),
      }
    );
    expect(executeWrite).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('handlePatchWithEditApproval: finance revised receipt reconcile skips token', () => {
    const res = mockRes();
    const db = {
      exec: vi.fn(),
      transaction(fn) {
        return () => fn();
      },
      prepare(sql) {
        const s = String(sql);
        if (s.includes('finance_reconciliation_saved_at_iso FROM sales_receipts')) {
          return { get: vi.fn(() => ({ finance_reconciliation_saved_at_iso: '2026-05-01' })) };
        }
        return { get: vi.fn(), run: vi.fn(() => ({ changes: 0 })), all: vi.fn(() => []) };
      },
    };
    const finance = { roleKey: 'finance_officer' };
    const executeWrite = vi.fn(() => ({ ok: true }));
    handlePatchWithEditApproval(
      res,
      db,
      finance,
      { bankReceivedAmountNgn: 1000 },
      'sales_receipt',
      'RC-FINAL',
      executeWrite,
      {
        requiresEditApproval: (database, user, receiptId) =>
          receiptFinanceSettlementRequiresEditApproval(database, user, receiptId),
      }
    );
    expect(executeWrite).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('expense outflow correction skips edit-approval token', () => {
    const finance = { roleKey: 'finance_officer', permissions: ['finance.post'] };
    expect(expenseOutflowCorrectionRequiresEditApproval({}, finance, 'TM-EXP-1')).toBe(false);
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

  it('buildEditApprovalRecordContext returns quotation snapshot fields', () => {
    const db = {
      prepare(sql) {
        const s = String(sql);
        if (s.includes('FROM quotations WHERE')) {
          return {
            get: () => ({
              id: 'Q-100',
              customer_name: 'Acme Ltd',
              status: 'Cleared',
              total_ngn: 500000,
              paid_ngn: 250000,
              project_name: 'Roof A',
              date_iso: '2026-07-01',
            }),
          };
        }
        return { get: () => null };
      },
    };
    const ctx = buildEditApprovalRecordContext(db, 'quotation', 'Q-100');
    expect(ctx.entityLabel).toBe('Quotation');
    expect(ctx.headline).toContain('Acme Ltd');
    expect(ctx.fields.some((f) => f.label === 'Total' && f.value.includes('500'))).toBe(true);
  });

  it('getEditApprovalDetail merges approval row with record context', () => {
    const row = {
      id: '123456',
      entity_kind: 'quotation',
      entity_id: 'Q-1',
      branch_id: 'BR-KD',
      requested_by_user_id: 'u1',
      requested_by_display: 'Alice',
      requested_at_iso: '2026-07-01T10:00:00.000Z',
      approved_by_user_id: '',
      approved_by_display: '',
      approved_at_iso: '',
      used_at_iso: '',
      expires_at_iso: '',
      status: 'pending',
      change_summary: 'Update customer phone',
      change_details_json: JSON.stringify([{ label: 'Phone', from: '0801', to: '0802' }]),
    };
    const db = {
      exec: vi.fn(),
      prepare(sql) {
        const s = String(sql);
        if (s.includes('PRAGMA table_info')) {
          return {
            all: () => [
              { name: 'id' },
              { name: 'change_summary' },
              { name: 'change_details_json' },
            ],
          };
        }
        if (s.includes('edit_approval_tokens WHERE id')) {
          return { get: () => row };
        }
        if (s.includes('FROM quotations WHERE')) {
          return {
            get: () => ({
              id: 'Q-1',
              customer_name: 'Bob',
              status: 'Draft',
              total_ngn: 0,
              paid_ngn: 0,
              project_name: '',
              date_iso: '2026-07-01',
            }),
          };
        }
        return { get: () => null };
      },
    };
    const detail = getEditApprovalDetail(db, '123456');
    expect(detail?.changeSummary).toBe('Update customer phone');
    expect(detail?.changeDetails).toHaveLength(1);
    expect(detail?.recordContext?.headline).toContain('Bob');
  });
});
