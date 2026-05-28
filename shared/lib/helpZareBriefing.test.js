import { describe, expect, it } from 'vitest';
import { buildZareDailyBriefing, formatZareBriefingReply } from './helpZareBriefing.js';

describe('helpZareBriefing', () => {
  it('builds safe count lines', () => {
    const lines = buildZareDailyBriefing(
      {
        unifiedWorkItems: [
          { requiresApproval: true, status: 'pending' },
          { requiresResponse: true, slaState: 'overdue', isOverdue: true },
        ],
        officeSummary: { unreadApprox: 2 },
      },
      'finance_manager'
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => /action/i.test(l))).toBe(true);
  });

  it('formats briefing reply', () => {
    const text = formatZareBriefingReply(['3 items require your action.']);
    expect(text).toMatch(/Today's briefing/i);
    expect(text).toMatch(/3 items/);
  });
});
