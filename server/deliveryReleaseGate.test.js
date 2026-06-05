import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  deliveryGateShouldBlockMutation,
  readDeliveryPaymentGateMode,
} from './deliveryReleaseGate.js';

describe('deliveryReleaseGate', () => {
  const prev = {};

  beforeEach(() => {
    prev.DELIVERY_PAYMENT_GATE = process.env.DELIVERY_PAYMENT_GATE;
    delete process.env.DELIVERY_PAYMENT_GATE;
  });

  afterEach(() => {
    if (prev.DELIVERY_PAYMENT_GATE === undefined) delete process.env.DELIVERY_PAYMENT_GATE;
    else process.env.DELIVERY_PAYMENT_GATE = prev.DELIVERY_PAYMENT_GATE;
  });

  it('readDeliveryPaymentGateMode defaults to off', () => {
    expect(readDeliveryPaymentGateMode()).toBe('off');
  });

  it('readDeliveryPaymentGateMode warn for 1', () => {
    process.env.DELIVERY_PAYMENT_GATE = '1';
    expect(readDeliveryPaymentGateMode()).toBe('warn');
  });

  it('readDeliveryPaymentGateMode enforce', () => {
    process.env.DELIVERY_PAYMENT_GATE = 'enforce';
    expect(readDeliveryPaymentGateMode()).toBe('enforce');
  });

  it('deliveryGateShouldBlockMutation only in enforce mode', () => {
    expect(
      deliveryGateShouldBlockMutation({ mode: 'warn', wouldBlock: true })
    ).toBe(false);
    expect(
      deliveryGateShouldBlockMutation({ mode: 'enforce', wouldBlock: true })
    ).toBe(true);
    expect(
      deliveryGateShouldBlockMutation({ mode: 'enforce', wouldBlock: true, mdOverride: true })
    ).toBe(false);
  });
});
