import { describe, expect, it } from 'vitest';
import {
  namesLookSuspicious,
  normalizeStaffAccountKey,
  normalizeStaffBvnKey,
  normalizeStaffEmailKey,
  normalizeStaffNinKey,
  normalizeStaffPhoneKey,
} from './hrStaffIdentity.js';

describe('hrStaffIdentity', () => {
  it('treats local and +234 phones as the same person', () => {
    expect(normalizeStaffPhoneKey('0803 123 4567')).toBe('8031234567');
    expect(normalizeStaffPhoneKey('+2348031234567')).toBe('8031234567');
    expect(normalizeStaffPhoneKey('2348031234567')).toBe('8031234567');
  });

  it('requires a full NIN / BVN', () => {
    expect(normalizeStaffNinKey('12345678901')).toBe('12345678901');
    expect(normalizeStaffNinKey('12345')).toBe('');
    expect(normalizeStaffBvnKey('222 333 444 55')).toBe('22233344455');
  });

  it('normalizes email and account digits', () => {
    expect(normalizeStaffEmailKey('  Ada@Zarewa.ng ')).toBe('ada@zarewa.ng');
    expect(normalizeStaffAccountKey('0123-4567-89')).toBe('0123456789');
    expect(normalizeStaffAccountKey('12')).toBe('');
  });

  it('flags exact, reordered, and close names, not unrelated ones', () => {
    expect(namesLookSuspicious('Musa Ibrahim', 'musa ibrahim')?.reason).toBe('exact');
    expect(namesLookSuspicious('Musa Ibrahim', 'Ibrahim Musa')?.reason).toBe('same_tokens');
    expect(namesLookSuspicious('Musa Ibrahim', 'Musa Ibrahim Sani')?.reason).toBe('shared_name_parts');
    expect(namesLookSuspicious('Amina Bello', 'Amina Belloo')?.reason).toBe('similar');
    expect(namesLookSuspicious('Musa Ibrahim', 'Fatima Sani')).toBeNull();
    expect(namesLookSuspicious('John', 'John')).toBeNull();
  });
});
