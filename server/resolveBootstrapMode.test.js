import { describe, expect, it } from 'vitest';
import { resolveBootstrapMode } from './bootstrap.js';

describe('resolveBootstrapMode', () => {
  it('honors explicit query modes', () => {
    expect(resolveBootstrapMode('shell', { NODE_ENV: 'production' })).toBe('shell');
    expect(resolveBootstrapMode('dashboard', { NODE_ENV: 'production' })).toBe('dashboard');
    expect(resolveBootstrapMode('full', { NODE_ENV: 'production' })).toBe('');
  });

  it('defaults to shell outside tests so login cannot rebuild the full desk dump', () => {
    expect(resolveBootstrapMode(undefined, { NODE_ENV: 'production' })).toBe('shell');
    expect(resolveBootstrapMode('', { NODE_ENV: 'development' })).toBe('shell');
  });

  it('keeps legacy full dump as the default under NODE_ENV=test', () => {
    expect(resolveBootstrapMode(undefined, { NODE_ENV: 'test' })).toBe('');
    expect(resolveBootstrapMode('', { NODE_ENV: 'test' })).toBe('');
  });

  it('honors ZAREWA_BOOTSTRAP_DEFAULT_MODE over the non-test default', () => {
    expect(
      resolveBootstrapMode(undefined, {
        NODE_ENV: 'production',
        ZAREWA_BOOTSTRAP_DEFAULT_MODE: 'full',
      })
    ).toBe('');
    expect(
      resolveBootstrapMode(undefined, {
        NODE_ENV: 'test',
        ZAREWA_BOOTSTRAP_DEFAULT_MODE: 'shell',
      })
    ).toBe('shell');
  });
});
