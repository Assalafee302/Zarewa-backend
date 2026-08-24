import { describe, expect, it } from 'vitest';
import {
  buildTransitDisplayRows,
  poLinesFullyReceived,
  shouldShowPoInTransit,
} from './inTransitVisibility.js';

describe('inTransitVisibility', () => {
  it('hides PO when lines are fully received even if status is still In Transit', () => {
    const po = {
      poID: 'PO-KD-26-00012',
      status: 'In Transit',
      supplierName: 'Test Sup',
      lines: [{ productID: 'COIL-ALU', qtyOrdered: 1000, qtyReceived: 1000 }],
    };
    expect(shouldShowPoInTransit(po)).toBe(false);
    expect(buildTransitDisplayRows({ purchaseOrders: [po], inTransitLoads: [] })).toHaveLength(0);
  });

  it('shows PO while receipt lines remain open', () => {
    const po = {
      poID: 'PO-KD-26-00013',
      status: 'In Transit',
      supplierName: 'Test Sup',
      lines: [{ productID: 'COIL-ALU', qtyOrdered: 1000, qtyReceived: 0 }],
    };
    expect(shouldShowPoInTransit(po)).toBe(true);
    expect(buildTransitDisplayRows({ purchaseOrders: [po], inTransitLoads: [] })).toHaveLength(1);
  });

  it('hides PO from receiving after a short coil GRN', () => {
    const po = {
      poID: 'PO-KD-26-00014',
      status: 'In Transit',
      supplierName: 'Test Sup',
      lines: [{ productID: 'COIL-ALU', qtyOrdered: 5000, qtyReceived: 4800 }],
    };
    expect(shouldShowPoInTransit(po)).toBe(false);
  });

  it('treats coil short-land within tolerance as fully received', () => {
    const lines = [{ productID: 'COIL-ALU', qtyOrdered: 3140, qtyReceived: 3100 }];
    expect(poLinesFullyReceived(lines)).toBe(true);
  });

  it('drops closed in-transit load when linked PO is fully received', () => {
    const po = {
      poID: 'PO-KD-26-00012',
      status: 'In Transit',
      supplierName: 'Test Sup',
      lines: [{ productID: 'COIL-ALU', qtyOrdered: 1000, qtyReceived: 1000 }],
    };
    const rows = buildTransitDisplayRows({
      purchaseOrders: [po],
      inTransitLoads: [
        {
          id: 'MT-1',
          purchaseOrderId: 'PO-KD-26-00012',
          status: 'in_transit',
          transportAgentName: 'Haulier',
        },
      ],
    });
    expect(rows).toHaveLength(0);
  });
});
