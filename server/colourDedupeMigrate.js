import {
  canonicalColourName,
  clusterDuplicateSetupColours,
  normalizeColourKey,
  pickCanonicalSetupColourRow,
} from '../shared/lib/colourCanonicalization.js';

/**
 * Build merge plan from duplicate setup_colours clusters.
 * @param {import('better-sqlite3').Database} db
 */
export function buildSetupColourMergePlan(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_colours'`).get()) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT colour_id, name, abbreviation, active, sort_order FROM setup_colours ORDER BY sort_order, name`
    )
    .all();
  const masterData = {
    colours: rows.map((r) => ({
      id: r.colour_id,
      name: r.name,
      abbreviation: r.abbreviation,
      active: r.active !== 0,
      sortOrder: r.sort_order,
    })),
  };

  const merges = [];
  const mergedLosers = new Set();

  for (const group of clusterDuplicateSetupColours(rows)) {
    const winner = pickCanonicalSetupColourRow(group);
    if (!winner) continue;
    const winnerName = String(winner.name || '').trim();
    const winnerId = String(winner.colour_id || '').trim();
    for (const loser of group) {
      const loserId = String(loser.colour_id || '').trim();
      if (!loserId || loserId === winnerId || mergedLosers.has(loserId)) continue;
      mergedLosers.add(loserId);
      merges.push({
        fromId: loserId,
        fromName: String(loser.name || '').trim(),
        fromAbbr: String(loser.abbreviation || '').trim(),
        toId: winnerId,
        toName: winnerName,
        toAbbr: String(winner.abbreviation || '').trim(),
      });
    }
  }

  for (const r of rows) {
    const raw = String(r.name || '').trim();
    const canon = canonicalColourName(masterData, raw);
    if (!canon || canon.toLowerCase() === raw.toLowerCase()) continue;
    const winner = rows.find((x) => String(x.name || '').trim().toLowerCase() === canon.toLowerCase());
    if (!winner) continue;
    const loserId = String(r.colour_id || '').trim();
    const winnerId = String(winner.colour_id || '').trim();
    if (!loserId || loserId === winnerId || mergedLosers.has(loserId)) continue;
    mergedLosers.add(loserId);
    merges.push({
      fromId: loserId,
      fromName: raw,
      fromAbbr: String(r.abbreviation || '').trim(),
      toId: winnerId,
      toName: String(winner.name || '').trim(),
      toAbbr: String(winner.abbreviation || '').trim(),
    });
  }

  const active = rows.filter((r) => r.active !== 0);
  for (const r of active) {
    const rName = String(r.name || '').trim().toLowerCase();
    if (!rName) continue;
    for (const w of active) {
      const wAbbr = String(w.abbreviation || '').trim().toLowerCase();
      const loserId = String(r.colour_id || '').trim();
      const winnerId = String(w.colour_id || '').trim();
      if (!wAbbr || loserId === winnerId || mergedLosers.has(loserId)) continue;
      if (rName === wAbbr) {
        mergedLosers.add(loserId);
        merges.push({
          fromId: loserId,
          fromName: String(r.name || '').trim(),
          fromAbbr: String(r.abbreviation || '').trim(),
          toId: winnerId,
          toName: String(w.name || '').trim(),
          toAbbr: String(w.abbreviation || '').trim(),
        });
      }
    }
  }

  return merges;
}

/**
 * Rewrite free-text colour fields to canonical catalogue names (coils, PO lines, etc.).
 * @param {import('better-sqlite3').Database} db
 */
