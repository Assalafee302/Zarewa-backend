import { describe, expect, it } from 'vitest';
import { assessControlVariance, defaultControlTieOutThresholdPct } from './accountingControlTieOutOps.js';

describe('accountingControlTieOut (pure)', () => {
  it('assessControlVariance ok when both zero', () => {
    const r = assessControlVariance(0, 0);
    expect(r.status).toBe('ok');
    expect(r.varianceNgn).toBe(0);
  });

  it('assessControlVariance ok within 1% tolerance', () => {
    const r = assessControlVariance(1_000_000, 995_000);
    expect(r.status).toBe('ok');
    expect(r.varianceNgn).toBe(5_000);
  });

  it('assessControlVariance warn when material and above threshold', () => {
    const r = assessControlVariance(1_000_000, 900_000);
    expect(r.status).toBe('warn');
    expect(r.varianceNgn).toBe(100_000);
  });

  it('assessControlVariance ok for small absolute variance under floor', () => {
    const r = assessControlVariance(10_000, 10_500);
    expect(r.status).toBe('ok');
  });

  it('defaultControlTieOutThresholdPct reads env as decimal or percent', () => {
    const prev = process.env.ACCOUNTING_TIEOUT_THRESHOLD_PCT;
    try {
      process.env.ACCOUNTING_TIEOUT_THRESHOLD_PCT = '0.02';
      expect(defaultControlTieOutThresholdPct()).toBe(0.02);
      process.env.ACCOUNTING_TIEOUT_THRESHOLD_PCT = '2';
      expect(defaultControlTieOutThresholdPct()).toBe(0.02);
    } finally {
      if (prev === undefined) delete process.env.ACCOUNTING_TIEOUT_THRESHOLD_PCT;
      else process.env.ACCOUNTING_TIEOUT_THRESHOLD_PCT = prev;
    }
  });
});
