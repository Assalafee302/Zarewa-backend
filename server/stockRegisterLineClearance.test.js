import { describe, expect, it } from 'vitest';
import {
  buildAdjustmentsFromClearance,
  computeClearanceProgress,
  LINE_STATUS,
  FINISHED_CONFIRM,
  lineKeyCoil,
  lineKeyFinished,
  roundKg,
  setLineEntry,
  validateBmApprove,
  validateStoreChecklist,
} from '../shared/lib/stockRegisterLineClearance.js';

describe('stockRegisterLineClearance', () => {
  const register = {
    coilSections: {
      aluminium: {
        groups: [
          {
            gaugeLabel: '0.22mm',
            rows: [
              { coilNo: 'C-1001', coilNoDisplay: '1001', closingKg: 500, finishedInPeriod: false },
              { coilNo: 'C-1002', coilNoDisplay: '1002', closingBlank: true, finishedInPeriod: true, usedKg: 1000 },
            ],
          },
        ],
      },
      aluzinc: { groups: [] },
    },
    stoneCoated: { groups: [] },
    accessories: { rows: [] },
    inTransit: [],
  };

  it('roundKg uses whole numbers', () => {
    expect(roundKg(499.6)).toBe(500);
    expect(roundKg(0)).toBe(0);
  });

  it('validateStoreChecklist requires all items', () => {
    expect(validateStoreChecklist({}).ok).toBe(false);
    expect(
      validateStoreChecklist({
        coilsCounted: true,
        finishedVerified: true,
        stoneCounted: true,
        accessoriesCounted: true,
        inTransitReviewed: true,
      }).ok
    ).toBe(true);
  });

  it('blocks bm approve while lines pending', () => {
    const r = validateBmApprove(register, { lines: {} }, {});
    expect(r.ok).toBe(false);
  });

  it('allows bm approve when all cleared and finished confirmed', () => {
    let c = { lines: {} };
    c = setLineEntry(c, lineKeyCoil('C-1001'), { status: LINE_STATUS.CLEARED });
    c = setLineEntry(c, lineKeyFinished('C-1002'), { finishedConfirm: FINISHED_CONFIRM.CONFIRMED, status: LINE_STATUS.CLEARED });
    const r = validateBmApprove(register, c, {});
    expect(r.ok).toBe(true);
  });

  it('requires MEX for adjusted coil with variance', () => {
    let c = { lines: {} };
    c = setLineEntry(c, lineKeyCoil('C-1001'), {
      status: LINE_STATUS.ADJUSTED,
      countedClosingKg: 480,
    });
    c = setLineEntry(c, lineKeyFinished('C-1002'), { finishedConfirm: FINISHED_CONFIRM.CONFIRMED });
    const r = validateBmApprove(register, c, {});
    expect(r.ok).toBe(false);
  });

  it('buildAdjustmentsFromClearance extracts coil adjustments', () => {
    let c = { lines: {} };
    c = setLineEntry(c, lineKeyCoil('C-1001'), {
      status: LINE_STATUS.ADJUSTED,
      countedClosingKg: 480,
      materialExceptionId: 'MEX-1',
      note: 'count',
    });
    const adj = buildAdjustmentsFromClearance(register, c);
    expect(adj.coilLines).toHaveLength(1);
    expect(adj.coilLines[0].closingKg).toBe(480);
  });

  it('computeClearanceProgress counts pending', () => {
    const p = computeClearanceProgress(register, { lines: {} });
    expect(p.total).toBe(2);
    expect(p.pending).toBeGreaterThan(0);
  });
});
