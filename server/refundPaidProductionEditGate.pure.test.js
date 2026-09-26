import { describe, it, expect } from 'vitest';
import { loadActiveRefundShortfallCaps } from './refundPaidProductionEditGate.js';

function mockRefundsDb(rows) {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        all(...args) {
          const ref = args[0];
          const exclude = s.includes('refund_id !=') ? String(args[1] || '').trim() : '';
          return rows.filter(
            (r) =>
              r.quotation_ref === ref &&
              !['rejected', 'cancelled'].includes(String(r.status || '').toLowerCase()) &&
              (!exclude || String(r.refund_id || '') !== exclude)
          );
        },
      };
    },
  };
}

describe('loadActiveRefundShortfallCaps (pure)', () => {
  const pendingLine = JSON.stringify([
    {
      category: 'Accessory shortfall',
      label: 'Accessory shortfall: Drive screw nail (4 × ₦2,500)',
      amountNgn: 10_000,
      include: true,
    },
  ]);

  it('nets pending accessory shortfall against itself when no excludeRefundId', () => {
    const db = mockRefundsDb([
      {
        refund_id: 'RF-ACC-APPR',
        quotation_ref: 'QT-ACC-APPR',
        status: 'Pending',
        calculation_lines_json: pendingLine,
      },
    ]);
    const caps = loadActiveRefundShortfallCaps(db, 'QT-ACC-APPR');
    expect(caps.accessoryShortfallByKey.get('drive screw nail')).toBe(4);
  });

  it('does not net the refund being re-previewed (approve / pay)', () => {
    const db = mockRefundsDb([
      {
        refund_id: 'RF-ACC-APPR',
        quotation_ref: 'QT-ACC-APPR',
        status: 'Pending',
        calculation_lines_json: pendingLine,
      },
    ]);
    const caps = loadActiveRefundShortfallCaps(db, 'QT-ACC-APPR', 'RF-ACC-APPR');
    expect(caps.accessoryShortfallByKey.get('drive screw nail') || 0).toBe(0);
  });

  it('still nets a different open refund after excluding self', () => {
    const db = mockRefundsDb([
      {
        refund_id: 'RF-ACC-APPR',
        quotation_ref: 'QT-ACC-APPR',
        status: 'Pending',
        calculation_lines_json: pendingLine,
      },
      {
        refund_id: 'RF-OTHER',
        quotation_ref: 'QT-ACC-APPR',
        status: 'Pending',
        calculation_lines_json: pendingLine,
      },
    ]);
    const caps = loadActiveRefundShortfallCaps(db, 'QT-ACC-APPR', 'RF-ACC-APPR');
    expect(caps.accessoryShortfallByKey.get('drive screw nail')).toBe(4);
  });
});
