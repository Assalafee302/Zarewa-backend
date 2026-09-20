import { describe, expect, it, afterEach } from 'vitest';
import {
  workspaceProductBootstrap,
  workspaceRoomsEnabled,
  workspaceRoomsHealthCapability,
} from './chatFlags.js';

describe('workspace chat flags', () => {
  const prev = process.env.ZAREWA_WORKSPACE_ROOMS_ENABLED;

  afterEach(() => {
    if (prev === undefined) delete process.env.ZAREWA_WORKSPACE_ROOMS_ENABLED;
    else process.env.ZAREWA_WORKSPACE_ROOMS_ENABLED = prev;
  });

  it('defaults off so unused rooms/presence/SSE stay dark', () => {
    delete process.env.ZAREWA_WORKSPACE_ROOMS_ENABLED;
    expect(workspaceRoomsEnabled()).toBe(false);
    expect(workspaceProductBootstrap()).toEqual({ roomsEnabled: false });
    expect(workspaceRoomsHealthCapability()).toBe(false);
  });

  it('treats 0 / false / off as disabled', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      expect(workspaceRoomsEnabled({ ZAREWA_WORKSPACE_ROOMS_ENABLED: v })).toBe(false);
    }
  });

  it('treats 1 / true / yes / on as enabled', () => {
    for (const v of ['1', 'true', 'yes', 'on']) {
      expect(workspaceRoomsEnabled({ ZAREWA_WORKSPACE_ROOMS_ENABLED: v })).toBe(true);
    }
  });
});
