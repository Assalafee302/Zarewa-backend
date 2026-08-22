import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { runEnteredDataRefundPreviewChecks } from './enteredDataRefundPreviewHarness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xlsxPath = path.join(root, 'zarewa-entered-data (1).xlsx');
const hasXlsx = fs.existsSync(xlsxPath);

describe.runIf(hasXlsx)('entered-data refund preview (cancelled + overpay)', () => {
  /** @type {ReturnType<typeof runEnteredDataRefundPreviewChecks> | null} */
  let report = null;

  beforeAll(() => {
    report = runEnteredDataRefundPreviewChecks(xlsxPath);
  }, 180_000);

  it('does not stack Overpayment with Order cancellation on cancelled production quotes', () => {
    expect(report).toBeTruthy();
    expect(report.cancelledQuoteCount).toBeGreaterThan(0);
    expect(report.cancelledLogicFailures).toEqual([]);

    const withOverpay = report.cancelledResults.filter((r) => r.overpaymentExcess > 0);
    expect(withOverpay.length).toBeGreaterThan(0);

    for (const row of withOverpay) {
      expect(row.stacksOverpayAndCancel).toBe(false);
      expect(row.overlapOk).toBe(true);
      expect(row.exceedsHardCap).toBe(false);
      expect(row.suggestedLines.some((s) => s.startsWith('Order cancellation:'))).toBe(true);
      expect(row.suggestedLines.some((s) => s.startsWith('Overpayment:'))).toBe(false);
    }
  });

  it('historical Overpayment+Order cancellation refunds no longer auto-preview both categories', () => {
    expect(report).toBeTruthy();
    expect(report.historicalBothCategoryCount).toBeGreaterThan(0);

    for (const row of report.bothResults) {
      expect(row.stacksOverpayAndCancel).toBe(false);
      expect(row.overlapOk).toBe(true);
    }
  });
});

describe.runIf(!hasXlsx)('entered-data refund preview (skipped)', () => {
  it('skips when xlsx is missing', () => {
    expect(hasXlsx).toBe(false);
  });
});
