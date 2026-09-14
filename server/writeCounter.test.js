import { describe, it, expect, afterEach } from 'vitest';
import { noteWrite, writeSequence, writeCounterTrusted } from './writeCounter.js';

const ORIGINAL = process.env.ZAREWA_BOOTSTRAP_TRUST_WRITE_COUNTER;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ZAREWA_BOOTSTRAP_TRUST_WRITE_COUNTER;
  else process.env.ZAREWA_BOOTSTRAP_TRUST_WRITE_COUNTER = ORIGINAL;
});

describe('write counter', () => {
  it('is stable across reads and advances on every write', () => {
    const before = writeSequence();
    expect(writeSequence()).toBe(before);
    noteWrite();
    expect(writeSequence()).toBe(before + 1);
    noteWrite();
    expect(writeSequence()).toBe(before + 2);
  });

  it('never goes backwards', () => {
    let last = writeSequence();
    for (let i = 0; i < 50; i += 1) {
      noteWrite();
      const now = writeSequence();
      expect(now).toBeGreaterThan(last);
      last = now;
    }
  });
});

describe('writeCounterTrusted', () => {
  it('defaults to trusting the counter', () => {
    delete process.env.ZAREWA_BOOTSTRAP_TRUST_WRITE_COUNTER;
    expect(writeCounterTrusted()).toBe(true);
  });

  it('can be switched off for deployments with out-of-band writes', () => {
    for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
      process.env.ZAREWA_BOOTSTRAP_TRUST_WRITE_COUNTER = off;
      expect(writeCounterTrusted()).toBe(false);
    }
    for (const on of ['1', 'true', 'yes']) {
      process.env.ZAREWA_BOOTSTRAP_TRUST_WRITE_COUNTER = on;
      expect(writeCounterTrusted()).toBe(true);
    }
  });
});
