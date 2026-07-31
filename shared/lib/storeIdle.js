/**
 * Coil idle / last-used bands for store desk (warn 60d · critical 90d).
 * Shared by frontend Operations desk and workspace notifications.
 */

export const IDLE_WARN_DAYS = 60;
export const IDLE_CRITICAL_DAYS = 90;
export const IDLE_CLEAR_NOW_MAX = 3;

/** Movement types that count as “used” (not receipt). */
const USE_TYPES = new Set([
  'COIL_CONSUMPTION',
  'PRODUCTION',
  'FINISHED_GOODS',
  'SCRAP',
  'COIL_SCRAP',
  'FINISH_ROLL',
  'MATERIAL_INCIDENT',
  'RETURN_OUTWARD',
  'ADJUSTMENT',
  'STOCK_ADJUST',
]);

function toIsoDay(value) {
  const s = String(value || '').trim();
  return s ? s.slice(0, 10) : '';
}

function daysBetween(isoDay, asOfISO) {
  const a = toIsoDay(isoDay);
  const b = toIsoDay(asOfISO) || toIsoDay(new Date().toISOString());
  if (!a || !b) return null;
  const t0 = Date.parse(`${a}T12:00:00Z`);
  const t1 = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return Math.max(0, Math.round((t1 - t0) / 86400000));
}

/**
 * @param {string|null|undefined} lastUsedISO
 * @param {string} [asOfISO]
 * @returns {'ok'|'warn'|'critical'|null}
 */
export function idleBandForLastUsed(lastUsedISO, asOfISO) {
  const days = daysBetween(lastUsedISO, asOfISO);
  if (days == null) return null;
  if (days >= IDLE_CRITICAL_DAYS) return 'critical';
  if (days >= IDLE_WARN_DAYS) return 'warn';
  return 'ok';
}

/**
 * Build coilNo → latest use ISO from workspace movements.
 * @param {object[]} movements
 * @returns {Map<string, string>}
 */
export function buildLastUsedByCoilNo(movements) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const m of movements || []) {
    const type = String(m.type || '').toUpperCase();
    if (type.includes('GRN') || type === 'RECEIPT' || type === 'STORE_RECEIPT') continue;
    if (type && !USE_TYPES.has(type)) continue;

    const day = toIsoDay(m.atISO || m.dateISO || m.createdAtISO);
    if (!day) continue;

    const candidates = new Set();
    const direct = String(m.coilNo || '').trim();
    if (direct) candidates.add(direct);
    const ref = String(m.ref || '').trim();
    if (ref) candidates.add(ref);

    for (const coilNo of candidates) {
      const prev = map.get(coilNo);
      if (!prev || day > prev) map.set(coilNo, day);
    }
  }
  return map;
}

/**
 * Resolve last-used for a lot (movement map, else receivedAt).
 * @param {object} lot
 * @param {Map<string, string>} lastUsedByCoil
 */
export function resolveLotLastUsedISO(lot, lastUsedByCoil) {
  const coilNo = String(lot?.coilNo || '').trim();
  const fromMap = coilNo && lastUsedByCoil instanceof Map ? lastUsedByCoil.get(coilNo) : '';
  if (fromMap) return fromMap;
  return toIsoDay(lot?.receivedAtISO) || '';
}

/**
 * Enrich a coil lot with idle fields.
 */
export function enrichLotIdle(lot, lastUsedByCoil, asOfISO) {
  const lastUsedISO = resolveLotLastUsedISO(lot, lastUsedByCoil);
  const idleDays = daysBetween(lastUsedISO, asOfISO);
  const band = idleBandForLastUsed(lastUsedISO, asOfISO);
  return {
    ...lot,
    lastUsedISO,
    idleDays,
    idleBand: band,
  };
}

/**
 * FIFO compare: oldest received first, then coil no.
 */
export function compareCoilsFifo(a, b) {
  const ta = toIsoDay(a?.receivedAtISO);
  const tb = toIsoDay(b?.receivedAtISO);
  if (ta && tb && ta !== tb) return ta.localeCompare(tb);
  if (ta && !tb) return -1;
  if (!ta && tb) return 1;
  return String(a?.coilNo || '').localeCompare(String(b?.coilNo || ''));
}

