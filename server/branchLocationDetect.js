/**
 * GPS → nearest operational branch (Kaduna / Yola / Maiduguri).
 * Frontend sends navigator.geolocation coords; server picks the closest seeded site.
 */

import { listBranches, invalidateBranchListCache } from './branches.js';

/** City-centre defaults when DB coords are missing (approx factory / HQ). */
export const DEFAULT_BRANCH_GEO = Object.freeze({
  'BR-KD': { latitude: 10.5105, longitude: 7.4165, radiusKm: 75 },
  'BR-YL': { latitude: 9.2035, longitude: 12.4954, radiusKm: 75 },
  'BR-MDG': { latitude: 11.8469, longitude: 13.1571, radiusKm: 75 },
});

const EARTH_RADIUS_KM = 6371;

/**
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 */
export function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * @param {number} n
 */
function finiteCoord(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} latitude
 * @param {number} longitude
 * @param {{ maxRadiusKm?: number }} [opts]
 */
export function detectNearestBranch(db, latitude, longitude, opts = {}) {
  const lat = finiteCoord(latitude);
  const lon = finiteCoord(longitude);
  if (lat == null || lon == null) {
    return { ok: false, error: 'latitude and longitude are required numbers.' };
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { ok: false, error: 'latitude/longitude out of range.' };
  }

  const branches = listBranches(db);
  const candidates = [];
  for (const b of branches) {
    const defaults = DEFAULT_BRANCH_GEO[b.id] || null;
    const bLat = finiteCoord(b.latitude) ?? defaults?.latitude ?? null;
    const bLon = finiteCoord(b.longitude) ?? defaults?.longitude ?? null;
    if (bLat == null || bLon == null) continue;
    const branchRadius =
      finiteCoord(b.radiusKm) ?? defaults?.radiusKm ?? 75;
    const distanceKm = haversineDistanceKm(lat, lon, bLat, bLon);
    candidates.push({
      branchId: b.id,
      code: b.code,
      name: b.name,
      distanceKm: Math.round(distanceKm * 10) / 10,
      latitude: bLat,
      longitude: bLon,
      radiusKm: branchRadius,
      withinRadius: distanceKm <= branchRadius,
    });
  }

  candidates.sort((a, b) => a.distanceKm - b.distanceKm);

  const maxRadius =
    finiteCoord(opts.maxRadiusKm) ??
    (candidates[0] ? candidates[0].radiusKm : 75);
  const nearest = candidates[0] || null;
  const within = nearest && nearest.distanceKm <= maxRadius;

  let confidence = 'none';
  if (nearest && within) {
    if (nearest.distanceKm <= Math.min(25, nearest.radiusKm * 0.4)) confidence = 'high';
    else if (nearest.withinRadius) confidence = 'medium';
    else confidence = 'low';
  } else if (nearest) {
    confidence = 'low';
  }

  return {
    ok: true,
    detectedBranchId: within ? nearest.branchId : null,
    branch: within
      ? {
          id: nearest.branchId,
          code: nearest.code,
          name: nearest.name,
          latitude: nearest.latitude,
          longitude: nearest.longitude,
          radiusKm: nearest.radiusKm,
        }
      : null,
    distanceKm: nearest ? nearest.distanceKm : null,
    confidence,
    withinRadius: Boolean(within),
    candidates,
  };
}

/**
 * Ensure branches have lat/lng/radius columns and seed defaults when empty.
 * @param {import('better-sqlite3').Database} db
 */
export function ensureBranchGeoColumns(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='branches'`).get()) {
    return;
  }
  const cols = new Set(
    db
      .prepare(`PRAGMA table_info(branches)`)
      .all()
      .map((c) => c.name)
  );
  if (!cols.has('latitude')) {
    db.exec(`ALTER TABLE branches ADD COLUMN latitude REAL`);
  }
  if (!cols.has('longitude')) {
    db.exec(`ALTER TABLE branches ADD COLUMN longitude REAL`);
  }
  if (!cols.has('radius_km')) {
    db.exec(`ALTER TABLE branches ADD COLUMN radius_km REAL NOT NULL DEFAULT 75`);
  }
  const upd = db.prepare(
    `UPDATE branches SET latitude = ?, longitude = ?, radius_km = COALESCE(NULLIF(radius_km, 0), ?)
     WHERE id = ? AND (latitude IS NULL OR longitude IS NULL)`
  );
  for (const [id, geo] of Object.entries(DEFAULT_BRANCH_GEO)) {
    upd.run(geo.latitude, geo.longitude, geo.radiusKm, id);
  }
  invalidateBranchListCache();
}
