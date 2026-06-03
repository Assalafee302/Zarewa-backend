/**
 * Month-end stock register — per-line clearance, store checklist, BM validation.
 */

export const LINE_STATUS = {
  PENDING: 'pending',
  CLEARED: 'cleared',
  ADJUSTED: 'adjusted',
  QUERY: 'query',
};

export const FINISHED_CONFIRM = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  DISPUTED: 'disputed',
};

export const QUERY_REASONS = [
  'Not found on floor',
  'Weight mismatch',
  'Wrong coil on jobs',
  'Suspected theft / loss',
  'Awaiting material exception',
  'Other',
];

/** Whole kg only — no decimals in stock / production registers. */
export function roundKg(n) {
  return Math.round(Number(n) || 0);
}

export function roundM(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function lineKeyCoil(coilNo) {
  return `coil:${String(coilNo || '').trim()}`;
}

export function lineKeyFinished(coilNo) {
  return `finished:${String(coilNo || '').trim()}`;
}

export function lineKeyStone(productID) {
  return `stone:${String(productID || '').trim()}`;
}

export function lineKeyAccessory(productID) {
  return `accessory:${String(productID || '').trim()}`;
}

export function lineKeyInTransit(referenceNo, itemKey) {
  return `intransit:${String(referenceNo || '').trim()}:${String(itemKey || '').trim()}`;
}

export function parseLineClearance(raw) {
  if (!raw) return { lines: {}, version: 1 };
  if (typeof raw === 'object' && raw.lines) return raw;
  try {
    const p = JSON.parse(String(raw));
    return p && typeof p === 'object' ? { lines: p.lines || {}, version: p.version || 1 } : { lines: {}, version: 1 };
  } catch {
    return { lines: {}, version: 1 };
  }
}

export function parseStoreChecklist(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function defaultLineEntry() {
  return { status: LINE_STATUS.PENDING, note: '', queryReason: '', materialExceptionId: '', finishedConfirm: FINISHED_CONFIRM.PENDING };
}

export function getLineEntry(clearance, key) {
  const c = parseLineClearance(clearance);
  return { ...defaultLineEntry(), ...(c.lines[key] || {}) };
}

export function setLineEntry(clearance, key, patch) {
  const c = parseLineClearance(clearance);
  c.lines[key] = { ...getLineEntry(c, key), ...patch, updatedAtISO: new Date().toISOString() };
  return c;
}

/**
 * Collect all clearance line keys from a register pack.
 * @param {object} register
 */
export function enumerateRegisterLineKeys(register) {
  const keys = [];
  for (const family of ['aluminium', 'aluzinc']) {
    for (const g of register?.coilSections?.[family]?.groups || []) {
      for (const r of g.rows || []) {
        if (r.finishedInPeriod) keys.push({ key: lineKeyFinished(r.coilNo), kind: 'finished', row: r, family, gaugeLabel: g.gaugeLabel });
        else if (r.closingKg != null || r.closingBlank === false) {
          keys.push({ key: lineKeyCoil(r.coilNo), kind: 'coil', row: r, family, gaugeLabel: g.gaugeLabel });
        }
      }
    }
  }
  for (const g of register?.stoneCoated?.groups || []) {
    for (const r of g.rows || []) {
      keys.push({ key: lineKeyStone(r.productID), kind: 'stone', row: r, gaugeLabel: g.gaugeLabel });
    }
  }
  for (const r of register?.accessories?.rows || []) {
    keys.push({ key: lineKeyAccessory(r.productID), kind: 'accessory', row: r });
  }
  for (let i = 0; i < (register?.inTransit || []).length; i++) {
    const t = register.inTransit[i];
    const ik = String(t.itemName || t.poId || i);
    keys.push({ key: lineKeyInTransit(t.referenceNo, ik), kind: 'intransit', row: t });
  }
  return keys;
}

export function computeClearanceProgress(register, clearanceRaw) {
  const clearance = parseLineClearance(clearanceRaw);
  const items = enumerateRegisterLineKeys(register);
  let pending = 0;
  let cleared = 0;
  let adjusted = 0;
  let query = 0;
  let finishedPending = 0;
  for (const item of items) {
    const entry = getLineEntry(clearance, item.key);
    if (item.kind === 'finished') {
      if (entry.finishedConfirm === FINISHED_CONFIRM.PENDING) finishedPending += 1;
      else if (entry.status === LINE_STATUS.PENDING && entry.finishedConfirm === FINISHED_CONFIRM.CONFIRMED) {
        cleared += 1;
      } else if (entry.finishedConfirm === FINISHED_CONFIRM.CONFIRMED) cleared += 1;
      else if (entry.finishedConfirm === FINISHED_CONFIRM.DISPUTED) query += 1;
      continue;
    }
    const st = entry.status || LINE_STATUS.PENDING;
    if (st === LINE_STATUS.PENDING) pending += 1;
    else if (st === LINE_STATUS.CLEARED) cleared += 1;
    else if (st === LINE_STATUS.ADJUSTED) adjusted += 1;
    else if (st === LINE_STATUS.QUERY) query += 1;
  }
  return {
    total: items.length,
    pending,
    cleared,
    adjusted,
    query,
    finishedPending,
    complete: pending === 0 && finishedPending === 0,
  };
}

function systemClosingForItem(item) {
  const r = item.row;
  if (item.kind === 'coil') return roundKg(r.closingKg);
  if (item.kind === 'stone') return roundM(r.remainingM);
  if (item.kind === 'accessory') return roundM(r.balance);
  return null;
}

function countedValueForEntry(item, entry) {
  if (item.kind === 'coil') return entry.countedClosingKg != null ? roundKg(entry.countedClosingKg) : null;
  if (item.kind === 'stone') return entry.countedRemainingM != null ? roundM(entry.countedRemainingM) : null;
  if (item.kind === 'accessory') return entry.countedBalance != null ? roundM(entry.countedBalance) : null;
  return null;
}

/**
 * Validate BM can approve period.
 * @returns {{ ok: boolean, error?: string, blockers?: string[] }}
 */
export function validateBmApprove(register, clearanceRaw, adjustmentsRaw) {
  const blockers = [];
  const progress = computeClearanceProgress(register, clearanceRaw);
  if (progress.pending > 0) blockers.push(`${progress.pending} line(s) still pending review.`);
  if (progress.finishedPending > 0) blockers.push(`${progress.finishedPending} finished coil(s) not confirmed.`);

  const clearance = parseLineClearance(clearanceRaw);
  const adj = adjustmentsRaw && typeof adjustmentsRaw === 'object' ? adjustmentsRaw : {};
  const coilAdjMap = new Map((adj.coilLines || []).map((l) => [String(l.coilNo), l]));

  for (const item of enumerateRegisterLineKeys(register)) {
    const entry = getLineEntry(clearance, item.key);
    if (item.kind === 'finished') {
      if (entry.finishedConfirm === FINISHED_CONFIRM.DISPUTED && !String(entry.materialExceptionId || '').trim()) {
        blockers.push(`Finished coil ${item.row.coilNoDisplay || item.row.coilNo}: disputed — link a material exception.`);
      }
      continue;
    }
    const st = entry.status || LINE_STATUS.PENDING;
    if (st === LINE_STATUS.ADJUSTED) {
      if (!String(entry.materialExceptionId || '').trim()) {
        const label = item.kind === 'coil' ? item.row.coilNo : item.row.productID || item.row.itemName;
        blockers.push(`Adjusted line ${label}: material exception (MEX) required.`);
      }
      const sys = systemClosingForItem(item);
      const counted = countedValueForEntry(item, entry);
      const differs = counted != null && sys != null && counted !== sys;
      if (item.kind === 'coil') {
        const adjLine = coilAdjMap.get(item.row.coilNo);
        if (differs && adjLine && roundKg(adjLine.closingKg) !== counted) {
          blockers.push(`Coil ${item.row.coilNo}: counted kg must match saved adjustment.`);
        }
      }
    }
  }

  if (blockers.length) return { ok: false, error: blockers[0], blockers };
  return { ok: true };
}

export function validateStoreChecklist(checklist) {
  const c = checklist || {};
  const required = ['coilsCounted', 'finishedVerified', 'stoneCounted', 'accessoriesCounted', 'inTransitReviewed'];
  for (const k of required) {
    if (!c[k]) return { ok: false, error: 'Complete all store count checklist items before sending to branch manager.' };
  }
  return { ok: true };
}

/** Merge clearance flags onto register rows for UI. */
export function applyLineClearanceToRegister(register, clearanceRaw) {
  if (!register) return register;
  const clearance = parseLineClearance(clearanceRaw);
  const attach = (key, row) => {
    const e = getLineEntry(clearance, key);
    row.clearanceStatus = e.status || LINE_STATUS.PENDING;
    row.clearanceNote = e.note || '';
    row.queryReason = e.queryReason || '';
    row.materialExceptionId = e.materialExceptionId || '';
    row.finishedConfirm = e.finishedConfirm || FINISHED_CONFIRM.PENDING;
    row.countedClosingKg = e.countedClosingKg != null ? roundKg(e.countedClosingKg) : null;
    row.countedRemainingM = e.countedRemainingM != null ? roundM(e.countedRemainingM) : null;
    row.countedBalance = e.countedBalance != null ? roundM(e.countedBalance) : null;
  };
  for (const family of ['aluminium', 'aluzinc']) {
    for (const g of register.coilSections?.[family]?.groups || []) {
      for (const r of g.rows || []) {
        if (r.finishedInPeriod) attach(lineKeyFinished(r.coilNo), r);
        else attach(lineKeyCoil(r.coilNo), r);
      }
    }
  }
  for (const g of register.stoneCoated?.groups || []) {
    for (const r of g.rows || []) attach(lineKeyStone(r.productID), r);
  }
  for (const r of register.accessories?.rows || []) attach(lineKeyAccessory(r.productID), r);
  register.clearanceProgress = computeClearanceProgress(register, clearance);
  return register;
}

/** Lines eligible for closing capture (cleared or adjusted, not query). */
export function lineEligibleForClosing(item, clearanceRaw) {
  const entry = getLineEntry(clearanceRaw, item.key);
  if (item.kind === 'finished') return entry.finishedConfirm === FINISHED_CONFIRM.CONFIRMED;
  const st = entry.status || LINE_STATUS.PENDING;
  return st === LINE_STATUS.CLEARED || st === LINE_STATUS.ADJUSTED;
}

export function buildAdjustmentsFromClearance(register, clearanceRaw) {
  const clearance = parseLineClearance(clearanceRaw);
  const coilLines = [];
  const stoneLines = [];
  const accessoryLines = [];
  for (const item of enumerateRegisterLineKeys(register)) {
    const entry = getLineEntry(clearance, item.key);
    if (item.kind === 'coil' && entry.status === LINE_STATUS.ADJUSTED && entry.countedClosingKg != null) {
      coilLines.push({
        coilNo: item.row.coilNo,
        closingKg: roundKg(entry.countedClosingKg),
        note: entry.note || entry.queryReason || '',
        materialExceptionId: entry.materialExceptionId || '',
      });
    }
    if (item.kind === 'stone' && entry.status === LINE_STATUS.ADJUSTED && entry.countedRemainingM != null) {
      stoneLines.push({
        productID: item.row.productID,
        remainingM: roundM(entry.countedRemainingM),
        materialExceptionId: entry.materialExceptionId || '',
      });
    }
    if (item.kind === 'accessory' && entry.status === LINE_STATUS.ADJUSTED && entry.countedBalance != null) {
      accessoryLines.push({
        productID: item.row.productID,
        balance: roundM(entry.countedBalance),
        materialExceptionId: entry.materialExceptionId || '',
      });
    }
  }
  return { coilLines, stoneLines, accessoryLines };
}
