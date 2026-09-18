import { describe, it, expect } from 'vitest';
import {
  buildExpectedCoilSpecFromQuotation,
  coilMatchesQuotationSpec,
  coilSpecMismatchIssues,
  coilVersusQuotationAndProductWarning,
  expectedGaugeBoundsMm,
} from './coilSpecVersusProduct.js';

describe('coilSpecVersusProduct', () => {
  it('buildExpectedCoilSpecFromQuotation merges quotation header and product attrs', () => {
    const q = {
      materialGauge: '0.5mm',
      materialColor: 'Traffic white',
      materialDesign: 'Longspan',
      quotationLines: { products: [{ name: 'Aluminium roofing sheet' }] },
    };
    const p = { gauge: '0.4mm', colour: 'Blue', materialType: 'Steel' };
    const e = buildExpectedCoilSpecFromQuotation(q, p);
    expect(e.gauge).toBe('0.5mm');
    expect(e.colour).toBe('Traffic white');
    expect(e.design).toBe('Longspan');
    expect(e.materialType).toBe('Steel');
  });

  it('does not fall back to product names like bargeboard as raw coil material', () => {
    const q = {
      materialGauge: '0.28mm',
      materialColor: 'Traffic Black',
      quotationLines: { products: [{ name: 'Bargeboard' }] },
    };
    const e = buildExpectedCoilSpecFromQuotation(q, null);
    expect(e.materialType).toBeNull();
  });

  it('coilMatchesQuotationSpec is true when coil aligns', () => {
    const lot = { gaugeLabel: '0.5mm', colour: 'Traffic White', materialTypeName: 'Steel sheet' };
    const exp = { gauge: '0.5mm', colour: 'traffic white', materialType: 'Steel', design: null };
    const { issues } = coilSpecMismatchIssues(lot, exp);
    expect(issues).toHaveLength(0);
    expect(coilMatchesQuotationSpec(lot, { materialGauge: '0.5mm', materialColor: 'Traffic white' }, { materialType: 'Steel' })).toBe(true);
  });

  it('coilMatchesQuotationSpec is false on gauge drift', () => {
    const lot = { gaugeLabel: '0.9mm', colour: 'White', materialTypeName: 'Steel' };
    const ok = coilMatchesQuotationSpec(
      lot,
      { materialGauge: '0.5mm', materialColor: 'White' },
      { materialType: 'Steel' }
    );
    expect(ok).toBe(false);
  });

  it('coilMatchesQuotationSpec matches quotation colour name to coil abbreviation via master data', () => {
    const masterData = {
      colours: [{ name: 'Bush Green', abbreviation: 'BG', active: true }],
    };
    const lot = { gaugeLabel: '0.20mm', colour: 'BG', materialTypeName: 'Aluzinc longspan' };
    expect(
      coilMatchesQuotationSpec(
        lot,
        { materialGauge: '0.20mm', materialColor: 'Bush Green', quotationLines: { products: [] } },
        {},
        masterData
      )
    ).toBe(true);
  });

  it('expectedGaugeBoundsMm parses single value and en-dash ranges', () => {
    expect(expectedGaugeBoundsMm('0.24mm')).toEqual({ lo: 0.24, hi: 0.24 });
    expect(expectedGaugeBoundsMm('0.18–0.24')).toEqual({ lo: 0.18, hi: 0.24 });
  });

  it('coil in gauge range matches FG product with 0.18–0.24 style label', () => {
    const lot = { gaugeLabel: '0.24mm', colour: '', materialTypeName: 'Aluminium' };
    const exp = buildExpectedCoilSpecFromQuotation(null, {
      gauge: '0.18–0.24',
      colour: '',
      materialType: 'Longspan (finished)',
    });
    const { issues } = coilSpecMismatchIssues(lot, exp);
    expect(issues).toHaveLength(0);
  });

  it('stone hybrid expected coil spec is aluzinc, not the stone roofing header', () => {
    const q = {
      stoneMeterQuote: true,
      materialTypeId: 'MAT-005',
      materialGauge: '0.24mm',
      materialColor: 'Red patch black',
      quotationLines: { products: [{ name: 'Roofing Sheet' }, { name: 'Flat sheet', qty: '20' }] },
    };
    const e = buildExpectedCoilSpecFromQuotation(q, null);
    expect(e.materialType).toBe('Aluzinc');
    expect(e.gauge).toBeNull();
    expect(e.colour).toBeNull();
    const lot = { gaugeLabel: '0.20mm', colour: 'P Red', materialTypeName: 'Aluzinc (PPGI)' };
    const { issues } = coilSpecMismatchIssues(lot, e);
    expect(issues).toHaveLength(0);
    expect(coilMatchesQuotationSpec(lot, q, null)).toBe(true);
  });

  it('stone hybrid warning does not compare an aluzinc coil to stone roofing colour/gauge', () => {
    const q = {
      stoneMeterQuote: true,
      materialTypeId: 'MAT-005',
      materialGauge: '0.24mm',
      materialColor: 'Red patch black',
      quotationLines: { products: [{ name: 'Roofing Sheet' }, { name: 'Stone flatsheet 2', qty: '20' }] },
    };
    const lot = { gaugeLabel: '0.20mm', colour: 'P Red', materialTypeName: 'Aluzinc (PPGI)' };
    expect(coilVersusQuotationAndProductWarning(lot, q, null)).toBeNull();
  });
});
