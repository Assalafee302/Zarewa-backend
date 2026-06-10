import { describe, it, expect } from 'vitest';
import {
  auditRefundCalculationLineArithmetic,
  expectedAmountFromRefundLineLabel,
  validateRefundCalculationLineArithmetic,
} from './refundLineArithmetic.js';

describe('refundLineArithmetic', () => {
  it('parses unproduced metres label and expected amount', () => {
    const label = 'Unproduced metres (2.30m @ ₦3,900)';
    expect(expectedAmountFromRefundLineLabel(label, 'Unproduced meterage')).toBe(8970);
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
});
