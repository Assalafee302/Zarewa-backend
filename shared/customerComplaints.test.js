import { describe, expect, it } from 'vitest';
import {
  COMPLAINT_CHANNELS,
  COMPLAINT_CHANNEL_LABELS,
  complaintLabel,
} from './customerComplaints.js';

describe('customerComplaints', () => {
  it('includes delivery as a channel with a label', () => {
    expect(COMPLAINT_CHANNELS).toContain('delivery');
    expect(COMPLAINT_CHANNEL_LABELS.delivery).toBe('Delivery');
  });

  it('maps enum keys to labels', () => {
    expect(complaintLabel(COMPLAINT_CHANNEL_LABELS, 'in_person')).toBe('In person');
    expect(complaintLabel(COMPLAINT_CHANNEL_LABELS, 'In Person')).toBe('In person');
    expect(complaintLabel(COMPLAINT_CHANNEL_LABELS, '')).toBe('—');
  });
});
