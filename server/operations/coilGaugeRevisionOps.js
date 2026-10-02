/**
 * Physical coil gauge is effective-dated.
 *
 * Refund gauge-variance payout and production standard kg/m read the gauge that was
 * current when that transaction was registered. A later coil-edit does not rewrite
 * allocations, conversion checks, or refunds already on file. Anything registered
 * after the edit uses the new thickness (and therefore the new kg).
 */
import { formatGaugeLabelMm } from '../../shared/lib/gaugeDisplayAlias.js';
import { actorId, actorName } from '../auth.js';

const BASELINE_EFFECTIVE_FROM = '1970-01-01T00:00:00.000Z';

function parseGaugeMm(value) {
  const match = String(value ?? '')
    .replace(/,/g, '.')
    .match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Physical thickness, not the Yola quotation display alias.
 * "0.50 mm" and "0.5" store as "0.50mm" / "0.5mm" only when a number is present.
 * @param {unknown} raw
 */
export function formatStoredCoilGaugeLabel(raw) {
  const formatted = formatGaugeLabelMm(raw);
  return String(formatted || '').trim();
}

/**
 * True when two labels are the same steel thickness (label spacing ignored).
 * @param {unknown} a
 * @param {unknown} b
 */
export function gaugeLabelsSameThickness(a, b) {
  const ma = parseGaugeMm(a);
  const mb = parseGaugeMm(b);
  if (ma != null && mb != null) return Math.abs(ma - mb) < 1e-4;
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

function revisionId() {
  return `CGR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function coilLotsHasGaugeRevisedAt(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(coil_lots)`).all();
    if (cols?.length) return cols.some((c) => c.name === 'gauge_revised_at_iso');
  } catch {
    /* MySQL */
  }
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'coil_lots' AND column_name = 'gauge_revised_at_iso'`
      )
      .get();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Gauge that was current at `atIso`. No revision rows → `fallbackLabel` (allocation snapshot or live lot).
 * @param {import('better-sqlite3').Database} db
 * @param {string} coilNo
 * @param {string | null | undefined} atIso
 * @param {string} [fallbackLabel]
 */
export function coilGaugeLabelAsOf(db, coilNo, atIso, fallbackLabel = '') {
  const fallback = String(fallbackLabel ?? '').trim();
  const cn = String(coilNo || '').trim();
  const at = String(atIso || '').trim();
  if (!cn || !at) return fallback;
  try {
    const row = db
      .prepare(
        `SELECT gauge_label FROM coil_gauge_revisions
         WHERE coil_no = ? AND effective_from_iso <= ?
         ORDER BY effective_from_iso DESC, id DESC
         LIMIT 1`
      )
      .get(cn, at);
    const label = String(row?.gauge_label ?? '').trim();
    if (label) return label;
  } catch {
    /* table not migrated yet */
  }
  return fallback;
}

/**
 * Record a thickness change. Caller updates `coil_lots.gauge_label`.
 * Existing allocation labels are left as registered. Blank allocation labels are
 * stamped with the previous gauge so they do not follow the live lot.
 * Must run inside the caller's transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {{ coilNo: string, previousLabel: string, nextLabel: string, atIso?: string, actor?: object }} input
 */
export function applyCoilGaugeRevisionTx(db, input) {
  const cn = String(input?.coilNo || '').trim();
  const previousLabel = String(input?.previousLabel ?? '').trim();
  const nextLabel = String(input?.nextLabel ?? '').trim();
  const atIso = String(input?.atIso || '').trim() || new Date().toISOString();
  if (!cn || !nextLabel || gaugeLabelsSameThickness(previousLabel, nextLabel)) {
    return { changed: false, effectiveFromIso: null };
  }

  try {
    db.prepare(
      `UPDATE production_job_coils
       SET gauge_label = ?
       WHERE coil_no = ?
         AND (gauge_label IS NULL OR TRIM(gauge_label) = '')`
    ).run(previousLabel || null, cn);
  } catch {
    /* allocations table absent in a narrow fixture */
  }

  const prior = db
    .prepare(`SELECT id FROM coil_gauge_revisions WHERE coil_no = ? LIMIT 1`)
    .get(cn);
  const insert = db.prepare(
    `INSERT INTO coil_gauge_revisions (
      id, coil_no, gauge_label, effective_from_iso, changed_by_user_id, changed_by_display
    ) VALUES (?,?,?,?,?,?)`
  );
  if (!prior && previousLabel) {
    insert.run(
      revisionId(),
      cn,
      previousLabel,
      BASELINE_EFFECTIVE_FROM,
      null,
      null
    );
  }
  insert.run(revisionId(), cn, nextLabel, atIso, actorId(input?.actor), actorName(input?.actor) || null);

  if (coilLotsHasGaugeRevisedAt(db)) {
    db.prepare(`UPDATE coil_lots SET gauge_revised_at_iso = ? WHERE coil_no = ?`).run(atIso, cn);
  }

  return { changed: true, effectiveFromIso: atIso, previousLabel, nextLabel };
}

/**
 * Standard kg for a job line uses the gauge recorded on that allocation.
 * A later coil-edit must not reprice a job that was already registered.
 * @param {object | null | undefined} coil
 * @param {object | null | undefined} allocation
 */
export function coilForAllocationGauge(coil, allocation) {
  if (!coil) return coil;
  const snap = String(allocation?.gauge_label ?? '').trim();
  if (!snap || gaugeLabelsSameThickness(snap, coil.gauge_label)) return coil;
  return { ...coil, gauge_label: snap };
}
