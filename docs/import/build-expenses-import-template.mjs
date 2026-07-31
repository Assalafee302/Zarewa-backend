/**
 * Builds docs/import/Expenses import.xlsx for CLI + in-app download parity.
 *
 *   node docs/import/build-expenses-import-template.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExpenseImportTemplateXlsx } from '../../server/expenseBulkImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'Expenses import.xlsx');

fs.writeFileSync(OUT, buildExpenseImportTemplateXlsx());
console.log(`Wrote ${OUT}`);
