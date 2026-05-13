import crypto from 'node:crypto';
import { appendAuditLog } from './controlOps.js';
import { actorName } from './auth.js';

/**
 * @param {import('better-sqlite3').Database} db
 */
export function getPricingPolicyBundle(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='pricing_policy'`).get()) {
    return {
      policy: { id: 'default', defaultTradingBandNgn: 50, updatedAtIso: null, updatedByUserId: null },
      tiers: [],
      ridgeAddOns: [],
      profileAliases: [],
    };
  }
  const policy = db.prepare(`SELECT * FROM pricing_policy WHERE id = 'default'`).get();
  const tiers = db
    .prepare(`SELECT id, sort_order AS sortOrder, gauge_min_mm AS gaugeMinMm, gauge_max_mm AS gaugeMaxMm, band_ngn AS bandNgn FROM pricing_trading_band_tiers ORDER BY sort_order ASC`)
    .all();
  const ridgeAddOns = db
    .prepare(
      `SELECT id, sort_order AS sortOrder, girth_mm AS girthMm, material_family AS materialFamily, add_on_ngn AS addOnNgn,
              list_add_on_ngn AS listAddOnNgn
       FROM pricing_ridge_add_ons ORDER BY sort_order ASC`
    )
    .all()
    .map((row) => ({
      ...row,
      listAddOnNgn:
        row.listAddOnNgn != null && Number.isFinite(Number(row.listAddOnNgn))
          ? Math.max(0, Math.round(Number(row.listAddOnNgn)))
          : null,
    }));
  const profileAliases = db
    .prepare(
      `SELECT id, alias_key AS aliasKey, canonical_design_key AS canonicalDesignKey, canonical_profile_key AS canonicalProfileKey FROM pricing_profile_aliases ORDER BY alias_key ASC`
    )
    .all();
  return {
    policy: {
      id: policy?.id || 'default',
      defaultTradingBandNgn: Math.round(Number(policy?.default_trading_band_ngn) || 50),
      updatedAtIso: policy?.updated_at_iso ?? null,
      updatedByUserId: policy?.updated_by_user_id ?? null,
    },
    tiers,
    ridgeAddOns,
    profileAliases,
  };
}

/** Customer price list / PDF: optional list add-on; falls back to internal add-on. */
export function customerRidgeListAddOnNgn(row) {
  if (row?.listAddOnNgn != null && row.listAddOnNgn !== '' && Number.isFinite(Number(row.listAddOnNgn))) {
    return Math.max(0, Math.round(Number(row.listAddOnNgn)));
  }
  return Math.max(0, Math.round(Number(row?.addOnNgn) || 0));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} body
 * @param {object} actor
 */
export function patchPricingPolicyBundle(db, body, actor) {
  const now = new Date().toISOString();
  const existing = getPricingPolicyBundle(db);
  const hasDef =
    body &&
    Object.prototype.hasOwnProperty.call(body, 'defaultTradingBandNgn') &&
    body.defaultTradingBandNgn !== undefined &&
    body.defaultTradingBandNgn !== null &&
    body.defaultTradingBandNgn !== '';
  let defBand;
  if (hasDef) {
    defBand = Math.max(0, Math.round(Number(body.defaultTradingBandNgn)));
    if (!Number.isFinite(defBand)) {
      return { ok: false, error: 'defaultTradingBandNgn is required (non-negative integer).' };
    }
  } else {
    defBand = Math.max(0, Math.round(Number(existing?.policy?.defaultTradingBandNgn) || 50));
  }

  db.transaction(() => {
    db.prepare(
      `INSERT INTO pricing_policy (id, default_trading_band_ngn, updated_at_iso, updated_by_user_id)
       VALUES ('default', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         default_trading_band_ngn = excluded.default_trading_band_ngn,
         updated_at_iso = excluded.updated_at_iso,
         updated_by_user_id = excluded.updated_by_user_id`
    ).run(defBand, now, actor?.id ?? null);

    if (Array.isArray(body?.tiers)) {
      db.prepare(`DELETE FROM pricing_trading_band_tiers`).run();
      let ord = 0;
      for (const t of body.tiers) {
        ord += 1;
        const id = String(t?.id || '').trim() || `PT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const lo = Number(t?.gaugeMinMm ?? t?.gauge_min_mm ?? 0);
        const hi = Number(t?.gaugeMaxMm ?? t?.gauge_max_mm ?? 999);
        const band = Math.max(0, Math.round(Number(t?.bandNgn ?? t?.band_ngn) || 0));
        db.prepare(
          `INSERT INTO pricing_trading_band_tiers (id, sort_order, gauge_min_mm, gauge_max_mm, band_ngn) VALUES (?,?,?,?,?)`
        ).run(id, ord, lo, hi, band);
      }
    }

    if (Array.isArray(body?.ridgeAddOns)) {
      db.prepare(`DELETE FROM pricing_ridge_add_ons`).run();
      let ord = 0;
      for (const r of body.ridgeAddOns) {
        ord += 1;
        const id = String(r?.id || '').trim() || `PR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const girth = Number(r?.girthMm ?? r?.girth_mm);
        if (!Number.isFinite(girth)) continue;
        const mf = String(r?.materialFamily ?? r?.material_family ?? '').trim();
        const add = Math.max(0, Math.round(Number(r?.addOnNgn ?? r?.add_on_ngn) || 0));
        const listRaw = r?.listAddOnNgn ?? r?.list_add_on_ngn;
        const listHas =
          listRaw !== undefined && listRaw !== null && listRaw !== '' && Number.isFinite(Number(listRaw));
        const listAdd = listHas ? Math.max(0, Math.round(Number(listRaw))) : null;
        db.prepare(
          `INSERT INTO pricing_ridge_add_ons (id, sort_order, girth_mm, material_family, add_on_ngn, list_add_on_ngn) VALUES (?,?,?,?,?,?)`
        ).run(id, ord, girth, mf, add, listAdd);
      }
    }

    if (Array.isArray(body?.profileAliases)) {
      db.prepare(`DELETE FROM pricing_profile_aliases`).run();
      for (const a of body.profileAliases) {
        const id = String(a?.id || '').trim() || `PA-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const alias = String(a?.aliasKey ?? a?.alias_key ?? '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, ' ');
        if (!alias) continue;
        const cDesign = String(a?.canonicalDesignKey ?? a?.canonical_design_key ?? '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, ' ');
        const cProf = String(a?.canonicalProfileKey ?? a?.canonical_profile_key ?? '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, ' ');
        db.prepare(
          `INSERT INTO pricing_profile_aliases (id, alias_key, canonical_design_key, canonical_profile_key) VALUES (?,?,?,?)`
        ).run(id, alias, cDesign, cProf);
      }
    }
  })();

  appendAuditLog(db, {
    actor,
    action: 'pricing.policy_patch',
    entityKind: 'pricing_policy',
    entityId: 'default',
    note: actorName(actor),
    details: { defaultTradingBandNgn: defBand },
  });

  return { ok: true, ...getPricingPolicyBundle(db) };
}
