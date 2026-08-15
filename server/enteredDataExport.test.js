import { describe, expect, it, vi } from 'vitest';
import XLSX from 'xlsx';
import {
  buildEnteredDataXlsx,
  collectEnteredDataPack,
  enteredDataFilename,
  enteredDataFlatten,
} from './enteredDataExport.js';

describe('enteredDataExport', () => {
  it('flattenCustomers picks directory fields and stringifies tags', () => {
    const rows = enteredDataFlatten.flattenCustomers([
      {
        customerID: 'CU-1',
        name: 'Musa',
        phoneNumber: '0801',
        crmTags: ['vip', 'kaduna'],
        archived: false,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].customerID).toBe('CU-1');
    expect(rows[0].name).toBe('Musa');
    expect(rows[0].crmTags).toBe('vip; kaduna');
  });

  it('flattenQuotationLines expands product, accessory, and service lines', () => {
    const lines = enteredDataFlatten.flattenQuotationLines([
      {
        id: 'Q-1',
        customer: 'Amina',
        dateISO: '2026-03-01',
        quotationLines: {
          products: [{ name: 'Alu 0.35', qty: '10', unitPrice: '2500' }],
          accessories: [{ name: 'Ridge', qty: '2', unitPrice: '800' }],
          services: [],
        },
      },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((r) => r.category)).toEqual(['products', 'accessories']);
    expect(lines[0].quotationId).toBe('Q-1');
    expect(lines[0].name).toBe('Alu 0.35');
  });

  it('buildEnteredDataXlsx writes Summary plus data sheets', () => {
    const pack = {
      ok: true,
      branchScope: 'BR-KD',
      generatedAtISO: '2026-08-15T10:00:00.000Z',
      recordCount: 2,
      totals: { Customers: 1, Quotations: 1 },
      sheets: [
        { name: 'Customers', rows: [{ customerID: 'CU-1', name: 'Musa' }] },
        { name: 'Quotations', rows: [{ id: 'Q-1', customer: 'Musa', totalNgn: 50000 }] },
        { name: 'Receipts', rows: [] },
      ],
    };
    const buf = buildEnteredDataXlsx(pack);
    expect(Buffer.isBuffer(buf) || buf instanceof Uint8Array).toBe(true);
    const wb = XLSX.read(buf, { type: 'buffer' });
    expect(wb.SheetNames).toContain('Summary');
    expect(wb.SheetNames).toContain('Customers');
    expect(wb.SheetNames).toContain('Quotations');
    expect(wb.SheetNames).toContain('Receipts');
    const customers = XLSX.utils.sheet_to_json(wb.Sheets.Customers);
    expect(customers).toEqual([{ customerID: 'CU-1', name: 'Musa' }]);
  });

  it('collectEnteredDataPack returns empty sheets when list queries fail', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {
      prepare: () => {
        throw new Error('no schema');
      },
    };
    const pack = collectEnteredDataPack(db, 'ALL');
    spy.mockRestore();
    expect(pack.ok).toBe(true);
    expect(pack.branchScope).toBe('ALL');
    expect(pack.recordCount).toBe(0);
    expect(pack.sheets.length).toBeGreaterThan(10);
    expect(pack.sheets.every((s) => s.rows.length === 0)).toBe(true);
  });

  it('enteredDataFilename sanitizes branch scope', () => {
    expect(enteredDataFilename('BR-KD', '2026-08-15T12:00:00.000Z')).toBe(
      'zarewa-entered-data-BR-KD-2026-08-15.xlsx'
    );
    expect(enteredDataFilename('ALL / HQ', '2026-08-15')).toBe('zarewa-entered-data-ALLHQ-2026-08-15.xlsx');
  });
});
