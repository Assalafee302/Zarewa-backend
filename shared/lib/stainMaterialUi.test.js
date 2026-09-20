import { describe, expect, it } from 'vitest';
import { formatNgn } from './formatNgn.js';
import {
  decorateStainInventoryForUi,
  formatStainLotDisplay,
  headerIsStainMaterial,
  stainDamageFormCopy,
  stainFloorCaption,
  stainFloorFieldLabel,
  stainIncidentTypeLabel,
  stainIncidentTypeOptions,
  stainInventoryEmptyState,
  stainProductionCopy,
  stainStockCheckCopy,
  STAIN_COMPLETE_NEEDS_YARD_STOCK,
  STAIN_RESERVED_KG_NEEDS_JOB,
  STAIN_TYPE_LABEL,
} from './stainMaterialUi.js';
import { STAIN_FLOOR_DISCOUNT_NGN } from './stainMaterialPolicy.js';

describe('stainMaterialUi', () => {
  it('uses everyday words for type, floor, and incident labels', () => {
    expect(STAIN_TYPE_LABEL).toBe('Stain');
    expect(stainFloorFieldLabel()).toContain(formatNgn(STAIN_FLOOR_DISCOUNT_NGN));
    expect(stainFloorCaption(4000, 5000)).toMatch(/4,000/);
    expect(stainFloorCaption(4000, 5000)).toMatch(/no extra approval/i);
    expect(stainIncidentTypeLabel('coil_stain')).toBe('Stain on coil');
    expect(stainIncidentTypeOptions()[0].value).toBe('coil_stain');
    expect(stainIncidentTypeOptions()[0].help).toMatch(/good steel stays/i);
  });

  it('formats a stain lot as a card a storekeeper can read', () => {
    const d = formatStainLotDisplay({
      colour: 'Charcoal',
      gaugeLabel: '0.45mm',
      sourceMaterialTypeName: 'Aluzinc',
      metersAvailable: 40,
      kgBooked: 80,
      coilNo: 'C-1',
    });
    expect(d.displayTitle).toBe('Stain · Charcoal · 0.45mm');
    expect(d.displayStock).toMatch(/40/);
    expect(d.displayOrigin).toBe('Cut from coil C-1');
    expect(d.displayHint).toMatch(/Type = Stain/);
  });

  it('decorates inventory with a totals sentence and empty-yard copy', () => {
    const snap = decorateStainInventoryForUi({
      lots: [
        {
          id: 'MEX-1',
          colour: 'Charcoal',
          gaugeLabel: '0.45mm',
          sourceMaterialTypeName: 'Aluzinc',
          metersAvailable: 40,
          coilNo: 'C-1',
        },
      ],
      bySpec: [],
      totals: { lotCount: 1, metersAvailable: 40, kgBooked: 80 },
    });
    expect(snap.lots[0].displayTitle).toMatch(/Charcoal/);
    expect(snap.totals.displaySummary).toMatch(/1 stain lot/);
    expect(snap.howto).toMatch(/Sell them as Type = Stain/);
    expect(stainInventoryEmptyState().title).toMatch(/No stain/);
    expect(stainStockCheckCopy().emptyAction).toMatch(/Material exceptions/);
  });

  it('gives production and sales headers plain instructions', () => {
    expect(headerIsStainMaterial('MAT-006')).toBe(true);
    expect(headerIsStainMaterial({ materialTypeId: 'MAT-002' })).toBe(false);
    expect(stainProductionCopy().allocateCoilHelp).toMatch(/Optional/i);
    expect(STAIN_COMPLETE_NEEDS_YARD_STOCK).toMatch(/yard/);
    expect(STAIN_RESERVED_KG_NEEDS_JOB).toMatch(/booked for a job/);
    expect(stainDamageFormCopy().jobHelp).toMatch(/Leave blank if the coil is free/);
  });
});
