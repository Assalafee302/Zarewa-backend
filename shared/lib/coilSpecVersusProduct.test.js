import { describe, it, expect } from 'vitest';
import {
  buildExpectedCoilSpecFromQuotation,
  coilMatchesQuotationSpec,
  coilSpecMismatchIssues,
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
});