export function migrateNormalizeAllColourTextFields(db) {
  const colourTables = [
    ['coil_lots', 'colour'],
    ['purchase_order_lines', 'color'],
    ['products', 'colour'],
    ['yard_coils', 'colour'],
    ['coil_requests', 'colour'],
    ['material_request_lines', 'colour'],
    ['production_job_coils', 'colour'],
    ['inventory_coil_snapshots', 'colour'],
    ['procurement_catalog', 'color'],
  ];

  const setupRows = db.prepare(`SELECT colour_id, name, abbreviation, active FROM setup_colours`).all();
  const masterData = {
    colours: setupRows.map((r) => ({
      id: r.colour_id,
      name: r.name,
      abbreviation: r.abbreviation,
      active: r.active !== 0,
    })),
  };

  db.transaction(() => {
    for (const [table, col] of colourTables) {
      if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)) continue;
      const distinct = db
        .prepare(
          `SELECT DISTINCT trim(${col}) AS v FROM ${table} WHERE trim(coalesce(${col},'')) != ''`
        )
        .all();
      for (const { v } of distinct) {
        const canon = canonicalColourName(masterData, v);
        if (!canon || canon === v) continue;
        db.prepare(`UPDATE ${table} SET ${col} = ? WHERE trim(${col}) = ?`).run(canon, v);
      }
    }

    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='quotations'`).get()) {
      const quotes = db
        .prepare(`SELECT id, lines_json FROM quotations WHERE lines_json IS NOT NULL AND trim(lines_json) != ''`)
        .all();
      const upd = db.prepare(`UPDATE quotations SET lines_json = ? WHERE id = ?`);
      for (const q of quotes) {
        try {
          const j = JSON.parse(q.lines_json);
          if (!j || typeof j !== 'object') continue;
          let changed = false;
          for (const field of ['materialColor', 'materialColour']) {
            if (typeof j[field] !== 'string') continue;
            const canon = canonicalColourName(masterData, j[field]);
            if (canon && canon !== j[field]) {
              j[field] = canon;
              changed = true;
            }
          }
          if (changed) upd.run(JSON.stringify(j), q.id);
        } catch {
          /* ignore */
        }
      }
    }
  })();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof buildSetupColourMergePlan>} merges
 * @param {{ colours?: object[] }} masterData
 */
function valueShouldRewrite(value, merge, masterData) {
  const v = String(value ?? '').trim();
  if (!v) return false;
  if (v === merge.fromName || v === merge.toName) return v !== merge.toName;
  if (merge.fromAbbr && v.toUpperCase() === merge.fromAbbr.toUpperCase()) return true;
  const canon = canonicalColourName(masterData, v);
  return canon.toLowerCase() === merge.toName.toLowerCase() && v.toLowerCase() !== merge.toName.toLowerCase();
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function migrateMergeDuplicateSetupColours(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_colours'`).get()) return;

  const merges = buildSetupColourMergePlan(db);
  if (!merges.length) {
    migrateNormalizeAllColourTextFields(db);
    return;
  }

  const allRows = db.prepare(`SELECT colour_id, name, abbreviation FROM setup_colours`).all();
  const masterData = {
    colours: allRows.map((r) => ({
      id: r.colour_id,
      name: r.name,
      abbreviation: r.abbreviation,
      active: true,
    })),
  };

  db.transaction(() => {
    for (const merge of merges) {
      const variants = new Set(
        [merge.fromName, merge.fromAbbr, merge.toName].filter(Boolean).map((s) => String(s).trim())
      );

      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='coil_lots'`).get()) {
        for (const v of variants) {
          if (!v) continue;
          db.prepare(`UPDATE coil_lots SET colour = ? WHERE trim(coalesce(colour,'')) = ?`).run(
            merge.toName,
            v
          );
        }
      }

      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_order_lines'`).get()) {
        for (const v of variants) {
          if (!v) continue;
          db.prepare(`UPDATE purchase_order_lines SET color = ? WHERE trim(coalesce(color,'')) = ?`).run(
            merge.toName,
            v
          );
        }
      }

      const textTables = [
        ['products', 'colour'],
        ['yard_coils', 'colour'],
        ['coil_requests', 'colour'],
        ['material_request_lines', 'colour'],
        ['production_job_coils', 'colour'],
        ['inventory_coil_snapshots', 'colour'],
      ];
      for (const [table, col] of textTables) {
        if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)) continue;
        for (const v of variants) {
          if (!v) continue;
          db.prepare(`UPDATE ${table} SET ${col} = ? WHERE trim(coalesce(${col},'')) = ?`).run(merge.toName, v);
        }
      }

      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='procurement_catalog'`).get()) {
        for (const v of variants) {
          if (!v) continue;
          db.prepare(`UPDATE procurement_catalog SET color = ? WHERE trim(coalesce(color,'')) = ?`).run(
            merge.toName,
            v
          );
        }
      }

      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_price_lists'`).get()) {
        db.prepare(`UPDATE setup_price_lists SET colour_id = ? WHERE colour_id = ?`).run(merge.toId, merge.fromId);
      }

      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='price_list_items'`).get()) {
        const fromKey = normalizeColourKey(merge.fromName);
        const toKey = normalizeColourKey(merge.toName);
        if (fromKey && toKey && fromKey !== toKey) {
          db.prepare(
            `UPDATE price_list_items SET colour_key = ? WHERE lower(trim(coalesce(colour_key,''))) = lower(?)`
          ).run(toKey, fromKey);
        }
        if (merge.fromAbbr) {
          db.prepare(
            `UPDATE price_list_items SET colour_key = ? WHERE lower(trim(coalesce(colour_key,''))) = lower(?)`
          ).run(toKey, merge.fromAbbr.toLowerCase());
        }
      }

      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='quotations'`).get()) {
        const quotes = db
          .prepare(`SELECT id, lines_json FROM quotations WHERE lines_json IS NOT NULL AND trim(lines_json) != ''`)
          .all();
        const upd = db.prepare(`UPDATE quotations SET lines_json = ? WHERE id = ?`);
        for (const q of quotes) {
          try {
            const j = JSON.parse(q.lines_json);
            if (!j || typeof j !== 'object') continue;
            let changed = false;
            if (typeof j.materialColor === 'string' && valueShouldRewrite(j.materialColor, merge, masterData)) {
              j.materialColor = merge.toName;
              changed = true;
            }
            if (typeof j.materialColour === 'string' && valueShouldRewrite(j.materialColour, merge, masterData)) {
              j.materialColour = merge.toName;
              changed = true;
            }
            if (changed) upd.run(JSON.stringify(j), q.id);
          } catch {
            /* ignore bad json */
          }
        }
      }

      db.prepare(`UPDATE setup_colours SET active = 0 WHERE colour_id = ?`).run(merge.fromId);
    }

    for (const merge of merges) {
      db.prepare(
        `UPDATE setup_colours SET name = ?, abbreviation = ? WHERE colour_id = ? AND active != 0`
      ).run(merge.toName, merge.toAbbr || null, merge.toId);
    }
  })();

  migrateNormalizeAllColourTextFields(db);
}
