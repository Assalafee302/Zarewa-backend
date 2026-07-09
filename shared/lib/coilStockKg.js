/** GRN received kg for a coil lot (book figure, not live on-hand). */
export function coilReceivedKg(lot) {
  if (!lot || typeof lot !== 'object') return 0;
  const w = Number(lot.weightKg ?? lot.weight_kg);
  if (Number.isFinite(w) && w > 0) return w;
  const q = Number(lot.qtyReceived ?? lot.qty_received);
  return Number.isFinite(q) ? Math.max(0, q) : 0;
}

/**
 * On-hand kg for a coil lot (live book, not GRN-only).
 * When qty_remaining / current_weight_kg are explicitly zero (consumed coil), returns 0 —
 * do not fall back to GRN weight (that made consumed coils look fully in stock).
 */
export function coilOnHandKg(lot) {
  if (!lot || typeof lot !== 'object') return 0;
  const cwRaw = lot.currentWeightKg ?? lot.current_weight_kg;
  const qrRaw = lot.qtyRemaining ?? lot.qty_remaining;
  const hasCw = cwRaw != null && cwRaw !== '' && Number.isFinite(Number(cwRaw));
  const hasQr = qrRaw != null && qrRaw !== '' && Number.isFinite(Number(qrRaw));
  if (hasCw) return Math.max(0, Number(cwRaw));
  if (hasQr) return Math.max(0, Number(qrRaw));
  const w = Number(lot.weightKg ?? lot.weight_kg);
  if (Number.isFinite(w) && w > 0) return w;
  const q = Number(lot.qtyReceived ?? lot.qty_received);
  return Number.isFinite(q) ? Math.max(0, q) : 0;
}

/** Kg consumed off the coil: GRN received minus current on-hand (includes production, scrap, net of returns). */
export function coilKgUsed(lot) {
  return Math.max(0, coilReceivedKg(lot) - coilOnHandKg(lot));
}

/** kg available on roll: on-hand minus reservations (same as production register). */
export function coilFreeKg(lot, addBackKg = 0) {
  return Math.max(0, coilOnHandKg(lot) - Number(lot?.qtyReserved ?? lot?.qty_reserved ?? 0) + (Number(addBackKg) || 0));
}
