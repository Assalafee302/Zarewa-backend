import { describe, expect, it } from 'vitest';
import {
  classifyReceiptGlPolicyBasis,
  productionStatusAtReceipt,
  simulateProductionRecognition,
  simulateReceiptCreditAccount,
  sumLegacyBridgeFromReceiptClasses,
} from './ap1cSimulator.js';

const jobsPost = [
  {
    status: 'Completed',
    quotationRef: 'QT-1',
    actualMeters: 10,
    completedAtISO: '2026-06-10T12:00:00.000Z',
  },
];

describe('ap1cSimulator', () => {
  it('receipt before production should simulate 2500', () => {
    const r = simulateReceiptCreditAccount({
      quotationRef: 'QT-1',
      receiptAtISO: '2026-06-01',
      productionJobs: jobsPost,
    });
    expect(r.ok).toBe(true);
    expect(r.policyCreditAccount).toBe('2500');
    expect(r.productionPhaseAtReceipt).toBe('pre_production');
  });

  it('receipt after production should simulate 1200', () => {
    const r = simulateReceiptCreditAccount({
      quotationRef: 'QT-1',
      receiptAtISO: '2026-06-15',
      productionJobs: jobsPost,
    });
    expect(r.policyCreditAccount).toBe('1200');
    expect(r.productionPhaseAtReceipt).toBe('post_production');
  });

  it('full payment before production release simulation', () => {
    const sim = simulateProductionRecognition({
      earnedNgn: 100_000,
      advanceAppliedNgn: 0,
      policyDepositsNgn: 100_000,
      legacyBridgeNgn: 0,
    });
    expect(sim.expectedRelease2500Ngn).toBe(100_000);
    expect(sim.expectedArDebitNgn).toBe(0);
    expect(sim.currentRelease2500Ngn).toBe(0);
    expect(sim.potentialArOverstatementNgn).toBe(100_000);
  });

  it('partial payment before production AR simulation', () => {
    const sim = simulateProductionRecognition({
      earnedNgn: 100_000,
      advanceAppliedNgn: 0,
      policyDepositsNgn: 40_000,
      legacyBridgeNgn: 0,
    });
    expect(sim.expectedRelease2500Ngn).toBe(40_000);
    expect(sim.expectedArDebitNgn).toBe(60_000);
  });

  it('overpayment remains deposit (no AR on full deposit coverage)', () => {
    const sim = simulateProductionRecognition({
      earnedNgn: 80_000,
      advanceAppliedNgn: 0,
      policyDepositsNgn: 100_000,
      legacyBridgeNgn: 0,
    });
    expect(sim.expectedRelease2500Ngn).toBe(80_000);
    expect(sim.expectedArDebitNgn).toBe(0);
  });

  it('legacy receipt credited 1200 before production becomes bridge amount', () => {
    const c = classifyReceiptGlPolicyBasis({
      receipt: { quotationRef: 'QT-L', amountNgn: 50_000, dateISO: '2026-06-01' },
      journalLines: [{ accountCode: '1200', creditNgn: 50_000 }],
      productionJobs: jobsPost.map((j) => ({ ...j, quotationRef: 'QT-L' })),
    });
    expect(c.isLegacyPreProd1200).toBe(true);
    expect(c.legacyBridgeNgn).toBe(50_000);
    const sim = simulateProductionRecognition({
      earnedNgn: 100_000,
      policyDepositsNgn: 0,
      legacyBridgeNgn: 50_000,
      advanceAppliedNgn: 0,
    });
    expect(sim.expectedArDebitNgn).toBe(50_000);
    expect(sim.potentialArOverstatementNgn).toBeGreaterThan(0);
  });

  it('mixed legacy/new receipt simulation does not double count AR in bridge sum', () => {
    const legacy = classifyReceiptGlPolicyBasis({
      receipt: { quotationRef: 'QT-M', amountNgn: 30_000, dateISO: '2026-06-01' },
      journalLines: [{ accountCode: '1200', creditNgn: 30_000 }],
      productionJobs: [
        {
          status: 'Completed',
          quotationRef: 'QT-M',
          actualMeters: 5,
          completedAtISO: '2026-06-10',
        },
      ],
    });
    const aligned = classifyReceiptGlPolicyBasis({
      receipt: { quotationRef: 'QT-M', amountNgn: 20_000, dateISO: '2026-06-12' },
      journalLines: [{ accountCode: '2500', creditNgn: 20_000 }],
      productionJobs: legacy.productionPhaseAtReceipt
        ? [
            {
              status: 'Completed',
              quotationRef: 'QT-M',
              actualMeters: 5,
              completedAtISO: '2026-06-10',
            },
          ]
        : [],
    });
    const agg = sumLegacyBridgeFromReceiptClasses([legacy, aligned]);
    expect(agg.legacyBridgeNgn).toBe(30_000);
    expect(agg.policyDepositsNgn).toBe(0);
    expect(agg.mixedLegacyAndPolicyReceipt).toBe(true);
    const sim = simulateProductionRecognition({
      earnedNgn: 50_000,
      policyDepositsNgn: 20_000,
      legacyBridgeNgn: agg.legacyBridgeNgn,
      advanceAppliedNgn: 0,
    });
    expect(sim.expectedArDebitNgn).toBe(0);
  });

  it('missing data returns safe warnings and no crash', () => {
    expect(simulateReceiptCreditAccount({}).ok).toBe(false);
    expect(simulateProductionRecognition({ earnedNgn: 0 }).ok).toBe(false);
    expect(productionStatusAtReceipt('', '', [])).toBe('pre_production');
  });
});
