import { describe, expect, it } from 'vitest';
import { refundCuttingListQuotationMetreIssues } from './cuttingListQuotationConsumptionOps.js';

describe('cuttingListQuotationConsumptionOps', () => {
  function memDb({ quote, cuttingLists = [] }) {
    return {
      prepare(sql) {
        const s = String(sql);
        return {
          get(ref) {
            if (s.includes('FROM quotations')) {
              return quote && ref === quote.id ? { lines_json: quote.lines_json } : undefined;
            }
            return undefined;
          },
          all(ref) {
            if (s.includes('FROM cutting_lists')) {
              return cuttingLists.filter((cl) => cl.quotation_ref === ref);
            }
            if (s.includes('FROM cutting_list_lines')) {
              const clId = ref;
              const cl = cuttingLists.find((row) => row.id === clId);
              return cl?.lines || [];
            }
            return [];
          },
        };
      },
    };
  }

  it('returns no issues when quote and cutting list align with trim blank', () => {
    const db = memDb({
      quote: {
        id: 'Q1',
        lines_json: JSON.stringify({
          products: [
            { name: 'Roofing Sheet', qty: 100 },
            { name: 'Ridge Cap', qty: 3, girthMm: 400 },
          ],
        }),
      },
      cuttingLists: [
        {
          id: 'CL1',
          quotation_ref: 'Q1',
          lines: [
            { sheets: 50, length_m: 2, total_m: 100, line_type: 'Roof' },
            { sheets: 1, length_m: 1, total_m: 1, line_type: 'Flatsheet' },
          ],
        },
      ],
    });
    expect(refundCuttingListQuotationMetreIssues(db, 'Q1')).toEqual([]);
  });

  it('treats under-quote cutting list as info (not hard block) and still flags missing trim blank', () => {
    const db = memDb({
      quote: {
        id: 'Q1',
        lines_json: JSON.stringify({
          products: [
            { name: 'Roofing Sheet', qty: 100 },
            { name: 'Ridge Cap', qty: 3, girthMm: 400 },
          ],
        }),
      },
      cuttingLists: [
        {
          id: 'CL1',
          quotation_ref: 'Q1',
          lines: [{ sheets: 50, length_m: 2, total_m: 100, line_type: 'Roof' }],
        },
      ],
    });
    const issues = refundCuttingListQuotationMetreIssues(db, 'Q1');
    expect(issues.some((i) => i.code === 'cutting_list_quotation_metre_under' && i.severity === 'info')).toBe(
      true
    );
    expect(issues.some((i) => i.code === 'cutting_list_quotation_metre_mismatch')).toBe(false);
    expect(issues.some((i) => i.code === 'trim_blank_cl_missing')).toBe(true);
  });

  it('hard-flags when cutting list exceeds quotation metres', () => {
    const db = memDb({
      quote: {
        id: 'Q1',
        lines_json: JSON.stringify({
          products: [{ name: 'Roofing Sheet', qty: 100 }],
        }),
      },
      cuttingLists: [
        {
          id: 'CL1',
          quotation_ref: 'Q1',
          lines: [{ sheets: 60, length_m: 2, total_m: 120, line_type: 'Roof' }],
        },
      ],
    });
    const issues = refundCuttingListQuotationMetreIssues(db, 'Q1');
    expect(issues.some((i) => i.code === 'cutting_list_quotation_metre_mismatch' && i.severity === 'error')).toBe(
      true
    );
  });

  it('does not duplicate trim blank soft warning when under-quote already noted', () => {
    const db = memDb({
      quote: {
        id: 'Q1',
        lines_json: JSON.stringify({
          products: [
            { name: 'Roofing Sheet', qty: 100 },
            { name: 'Ridge Cap', qty: 3, girthMm: 400 },
          ],
        }),
      },
      cuttingLists: [
        {
          id: 'CL1',
          quotation_ref: 'Q1',
          lines: [{ sheets: 50, length_m: 2, total_m: 100, line_type: 'Roof' }],
        },
      ],
    });
    const issues = refundCuttingListQuotationMetreIssues(db, 'Q1');
    expect(issues.some((i) => i.code === 'cutting_list_quotation_metre_under')).toBe(true);
    expect(issues.some((i) => i.code === 'trim_blank_cl_missing')).toBe(true);
  });

  it('flags trim blank missing when total matches but flatsheet section is short', () => {
    const db = memDb({
      quote: {
        id: 'Q1',
        lines_json: JSON.stringify({
          products: [
            { name: 'Roofing Sheet', qty: 100 },
            { name: 'Ridge Cap', qty: 3, girthMm: 400 },
          ],
        }),
      },
      cuttingLists: [
        {
          id: 'CL1',
          quotation_ref: 'Q1',
          lines: [{ sheets: 101, length_m: 1, total_m: 101, line_type: 'Roof' }],
        },
      ],
    });
    const issues = refundCuttingListQuotationMetreIssues(db, 'Q1');
    expect(issues.some((i) => i.code === 'trim_blank_cl_missing')).toBe(true);
    expect(issues.some((i) => i.code === 'cutting_list_quotation_metre_mismatch')).toBe(false);
  });
});
