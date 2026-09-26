import { describe, expect, it } from 'vitest';
import {
  matchesCorrugationService,
  matchesInstallationService,
  matchesTransportService,
  quotedServiceAssigneeRole,
} from './refundQuotedServiceKind.js';

describe('refundQuotedServiceKind', () => {
  it('treats labour as installation, separate from transport', () => {
    expect(matchesInstallationService('labour')).toBe(true);
    expect(matchesInstallationService('Labor')).toBe(true);
    expect(matchesInstallationService('Roofing labour')).toBe(true);
    expect(matchesInstallationService('Installation')).toBe(true);
    expect(matchesTransportService('labour')).toBe(false);
    expect(matchesInstallationService('laboratory fee')).toBe(false);
  });

  it('keeps transport names on the driver path', () => {
    expect(matchesTransportService('Transportation')).toBe(true);
    expect(quotedServiceAssigneeRole('Transportation')).toBe('driver');
    expect(quotedServiceAssigneeRole('Labour')).toBe('installer');
    expect(quotedServiceAssigneeRole('Installation')).toBe('installer');
  });

  it('still excludes corrugation', () => {
    expect(matchesCorrugationService('Corrugation')).toBe(true);
    expect(matchesInstallationService('Corrugation')).toBe(false);
  });
});
