import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateNextEmployeeNumber,
  formatStaffEmployeeNumber,
  employeeNumberToUsername,
  getDefaultStaffNumberConfig,
  isReservedEmployeeNumber,
  normalizeEmployeeNumberForSave,
  normalizeStaffNumberConfig,
  parseEmployeeNumberNumeric,
  parseEmployeeNumberParts,
  resolveEmployeeBranchCode,
} from './hrEmployeeNumber.js';

test('formatStaffEmployeeNumber uses ZAP branch codes by default', () => {
  const cfg = getDefaultStaffNumberConfig();
  assert.equal(formatStaffEmployeeNumber(cfg, 1, { branchCode: 'KD' }), 'ZAPKD001');
  assert.equal(formatStaffEmployeeNumber(cfg, 2, { branchCode: 'YL' }), 'ZAPYL002');
  assert.equal(formatStaffEmployeeNumber(cfg, 6, { branchCode: 'KD' }), 'ZAPKD006');
});

test('employeeNumberToUsername lowercases staff IDs for login', () => {
  assert.equal(employeeNumberToUsername('ZAPKD001'), 'zapkd001');
  assert.equal(employeeNumberToUsername(''), '');
  assert.equal(employeeNumberToUsername('', 4), 'staff.r4');
});

test('normalizeEmployeeNumberForSave coerces branch numbers', () => {
  const cfg = getDefaultStaffNumberConfig();
  assert.equal(normalizeEmployeeNumberForSave('2', cfg, { branchCode: 'YL' }), 'ZAPYL002');
  assert.equal(normalizeEmployeeNumberForSave('002', cfg, { branchCode: 'YL' }), 'ZAPYL002');
  assert.equal(normalizeEmployeeNumberForSave('YL002', cfg, { branchCode: 'YL' }), 'ZAPYL002');
  assert.equal(normalizeEmployeeNumberForSave('ZAPKD006', cfg, { branchCode: 'KD' }), 'ZAPKD006');
  assert.equal(normalizeEmployeeNumberForSave('EMP001', cfg, { branchCode: 'KD' }), 'ZAPKD001');
  assert.equal(normalizeEmployeeNumberForSave('ZAP001', cfg, { branchCode: 'KD' }), 'ZAPKD001');
  assert.equal(normalizeEmployeeNumberForSave('ZAPZAPKD001', cfg, { branchCode: 'KD' }), 'ZAPKD001');
  assert.equal(normalizeEmployeeNumberForSave('ZAPEMP001', cfg, { branchCode: 'KD' }), 'ZAPKD001');
});

test('normalizeEmployeeNumberForSave keeps unrelated legacy IDs', () => {
  const cfg = getDefaultStaffNumberConfig();
  assert.equal(normalizeEmployeeNumberForSave('KD-001', cfg, { branchCode: 'KD' }), 'KD-001');
});

test('isReservedEmployeeNumber matches executive slots on HQ branch', () => {
  const cfg = getDefaultStaffNumberConfig();
  assert.equal(isReservedEmployeeNumber('ZAPKD001', cfg), true);
  assert.equal(isReservedEmployeeNumber('ZAPYL001', cfg), false);
  assert.equal(isReservedEmployeeNumber('ZAPKD006', cfg), false);
});

test('allocateNextEmployeeNumber is per-branch', () => {
  const db = {
    prepare() {
      return {
        all: () => [{ employeeNo: 'ZAPKD005' }, { employeeNo: 'ZAPYL001' }],
        get: () => null,
      };
    },
  };
  const cfg = normalizeStaffNumberConfig(getDefaultStaffNumberConfig());
  assert.equal(allocateNextEmployeeNumber(db, cfg, { branchCode: 'KD' }), 'ZAPKD006');
  assert.equal(allocateNextEmployeeNumber(db, cfg, { branchCode: 'YL' }), 'ZAPYL002');
});

test('parseEmployeeNumberParts reads ZAP branch IDs', () => {
  const cfg = getDefaultStaffNumberConfig();
  assert.deepEqual(parseEmployeeNumberParts('ZAPYL002', cfg), {
    companyPrefix: 'ZAP',
    branchCode: 'YL',
    numeric: 2,
  });
  assert.equal(parseEmployeeNumberNumeric('ZAPKD010', cfg), 10);
});

test('resolveEmployeeBranchCode maps branch ids', () => {
  assert.equal(resolveEmployeeBranchCode(null, 'BR-YL'), 'YL');
  assert.equal(resolveEmployeeBranchCode(null, 'BR-KD'), 'KD');
});

test('fresh branch starts at 001 except executive HQ branch', () => {
  const db = { prepare: () => ({ all: () => [], get: () => null }) };
  const cfg = getDefaultStaffNumberConfig();
  assert.equal(allocateNextEmployeeNumber(db, cfg, { branchCode: 'YL' }), 'ZAPYL001');
  assert.equal(allocateNextEmployeeNumber(db, cfg, { branchCode: 'KD' }), 'ZAPKD006');
});
