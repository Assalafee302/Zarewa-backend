import { describe, expect, it } from 'vitest';
import {
  auditRefundCalculationLineArithmetic,
  buildUnproducedMetresRefundLine,
  expectedAmountFromRefundLineLabel,
  formatUnproducedMetresLabel,
  scaleRefundCalculationLinesToApprovedAmount,
  sumRefundCalculationLines,
  validateRefundCalculationLineArithmetic,
} from './refundLineArithmetic.js';

describe('refundLineArithmetic', () => {
  it('parses unproduced metres label and expected amount', () => {
    const label = 'Unproduced metres (2.30m @ ₦3,900)';
    expect(expectedAmountFromRefundLineLabel(label, 'Unproduced meterage')).toBe(8970);
  });

  it('passes when amount is below label-implied (blended ₦/m rounding)', () => {
    const r = validateRefundCalculationLineArithmetic([
      {
        label: 'Unproduced metres (21.80m @ ₦5,806)',
        category: 'Unproduced meterage',
        amountNgn: 126_563,
      },
    ]);
    expect(r.ok).toBe(true);
  });

  it('buildUnproducedMetresRefundLine aligns label with blended quote ₦/m', () => {
    const line = buildUnproducedMetresRefundLine(21.8, 5805.64220183486);
    expect(line.amountNgn).toBe(126_563);
    expect(expectedAmountFromRefundLineLabel(line.label, 'Unproduced meterage')).toBe(126_563);
  });

  it('flags amount that does not match label formula', () => {
    const r = validateRefundCalculationLineArithmetic([
      {
        label: 'Unproduced metres (2.30m @ ₦3,900)',
        category: 'Unproduced meterage',
        amountNgn: 23_549,
      },
    ]);
    expect(r.ok).toBe(false);
    expect(r.issues[0].expectedAmountNgn).toBe(8970);
    expect(r.issues[0].amountNgn).toBe(23_549);
  });

  it('passes when amount matches label formula', () => {
    const r = validateRefundCalculationLineArithmetic([
      {
        label: 'Unproduced metres (2.30m @ ₦3,900)',
        category: 'Unproduced meterage',
        amountNgn: 8970,
      },
    ]);
    expect(r.ok).toBe(true);
  });

  it('ignores lines without parseable formula labels', () => {
    expect(
      auditRefundCalculationLineArithmetic([
        { label: 'Goodwill adjustment', category: 'Other', amountNgn: 5000 },
      ])
    ).toEqual([]);
  });

  it('scaleRefundCalculationLinesToApprovedAmount rebuilds unproduced metres label', () => {
    const scaled = scaleRefundCalculationLinesToApprovedAmount(
      [
        {
          label: 'Unproduced metres (10m @ ₦3,900)',
          category: 'Unproduced meterage',
          amountNgn: 39_000,
        },
      ],
      19_500
    );
    expect(scaled[0].amountNgn).toBe(19_500);
    expect(scaled[0].label).toBe(formatUnproducedMetresLabel(5, 3900));
    expect(expectedAmountFromRefundLineLabel(scaled[0].label, 'Unproduced meterage')).toBe(19_500);
  });

  it('sumRefundCalculationLines skips excluded lines', () => {
    expect(
      sumRefundCalculationLines([
        { amountNgn: '1,000', include: true },
        { amountNgn: 500, include: false },
        { amount_ngn: 250 },
      ])
    ).toBe(1250);
  });
});
