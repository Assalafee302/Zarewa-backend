import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPurchaseReport,
  flatsheetPiecesFromMovement,
  poIdFromSupplierPaymentSource,
} from './purchaseReportCore.js';

const kd = JSON.parse(
  fs.readFileSync(new URL('./__fixtures__/kd-2026-09/purchaseRegisterSource.json', import.meta.url), 'utf8')
);

const sep = buildPurchaseReport(kd);
const aug = buildPurchaseReport({ ...kd, startDate: '2026-08-01', endDate: '2026-08-31' });

const outstandingByPo = (report) =>
  Object.fromEntries(report.supplierPositions.rows.filter((r) => r.outstandingNgn > 0).map((r) => [r.poId, r.outstandingNgn]));

describe('purchase register v2 — Kaduna Sep 2026 fixture', () => {
  it('values coil GRN at received kg × unit cost', () => {
    expect(sep.aluminium.totals.totalValueNgn + sep.aluzinc.totals.totalValueNgn).toBe(121_443_840);
    expect(sep.unclassifiedCoil.totals.lineCount).toBe(0);
  });

  it('counts aluminium 6,970 kg (coil 2082, GRN 31 Aug, stays out) and aluzinc 43,304 kg', () => {
    expect(sep.aluminium.totals.totalReceived).toBe(6970);
    expect(sep.aluzinc.totals.totalReceived).toBe(43304);
    const coils = sep.aluminium.groups.flatMap((g) => g.rows.map((r) => r.coilNo));
    expect(coils).not.toContain('CL-26-2082');
  });

  it('keeps today’s remaining value in its own column', () => {
    const row = sep.aluminium.groups[0].rows[0];
    expect(row).toHaveProperty('remainingValueTodayNgn');
    expect(row.totalNgn).toBe(Math.round(row.receivedKg * row.kgAmountNgn));
  });

  it('shows flat sheets in pieces (160)', () => {
    expect(sep.stoneFlatsheets.receivedUnit).toBe('pieces');
    expect(sep.stoneFlatsheets.totals.totalReceived).toBe(160);
    expect(sep.summary.byMaterial.find((m) => m.key === 'stone_flatsheet')).toMatchObject({
      received: 160,
      receivedUnit: 'pieces',
    });
  });

  it('splits payments made this period from payments against this period’s POs', () => {
    const t = sep.payments.totals;
    expect(t.paymentsMadeInPeriodNgn).toBe(166_976_070);
    expect(t.paidAgainstEarlierPosNgn).toBe(15_055_040);
    expect(t.paidAgainstPeriodPosNgn).toBe(166_976_070 - 15_055_040);
    expect(t.unlinkedPaymentsNgn).toBe(0);
  });

  it('flags PO-0079 overpaid by ₦5,920,250', () => {
    const row = sep.supplierPositions.rows.find((r) => r.poId === 'PO-KD-26-0079');
    expect(row.overpaidNgn).toBe(5_920_250);
    expect(row.outstandingNgn).toBe(0);
  });

  it('states supplier outstanding as at 31 Aug = ₦24,105,440', () => {
    expect(outstandingByPo(aug)).toEqual({
      'PO-KD-26-0061': 9_050_000,
      'PO-KD-26-0062': 1_055_040,
      'PO-KD-26-0066': 2_000_000,
      'PO-KD-26-0070': 12_000_400,
    });
    expect(aug.payments.totals.supplierOutstandingAtEndNgn).toBe(24_105_440);
  });

  it('states supplier outstanding as at 30 Sep = PO-0061 ₦9,050,000 plus the PO-0070 ₦400 residual in the data', () => {
    expect(outstandingByPo(sep)).toEqual({ 'PO-KD-26-0061': 9_050_000, 'PO-KD-26-0070': 400 });
  });

  it('lists paid-not-received POs at 30 Sep including PO-0081 and PO-0084', () => {
    const gap = Object.fromEntries(sep.paidNotReceived.rows.map((r) => [r.poId, r.gapNgn]));
    expect(gap['PO-KD-26-0081']).toBe(304_200);
    expect(gap['PO-KD-26-0084']).toBe(340_000);
  });

  it('prints the real branch name', () => {
    expect(sep.branch).toEqual({ id: 'BR-KD', name: 'Kaduna (HQ)' });
  });
});

describe('purchase register helpers', () => {
  it('maps AP source ids to the PO', () => {
    const poById = new Map([['PO-KD-26-0071', {}]]);
    expect(poIdFromSupplierPaymentSource('AP-PO-PO-KD-26-0071', poById)).toBe('PO-KD-26-0071');
    expect(poIdFromSupplierPaymentSource('PO-KD-26-0071', poById)).toBe('PO-KD-26-0071');
    expect(poIdFromSupplierPaymentSource('', poById)).toBe('');
  });

  it('reads pieces from old (m²) and new flat-sheet GRN details', () => {
    expect(flatsheetPiecesFromMovement({ qty: 144, detail: 'FS-1 · 60 sheets → 144.00 m²' })).toBe(60);
    expect(flatsheetPiecesFromMovement({ qty: 50, detail: '50 sheets (120.00 m²)' })).toBe(50);
    expect(flatsheetPiecesFromMovement({ qty: 12, detail: 'no count' })).toBe(12);
  });
});
