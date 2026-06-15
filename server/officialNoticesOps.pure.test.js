import { describe, it, expect } from 'vitest';
import { canManageNotices } from './officialNoticesOps.js';
import { canCreateCompanyForumTopic } from './forumOps.js';

describe('official notices and forum permission gates (pure)', () => {
  it('denies settings.view-only users for notices', () => {
    expect(canManageNotices({ roleKey: 'viewer', permissions: ['settings.view'] })).toBe(false);
  });

  it('allows senior roles and notices.manage', () => {
    expect(canManageNotices({ roleKey: 'gmhr', permissions: [] })).toBe(true);
    expect(canManageNotices({ roleKey: 'hr_staff', permissions: ['notices.manage'] })).toBe(true);
  });

  it('denies settings.view for company forum', () => {
    expect(canCreateCompanyForumTopic({ roleKey: 'viewer', permissions: ['settings.view'] })).toBe(false);
  });

  it('allows MD for company forum', () => {
    expect(canCreateCompanyForumTopic({ roleKey: 'md', permissions: [] })).toBe(true);
  });
});
