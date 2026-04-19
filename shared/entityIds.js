/**
 * Shared ID formats (store coil lots vs cutting list documents).
 * Coil: C{YY}-{NNNN}  Cutting list: CL{YY}-{NNN+}
 */

export function formatAutoCoilLotNo(serial1Based, year = new Date().getFullYear()) {
  const yy = String(year).slice(-2);
  return `C${yy}-${String(serial1Based).padStart(4, '0')}`;
}

/** Cutting list document id — CL + 2-digit year (not confused with coil C…). */
export function formatCuttingListId(serial1Based, year = new Date().getFullYear()) {
  const yy = String(year).slice(-2);
  return `CL${yy}-${String(serial1Based).padStart(3, '0')}`;
}

/** Max numeric suffix from structured cutting list ids only (ignores timestamp fallback ids). */
export function maxCuttingListSerialFromIds(ids) {
  let max = 0;
  for (const raw of ids) {
    const s = String(raw);
    if (/^CL-\d{10,}-/i.test(s)) continue;
    const m = s.match(/^CL(\d{2})-(\d+)$/i);
    if (m) {
      max = Math.max(max, parseInt(m[2], 10));
      continue;
    }
    const m2 = s.match(/^CL-(\d{4})-(\d+)$/);
    if (m2) {
      max = Math.max(max, parseInt(m2[2], 10));
      continue;
    }
  }
  return max;
}

export function nextCuttingListIdFromDbRows(rows, year = new Date().getFullYear()) {
  const max = maxCuttingListSerialFromIds(rows.map((r) => r.id));
  return formatCuttingListId(max + 1, year);
}

/** DB migration: CL-2026-042 → CL26-042 */
export function migrateLegacyCuttingListId(oldId) {
  const m = String(oldId).match(/^CL-(20\d{2})-(\d+)$/);
  if (!m) return null;
  const yy = m[1].slice(-2);
  const serial = parseInt(m[2], 10);
  return `CL${yy}-${String(serial).padStart(3, '0')}`;
}

/** DB migration: COIL-2026-0007 / mistaken CL-2026-0007 on coil_lots → C26-0007 */
export function migrateLegacyCoilLotNo(oldNo) {
  const s = String(oldNo);
  const m1 = s.match(/^COIL-(20\d{2})-(\d+)$/);
  if (m1) {
    const yy = m1[1].slice(-2);
    return `C${yy}-${String(parseInt(m1[2], 10)).padStart(4, '0')}`;
  }
  const m2 = s.match(/^CL-(20\d{2})-(\d+)$/);
  if (m2) {
    const yy = m2[1].slice(-2);
    return `C${yy}-${String(parseInt(m2[2], 10)).padStart(4, '0')}`;
  }
  return null;
}
