import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DEPLOYED_COMMIT, PROCESS_STARTED_AT_ISO } from './deployedCommit.js';

describe('deployedCommit', () => {
  it('never throws and never reports an empty commit', () => {
    // The health probe imports this at boot. A throw here would take the API down for
    // a diagnostic field, which would be a worse failure than the one it reports on.
    expect(typeof DEPLOYED_COMMIT).toBe('string');
    expect(DEPLOYED_COMMIT.length).toBeGreaterThan(0);
  });

  it('is a short sha, or the honest string "unknown"', () => {
    expect(DEPLOYED_COMMIT).toMatch(/^(unknown|[0-9a-f]{7,12})$/);
  });

  it('matches what git reports for this checkout', () => {
    let head = '';
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      return; // no git binary or not a checkout — the fallback cases cover it
    }
    expect(DEPLOYED_COMMIT).toBe(head.slice(0, 12));
  });

  it('reports a parseable start time', () => {
    expect(Number.isNaN(Date.parse(PROCESS_STARTED_AT_ISO))).toBe(false);
  });
});
