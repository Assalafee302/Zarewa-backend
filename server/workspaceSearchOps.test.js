import { describe, it, expect } from 'vitest';
import { escapeSqlLikePattern } from './workspaceSearchOps.js';
import { toFts5MatchQuery } from './workspaceSearchFts.js';
import { mergeWorkspaceSearchResults, scoreWorkspaceSearchMatch } from '../shared/lib/workspaceSearchCore.js';

describe('workspaceSearchOps', () => {
  it('escapeSqlLikePattern escapes LIKE metacharacters', () => {
    expect(escapeSqlLikePattern('100%')).toBe('100\\%');
    expect(escapeSqlLikePattern('a_b')).toBe('a\\_b');
    expect(escapeSqlLikePattern('x\\y')).toBe('x\\\\y');
  });

  it('scoreWorkspaceSearchMatch ranks exact IDs highest', () => {
    expect(scoreWorkspaceSearchMatch('QT-1', 'QT-1')).toBeGreaterThan(scoreWorkspaceSearchMatch('QT-1', 'QT-100'));
  });

  it('mergeWorkspaceSearchResults keeps diversity across kinds', () => {
    const merged = mergeWorkspaceSearchResults(
      {
        customer: [{ kind: 'customer', id: '1', label: 'A', path: '/', _score: 900 }],
        nav: [{ kind: 'nav', id: 'nav-sales', label: 'Sales', path: '/sales', _score: 800 }],
      },
      { totalCap: 4, minPerKind: 1 }
    );
    expect(merged.some((r) => r.kind === 'nav')).toBe(true);
    expect(merged.some((r) => r.kind === 'customer')).toBe(true);
  });

  it('toFts5MatchQuery escapes unsafe FTS tokens', () => {
    expect(toFts5MatchQuery('musa')).toBe('"musa"*');
    expect(toFts5MatchQuery('a')).toBe(null);
  });
});
