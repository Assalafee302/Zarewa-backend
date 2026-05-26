import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversionReasonOptionsForBand,
  validateConversionVarianceReason,
} from './productionConversionReasons.js';

test('conversionReasonOptionsForBand returns band-specific presets plus common', () => {
  const high = conversionReasonOptionsForBand('High');
  assert.ok(high.some((o) => o.code === 'small_meter'));
  assert.ok(high.some((o) => o.code === 'other'));
  assert.ok(high.some((o) => o.code === 'unsure'));
  assert.ok(!high.some((o) => o.code === 'long_meter'));

  const low = conversionReasonOptionsForBand('Low');
  assert.ok(low.some((o) => o.code === 'long_meter'));
  assert.ok(!low.some((o) => o.code === 'small_meter'));
});

test('validateConversionVarianceReason requires code for High/Low only', () => {
  assert.equal(validateConversionVarianceReason({}, 'OK').ok, true);
  assert.equal(validateConversionVarianceReason({}, 'High').ok, false);
  assert.equal(
    validateConversionVarianceReason({ conversionVarianceReasonCode: 'unsure' }, 'High').ok,
    true
  );
  assert.equal(
    validateConversionVarianceReason({ conversionVarianceReasonCode: 'long_meter' }, 'High').ok,
    false
  );
  assert.equal(
    validateConversionVarianceReason({ conversionVarianceReasonCode: 'other' }, 'Low').ok,
    false
  );
  assert.equal(
    validateConversionVarianceReason(
      { conversionVarianceReasonCode: 'other', conversionVarianceReasonText: 'Scale drift on bay 2' },
      'Low'
    ).ok,
    true
  );
});