/**
 * Idle clearance rows for Clear now (max N, critical first).
 * @param {object[]} coilLots
 * @param {Map<string, string>} lastUsedByCoil
 * @param {{ max?: number, asOfISO?: string, minFreeKg?: number }} [opts]
 */
export function buildIdleClearanceRows(coilLots, lastUsedByCoil, opts = {}) {
  const max = Number(opts.max) > 0 ? Number(opts.max) : IDLE_CLEAR_NOW_MAX;
  const minFree = Number(opts.minFreeKg);
  const freeFloor = Number.isFinite(minFree) ? minFree : 0.5;
  const asOf = opts.asOfISO;

  const candidates = [];
  for (const lot of coilLots || []) {
    const status = String(lot.currentStatus || '');
    if (status === 'Consumed' || status === 'Finished') continue;
    const onHand = Number(lot.currentWeightKg ?? lot.qtyRemaining) || 0;
    const reserved = Math.max(0, Number(lot.qtyReserved) || 0);
    const free = Math.max(0, onHand - reserved);
    if (free < freeFloor) continue;

    const enriched = enrichLotIdle(lot, lastUsedByCoil, asOf);
    if (enriched.idleBand !== 'warn' && enriched.idleBand !== 'critical') continue;

    candidates.push({
      id: `idle-${lot.coilNo}`,
      kind: 'idle',
      title: enriched.idleBand === 'critical' ? 'Use up idle coil' : 'Idle coil (watch)',
      detail: [
        lot.coilNo,
        lot.colour || '',
        lot.gaugeLabel || '',
        `${Math.round(free)} kg free`,
        enriched.idleDays != null ? `${enriched.idleDays}d since use` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      meta: String(lot.materialTypeName || ''),
      refId: lot.coilNo,
      severity: enriched.idleBand === 'critical' ? 'high' : 'warn',
      score: enriched.idleBand === 'critical' ? 48 : 42,
      cta: 'Open lot',
      action: 'open_coil',
      idleDays: enriched.idleDays,
      freeKg: free,
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.idleDays || 0) !== (a.idleDays || 0)) return (b.idleDays || 0) - (a.idleDays || 0);
    return (b.freeKg || 0) - (a.freeKg || 0);
  });

  return candidates.slice(0, max);
}

/**
 * Summarize critical idle coils for BM/Sales promotion nudges.
 * @param {object[]} coilLots
 * @param {Map<string, string>} lastUsedByCoil
 * @param {{ asOfISO?: string, maxSamples?: number }} [opts]
 */
export function summarizeCriticalIdleForPromotion(coilLots, lastUsedByCoil, opts = {}) {
  const asOf = opts.asOfISO;
  const maxSamples = Number(opts.maxSamples) > 0 ? Number(opts.maxSamples) : 3;
  const map = lastUsedByCoil instanceof Map ? lastUsedByCoil : new Map();

  const critical = [];
  let totalFreeKg = 0;
  for (const lot of coilLots || []) {
    const status = String(lot.currentStatus || '');
    if (status === 'Consumed' || status === 'Finished') continue;
    const onHand = Number(lot.currentWeightKg ?? lot.qtyRemaining) || 0;
    const reserved = Math.max(0, Number(lot.qtyReserved) || 0);
    const free = Math.max(0, onHand - reserved);
    if (free < 0.5) continue;
    const enriched = enrichLotIdle(lot, map, asOf);
    if (enriched.idleBand !== 'critical') continue;
    totalFreeKg += free;
    critical.push({
      coilNo: lot.coilNo,
      colour: lot.colour || '',
      gauge: lot.gaugeLabel || '',
      materialTypeName: lot.materialTypeName || '',
      freeKg: free,
      idleDays: enriched.idleDays,
    });
  }
  critical.sort((a, b) => (b.idleDays || 0) - (a.idleDays || 0) || b.freeKg - a.freeKg);
  return {
    count: critical.length,
    totalFreeKg,
    samples: critical.slice(0, maxSamples),
    thresholdDays: IDLE_CRITICAL_DAYS,
  };
}
