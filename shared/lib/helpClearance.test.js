import { describe, expect, it } from 'vitest';
import { formatClearanceMessage, userHasClearance } from './helpClearance.js';
import { classifyAgentRoute } from './helpAgentIntent.js';
import { detectHelpIntent, synthesizeMetaReply } from './helpSynthesize.js';

describe('helpClearance', () => {
  it('allows wildcard clearance', () => {
    expect(userHasClearance({ permissions: ['*'] }, ['finance.view'])).toBe(true);
  });

  it('formats friendly denial', () => {
    const msg = formatClearanceMessage({ topicKey: 'finance', roleKey: 'storekeeper', mode: 'live_data' });
    expect(msg).toMatch(/Clearance note/i);
    expect(msg).toMatch(/how the workflow works/i);
  });
});

describe('meta questions', () => {
  it('routes how smart are you', () => {
    expect(classifyAgentRoute('How smart are u')).toBe('meta');
    expect(detectHelpIntent('How smart are u')).toBe('meta');
  });

  it('answers honestly', () => {
    const reply = synthesizeMetaReply({ userDisplay: 'Ali', externalAiEnabled: false });
    expect(reply).toMatch(/Zarewa Help Assistant/i);
    expect(reply).toMatch(/RAG/i);
    expect(reply).toMatch(/clearance/i);
  });
});
