import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  validatePriceListEffectiveIso,
  upsertPriceListItem,
  findDuplicatePriceListItem,
  priceListItemsToCsv,
  listPriceListItems,
} from './pricingOps.js';

describe('pricingOps', () => {
  let db;
  /** Seeded admin satisfies audit_log.actor_user_id FK */
  let actor;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const row = db.prepare(`SELECT id FROM app_users WHERE username = 'admin' LIMIT 1`).get();
    actor = { id: row?.id ?? 'admin', displayName: 'Admin' };
  });

  afterEach(() => {
    db?.close();
  });

  it('validatePriceListEffectiveIso accepts YYYY-MM-DD', () => {
    expect(validatePriceListEffectiveIso('2026-04-07').ok).toBe(true);
    expect(validatePriceListEffectiveIso('2026-04-07').iso).toBe('2026-04-07');
  });

  it('validatePriceListEffectiveIso rejects invalid calendar dates', () => {
    expect(validatePriceListEffectiveIso('2026-02-30').ok).toBe(false);
    expect(validatePriceListEffectiveIso('not-a-date').ok).toBe(false);
  });

  it('upsertPriceListItem rejects duplicate composite key', () => {
    const a = upsertPriceListItem(
      db,
      {
        gaugeKey: '0.45mm',
        designKey: 'longspan',
        unitPricePerMeterNgn: 3000,
        effectiveFromIso: '2026-01-15',
      },
      actor
    );
    expect(a.ok).toBe(true);
    const b = upsertPriceListItem(
      db,
      {
        gaugeKey: '0.45mm',
        designKey: 'longspan',
        unitPricePerMeterNgn: 3100,
        effectiveFromIso: '2026-01-15',
      },
      actor
    );
    expect(b.ok).toBe(false);
    expect(b.code).toBe('DUPLICATE');
  });

  it('upsertPriceListItem allows same gauge/design with different effective dates', () => {
    expect(
      upsertPriceListItem(
        db,
        { gaugeKey: '0.40mm', designKey: 'hmb', unitPricePerMeterNgn: 2000, effectiveFromIso: '2026-01-01' },
        actor
      ).ok
    ).toBe(true);
    expect(
      upsertPriceListItem(
        db,
        { gaugeKey: '0.40mm', designKey: 'hmb', unitPricePerMeterNgn: 2100, effectiveFromIso: '2026-06-01' },
        actor
      ).ok
    ).toBe(true);
  });

  it('findDuplicatePriceListItem distinguishes optional scope keys', () => {
    upsertPriceListItem(
      db,
      {
        gaugeKey: '0.45mm',
        designKey: 'milano',
        unitPricePerMeterNgn: 4000,
        effectiveFromIso: '2026-03-01',
        materialTypeKey: 'mat-005',
      },
      actor
    );
    const dup = findDuplicatePriceListItem(
      db,
      {
        gaugeKey: '0.45mm',
        designKey: 'milano',
        branchId: null,
        effectiveFromIso: '2026-03-01',
        materialTypeKey: 'mat-005',
        colourKey: '',
        profileKey: '',
      },
      null
    );
    expect(dup?.id).toBeTruthy();
  });

  it('priceListItemsToCsv includes header row', () => {
    upsertPriceListItem(db, { gaugeKey: '0.2mm', designKey: 'x', unitPricePerMeterNgn: 1000 }, actor);
    const csv = priceListItemsToCsv(listPriceListItems(db));
    expect(csv.split('\n')[0]).toContain('gauge_key');
    expect(csv).toContain('0.2mm');
  });
});
