/**
 * Workspace branch guards for ID-based reads/writes.
 */
import { describe, it, expect } from 'vitest';
import {
  assertCustomerIdInWorkspace,
  assertExpenseIdInWorkspace,
  assertMaterialIncidentIdInWorkspace,
  assertCoilRequestIdInWorkspace,
  assertRefundIdInWorkspace,
  assertQuotationIdInWorkspace,
} from './workspaceBranchGuards.js';

function fakeDb(rowsBySql) {
  return {
    prepare(sql) {
      const text = String(sql);
      return {
        get(...args) {
          for (const [needle, row] of rowsBySql) {
            if (text.includes(needle)) {
              return typeof row === 'function' ? row(...args) : row;
            }
          }
          return undefined;
        },
      };
    },
  };
}

const kadunaUser = { id: 'u1', roleKey: 'cashier', permissions: [] };
const kadunaReq = { user: kadunaUser, workspaceBranchId: 'BR-KD', workspaceViewAll: false };

describe('workspaceBranchGuards cross-branch', () => {
  it('blocks refund detail from another branch', () => {
    const db = fakeDb([
      ['FROM customer_refunds', { refund_id: 'RF-YL', branch_id: 'BR-YL' }],
    ]);
    const g = assertRefundIdInWorkspace(db, kadunaReq, 'RF-YL');
    expect(g.ok).toBe(false);
    expect(g.status).toBe(403);
  });

  it('allows refund in the same workspace branch', () => {
    const db = fakeDb([
      ['FROM customer_refunds', { refund_id: 'RF-KD', branch_id: 'BR-KD' }],
    ]);
    expect(assertRefundIdInWorkspace(db, kadunaReq, 'RF-KD').ok).toBe(true);
  });

  it('blocks quotation / customer / expense / incident / coil from Yola on Kaduna', () => {
    const db = fakeDb([
      ['FROM quotations', { id: 'QT-YL', branch_id: 'BR-YL' }],
      ['FROM customers', { customer_id: 'CUS-YL', branch_id: 'BR-YL' }],
      ['FROM expenses', { expense_id: 'EXP-YL', branch_id: 'BR-YL' }],
      ['FROM material_incidents', { id: 'MI-YL', branch_id: 'BR-YL' }],
      ['FROM coil_requests', { id: 'CR-YL', branch_id: 'BR-YL' }],
    ]);
    expect(assertQuotationIdInWorkspace(db, kadunaReq, 'QT-YL').ok).toBe(false);
    expect(assertCustomerIdInWorkspace(db, kadunaReq, 'CUS-YL').ok).toBe(false);
    expect(assertExpenseIdInWorkspace(db, kadunaReq, 'EXP-YL').ok).toBe(false);
    expect(assertMaterialIncidentIdInWorkspace(db, kadunaReq, 'MI-YL').ok).toBe(false);
    expect(assertCoilRequestIdInWorkspace(db, kadunaReq, 'CR-YL').ok).toBe(false);
  });
});
