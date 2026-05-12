#!/usr/bin/env node
/**
 * Full-chain refund substitution diagnosis for one or more quotations.
 * Uses the same DB as the API (see repo .env) and the same engine as POST /api/refunds/preview.
 *
 * Usage (from repo root):
 *   node scripts/diagnose-substitution-trace.mjs QT-KD-26-0148 QT-KD-26-0072
 *
 * Requires MySQL credentials and schema (createDatabase({ seed: false }) — no demo seed).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { createDatabase } from '../server/db.js';
import { previewRefundRequest } from '../server/controlOps.js';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(backendRoot);

loadProjectEnv();

const refs = process.argv.slice(2).map((s) => String(s).trim()).filter(Boolean);
if (!refs.length) {
  console.error('Usage: node scripts/diagnose-substitution-trace.mjs <QT-...> [QT-...]');
  process.exit(1);
}

let db;
try {
  db = createDatabase({ seed: false });
} catch (e) {
  console.error('Could not connect to database:', e?.message || e);
  process.exit(1);
}

try {
  for (const quotationRef of refs) {
    const res = previewRefundRequest(db, { quotationRef, substitutionDiagnosis: true });
    console.log('\n========== ', quotationRef, ' ==========\n');
    if (!res.ok) {
      console.log(JSON.stringify(res, null, 2));
      continue;
    }
    const prev = res.preview || {};
    const diag = prev.substitutionDiagnosis;
    if (!diag) {
      console.log('No substitutionDiagnosis in preview (internal error). Full preview:', JSON.stringify(prev, null, 2));
      continue;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          quotationRef: prev.quotationRef,
          pricePerMeterNgn: prev.pricePerMeterNgn,
          substitutionPerMeterBreakdown: prev.substitutionPerMeterBreakdown,
          suggestedLinesSubstitution: diag.suggestedLinesSubstitution,
          warningsSubstitutionRelated: diag.warningsSubstitutionRelated,
          dataQualityIssues: diag.dataQualityIssues,
          substitutionCategoryAlreadyInRefund: diag.substitutionCategoryAlreadyInRefund,
          materialDelivered: diag.materialDelivered,
          receipts: diag.receipts,
          cuttingListCount: diag.cuttingLists?.length ?? 0,
          refundsCount: diag.refunds?.length ?? 0,
          blendedRoofingSheetPpmOnly: diag.blendedRoofingSheetPpmOnly,
          blendedAllProductLinesPpm: diag.blendedAllProductLinesPpm,
          previewPricePerMeterUsed: diag.previewPricePerMeterUsed,
          substitution: diag.substitution,
          linesJsonPreview: diag.linesJsonPreview,
        },
        null,
        2
      )
    );
  }
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}
