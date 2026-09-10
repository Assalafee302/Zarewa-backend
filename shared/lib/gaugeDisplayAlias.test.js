import { describe, expect, it } from 'vitest';
import {
  YOLA_BRANCH_ID,
  branchUsesYolaGaugeNames,
  canonicalGaugeLabelForBranchInput,
  decorateSetupGaugesForBranch,
  displayGaugeLabelForBranch,
  formatGaugeLabelMm,
  gaugeMmTokenFromLabel,
  quotationGaugeSelectOptions,
} from './gaugeDisplayAlias.js';

describe('gaugeDisplayAlias', () => {
  it('parses and formats mm tokens', () => {
    expect(gaugeMmTokenFromLabel('0.28mm')).toBe('0.28');
    expect(gaugeMmTokenFromLabel('0.28')).toBe('0.28');
    expect(formatGaugeLabelMm('0.28')).toBe('0.28mm');
    expect(formatGaugeLabelMm('0.35mm')).toBe('0.35mm');
  });

  it('Kaduna keeps canonical labels', () => {
    expect(branchUsesYolaGaugeNames('BR-KD')).toBe(false);
    expect(displayGaugeLabelForBranch('BR-KD', '0.28mm')).toBe('0.28mm');
    expect(canonicalGaugeLabelForBranchInput('BR-KD', '0.35mm')).toBe('0.35mm');
    expect(canonicalGaugeLabelForBranchInput('BR-KD', '0.28')).toBe('0.28mm');
  });

  it('Yola maps trade names ↔ true gauges', () => {
    expect(branchUsesYolaGaugeNames(YOLA_BRANCH_ID)).toBe(true);
    expect(displayGaugeLabelForBranch('BR-YL', '0.28mm')).toBe('0.35mm');
    expect(displayGaugeLabelForBranch('BR-YL', '0.24mm')).toBe('0.30mm');
    expect(displayGaugeLabelForBranch('BR-YL', '0.22mm')).toBe('0.22mm');
    expect(displayGaugeLabelForBranch('BR-YL', '0.20mm')).toBe('0.20mm');
    expect(displayGaugeLabelForBranch('BR-YL', '0.18mm')).toBe('0.18mm');

    expect(canonicalGaugeLabelForBranchInput('BR-YL', '0.35')).toBe('0.28mm');
    expect(canonicalGaugeLabelForBranchInput('BR-YL', '0.35mm')).toBe('0.28mm');
    expect(canonicalGaugeLabelForBranchInput('BR-YL', '0.30')).toBe('0.24mm');
    expect(canonicalGaugeLabelForBranchInput('BR-YL', '0.30mm')).toBe('0.24mm');
    expect(canonicalGaugeLabelForBranchInput('BR-YL', '0.28mm')).toBe('0.28mm');
    expect(canonicalGaugeLabelForBranchInput('BR-YL', '0.22')).toBe('0.22mm');
  });

  it('decorates setup gauges and hides colliding Yola options', () => {
    const gauges = [
      { id: 'GAU-003', label: '0.24mm', gaugeMm: 0.24, active: true },
      { id: 'GAU-004', label: '0.28mm', gaugeMm: 0.28, active: true },
      { id: 'GAU-005', label: '0.30mm', gaugeMm: 0.3, active: true },
      { id: 'GAU-011', label: '0.35mm', gaugeMm: 0.35, active: true },
      { id: 'GAU-002', label: '0.22mm', gaugeMm: 0.22, active: true },
    ];
    const decorated = decorateSetupGaugesForBranch(gauges, 'BR-YL');
    expect(decorated.find((g) => g.id === 'GAU-004')).toMatchObject({
      label: '0.28mm',
      displayLabel: '0.35mm',
      quotationOption: true,
    });
    expect(decorated.find((g) => g.id === 'GAU-003')).toMatchObject({
      label: '0.24mm',
      displayLabel: '0.30mm',
      quotationOption: true,
    });
    expect(decorated.find((g) => g.id === 'GAU-011')?.quotationOption).toBe(false);
    expect(decorated.find((g) => g.id === 'GAU-005')?.quotationOption).toBe(false);

    const kd = decorateSetupGaugesForBranch(gauges, 'BR-KD');
    expect(kd.every((g) => g.displayLabel === g.label && g.quotationOption)).toBe(true);

    const opts = quotationGaugeSelectOptions(gauges, 'BR-YL');
    expect(opts.map((o) => o.label)).toEqual(['0.30mm', '0.35mm', '0.22mm']);
    expect(opts.map((o) => o.value)).toEqual(['0.24mm', '0.28mm', '0.22mm']);
  });
});
