import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { bootSeedEnabled } from './bootSeedPolicy.js';

describe('bootSeedPolicy', () => {
  const prev = {};

  beforeEach(() => {
    for (const k of ['NODE_ENV', 'ZAREWA_SKIP_BOOT_SEED', 'ZAREWA_FORCE_BOOT_SEED']) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it('disables boot seed in production by default', () => {
    process.env.NODE_ENV = 'production';
    expect(bootSeedEnabled()).toBe(false);
  });

  it('allows boot seed in development', () => {
    process.env.NODE_ENV = 'development';
    expect(bootSeedEnabled()).toBe(true);
  });
});
