import { describe, expect, it } from 'vitest';
import {
  conversionReasonOptionsForBand,
  validateConversionVarianceReason,
} from './productionConversionReasons.js';

describe('productionConversionReasons', () => {
  it('returns band-specific presets plus common', () => {
    const high = conversionReasonOptionsForBand('High');
    expect(high.some((o) => o.code === 'small_meter')).toBe(true);
    expect(high.some((o) => o.code === 'other')).toBe(true);
    expect(high.some((o) => o.code === 'unsure')).toBe(true);
    expect(high.some((o) => o.code === 'long_meter')).toBe(false);

    const low = conversionReasonOptionsForBand('Low');
    expect(low.some((o) => o.code === 'long_meter')).toBe(true);
    expect(low.some((o) => o.code === 'small_meter')).toBe(false);
  });

  it('requires a valid code for High/Low only', () => {
    expect(validateConversionVarianceReason({}, 'OK').ok).toBe(true);
    expect(validateConversionVarianceReason({}, 'High').ok).toBe(false);
    expect(validateConversionVarianceReason({ conversionVarianceReasonCode: 'unsure' }, 'High').ok).toBe(true);
    expect(validateConversionVarianceReason({ conversionVarianceReasonCode: 'long_meter' }, 'High').ok).toBe(false);
    expect(validateConversionVarianceReason({ conversionVarianceReasonCode: 'other' }, 'Low').ok).toBe(false);
    expect(
      validateConversionVarianceReason(
        { conversionVarianceReasonCode: 'other', conversionVarianceReasonText: 'Scale drift on bay 2' },
        'Low'
      ).ok
    ).toBe(true);
  });
});
