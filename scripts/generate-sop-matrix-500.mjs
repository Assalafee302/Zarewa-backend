#!/usr/bin/env node
/**
 * Writes e2e/generated/sop-matrix-500.json — second half of operational FAQ articles (500 cases).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOperationalHelpArticles } from '../shared/lib/helpOperationalCatalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'e2e', 'generated');
const outFile = path.join(outDir, 'sop-matrix-500.json');

const articles = buildOperationalHelpArticles();
const batch = articles.slice(500, 1000);

if (batch.length !== 500) {
  console.error(`Expected 500 matrix cases, got ${batch.length}. Catalog size: ${articles.length}`);
  process.exit(1);
}

const cases = batch.map((a) => ({
  id: a.id,
  title: a.title,
  path: a.links[0]?.to || '/',
  keyword: (a.keywords[0] || a.title).slice(0, 120),
  module: a.keywords.find((k) => /^[a-z_]+$/.test(k) && k.length < 20) || 'general',
}));

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2));
console.log(`Wrote ${cases.length} cases to ${outFile}`);
