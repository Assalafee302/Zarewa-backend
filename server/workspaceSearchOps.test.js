import { describe, it, expect } from 'vitest';
import { escapeSqlLikePattern } from './workspaceSearchOps.js';

describe('workspaceSearchOps', () => {
  it('escapeSqlLikePattern escapes LIKE metacharacters', () => {
    expect(escapeSqlLikePattern('100%')).toBe('100\\%');
    expect(escapeSqlLikePattern('a_b')).toBe('a\\_b');
    expect(escapeSqlLikePattern('x\\y')).toBe('x\\\\y');
  });
});
