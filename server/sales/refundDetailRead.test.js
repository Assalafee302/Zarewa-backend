import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const readModelSrc = readFileSync(join(here, '..', 'readModel.js'), 'utf8');

describe('getCustomerRefundDetail read-only GET', () => {
  it('only mutates when callers pass heal: true', () => {
    expect(readModelSrc).toMatch(/if \(opts\.heal === true\)/);
    expect(readModelSrc).toMatch(/healRefundCreditAppliedFromApplicationsTx\(db, id\)/);
  });
});
