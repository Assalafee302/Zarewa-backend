import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  computePolicyV1ProductionRecognitionParts,
} from './ap1cProductionRecognition.js';

describe('ap1cProductionRecognition (pure)', () => {
  it('full pre-production deposit releases 2500 with no AR', () => {
    const r = computePolicyV1ProductionRecognitionParts({
      earnedNgn: 5_000_000,
      policyDepositNgn: 5_000_000,
      advanceAppliedNgn: 0,
      legacyBridgeNgn: 0,
      legacyBridgeEnabled: true,
    });
    expect(r.release2500Ngn).toBe(5_000_000);
    expect(r.arPartNgn).toBe(0);
  });

  it('partial pre-production deposit releases deposit and AR for balance', () => {
    const r = computePolicyV1ProductionRecognitionParts({
      earnedNgn: 5_000_000,
      policyDepositNgn: 3_000_000,
      advanceAppliedNgn: 0,
      legacyBridgeNgn: 0,
      legacyBridgeEnabled: true,
    });
    expect(r.release2500Ngn).toBe(3_000_000);
    expect(r.arPartNgn).toBe(2_000_000);
  });

  it('legacy bridge reduces AR without releasing extra 2500', () => {
    const r = computePolicyV1ProductionRecognitionParts({
      earnedNgn: 5_000_000,
      policyDepositNgn: 0,
      advanceAppliedNgn: 0,
      legacyBridgeNgn: 5_000_000,
      legacyBridgeEnabled: true,
    });
    expect(r.release2500Ngn).toBe(0);
    expect(r.legacyBridgeAppliedNgn).toBe(5_000_000);
    expect(r.arPartNgn).toBe(0);
  });

  it('mixed legacy bridge and deposit', () => {
    const r = computePolicyV1ProductionRecognitionParts({
      earnedNgn: 5_000_000,
      policyDepositNgn: 2_000_000,
      advanceAppliedNgn: 0,
      legacyBridgeNgn: 3_000_000,
      legacyBridgeEnabled: true,
    });
    expect(r.release2500Ngn).toBe(2_000_000);
    expect(r.legacyBridgeAppliedNgn).toBe(3_000_000);
    expect(r.arPartNgn).toBe(0);
  });

  it('overpayment deposit does not release more than earned', () => {
    const r = computePolicyV1ProductionRecognitionParts({
      earnedNgn: 4_000_000,
      policyDepositNgn: 5_000_000,
      advanceAppliedNgn: 0,
      legacyBridgeNgn: 0,
      legacyBridgeEnabled: false,
    });
    expect(r.release2500Ngn).toBe(4_000_000);
    expect(r.arPartNgn).toBe(0);
  });
});
