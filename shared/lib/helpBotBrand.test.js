import { describe, expect, it } from 'vitest';
import { HELP_BOT_NAME, HELP_BOT_TAGLINE } from './helpBotBrand.js';

describe('helpBotBrand', () => {
  it('uses Zare user-facing identity', () => {
    expect(HELP_BOT_NAME).toBe('Zare');
    expect(HELP_BOT_TAGLINE).toMatch(/guide|SOP/i);
  });
});
