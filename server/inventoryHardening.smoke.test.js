/**
 * Lightweight tests for inventory hardening helpers (no sqlite required).
 */
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_MOVEMENT_TYPES,
  isInventoryMovementType,
  THIN_COIL_KG_THRESHOLD,
  STOCK_VARIANCE_THRESHOLDS,
} from '../shared/lib/inventoryMovementTypes.js';

describe('inventoryMovementTypes', () => {
  it('recognises core inventory types and rejects noise', () => {
    expect(isInventoryMovementType('ADJUSTMENT')).toBe(true);
    expect(isInventoryMovementType('STORE_GRN')).toBe(true);
    expect(isInventoryMovementType('CUSTOMER_DELIVERY')).toBe(true);
    expect(isInventoryMovementType('PO_CREATED')).toBe(false);
    expect(isInventoryMovementType('')).toBe(false);
    expect(isInventoryMovementType(null)).toBe(false);
  });

  it('exposes stable thin-coil and variance defaults', () => {
    expect(THIN_COIL_KG_THRESHOLD).toBe(85);
    expect(STOCK_VARIANCE_THRESHOLDS.coilKg).toBeCloseTo(0.01);
    expect(INVENTORY_MOVEMENT_TYPES.length).toBeGreaterThan(5);
  });
});
