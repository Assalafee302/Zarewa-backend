import { describe, expect, it } from 'vitest';
import {
  QUOTE_FLOOR_FREEZE,
  describeQuoteFloorFreeze,
  describeQuoteLineFloor,
  pickQuoteLineFloor,
} from './quoteFloorPolicy.js';

describe('pickQuoteLineFloor', () => {
  it('uses workbook and ignores a stamp that equals the list badge', () => {
    const pick = pickQuoteLineFloor({
      workbookFloorNgn: 3850,
      stampedFloorNgn: 3900,
      listBadgeNgn: 3900,
      meterSheet: true,
    });
    expect(pick.floorNgnPerM).toBe(3850);
    expect(pick.source).toBe('workbook');
    expect(pick.ignoredListStamp).toBe(true);
  });

  it('lets a real stamp freeze downward only', () => {
    const pick = pickQuoteLineFloor({
      workbookFloorNgn: 4500,
      stampedFloorNgn: 4000,
      listBadgeNgn: 4800,
      meterSheet: true,
    });
    expect(pick.floorNgnPerM).toBe(4000);
    expect(pick.source).toBe('line_stamp');
    expect(pick.ignoredListStamp).toBe(false);
  });

  it('does not invent a meter-sheet min from a list stamp when workbook is missing', () => {
    const pick = pickQuoteLineFloor({
      workbookFloorNgn: null,
      stampedFloorNgn: 4800,
      listBadgeNgn: 0,
      meterSheet: true,
    });
    expect(pick.floorNgnPerM).toBeNull();
  });

  it('allows stamp-only on non-meter-sheet lines', () => {
    const pick = pickQuoteLineFloor({
      workbookFloorNgn: null,
      stampedFloorNgn: 2500,
      listBadgeNgn: 0,
      meterSheet: false,
    });
    expect(pick.floorNgnPerM).toBe(2500);
    expect(pick.source).toBe('line_stamp');
  });
});

describe('describeQuoteFloorFreeze', () => {
  it('names first payment vs quote date vs live', () => {
    expect(
      describeQuoteFloorFreeze({
        freezeEvent: QUOTE_FLOOR_FREEZE.FIRST_PAYMENT,
        freezeDateIso: '2026-04-01',
      })
    ).toMatch(/first payment \(2026-04-01\)/);
    expect(
      describeQuoteFloorFreeze({
        freezeEvent: QUOTE_FLOOR_FREEZE.QUOTATION_DATE,
        freezeDateIso: '2026-03-15',
      })
    ).toMatch(/quotation date \(2026-03-15\)/);
    expect(describeQuoteFloorFreeze({ freezeEvent: QUOTE_FLOOR_FREEZE.LIVE })).toMatch(/Live workbook/);
  });
});

describe('describeQuoteLineFloor', () => {
  it('prints workbook gate plus freeze why', () => {
    const pick = pickQuoteLineFloor({
      workbookFloorNgn: 4000,
      stampedFloorNgn: 0,
      meterSheet: true,
    });
    const why = describeQuoteLineFloor(pick, {
      why: describeQuoteFloorFreeze({
        freezeEvent: QUOTE_FLOOR_FREEZE.QUOTATION_DATE,
        freezeDateIso: '2026-03-15',
      }),
    });
    expect(why).toMatch(/₦4,000\/m/);
    expect(why).toMatch(/workbook minimum/);
    expect(why).toMatch(/unpaid/);
  });
});
