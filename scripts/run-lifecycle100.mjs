#!/usr/bin/env node
/**
 * Run Core Lifecycle 100 test suites in dependency order.
 *
 * Usage:
 *   node scripts/run-lifecycle100.mjs           # API tests only (fast, SQLite)
 *   node scripts/run-lifecycle100.mjs --e2e     # Include Playwright smoke (needs MySQL)
 *   node scripts/run-lifecycle100.mjs --full    # All mapped vitest suites + inline guards
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CORE_LIFECYCLE_100,
  scenariosByType,
  scenariosByRisk,
} from '../shared/lib/coreLifecycle100Matrix.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const includeE2e = args.has('--e2e') || args.has('--full');
const full = args.has('--full');

const VITEST_FLAGS = [
  '--testTimeout=120000',
  '--pool=forks',
  '--poolOptions.forks.singleFork=true',
  '--no-file-parallelism',
];

function run(cmd, cmdArgs, label) {
  console.log(`\n── ${label} ──`);
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`FAILED: ${label}`);
    process.exit(r.status || 1);
  }
}

console.log('Core Lifecycle 100 Test Runner');
console.log(`Matrix: ${CORE_LIFECYCLE_100.length} scenarios`);
console.log(`  smoke: ${scenariosByType('smoke').length}`);
console.log(`  e2e: ${scenariosByType('e2e').length}`);
console.log(`  fraud: ${scenariosByType('fraud').length}`);
console.log(`  financial: ${scenariosByType('financial').length}`);
console.log(`  inventory: ${scenariosByType('inventory').length}`);
console.log(`  crash: ${scenariosByType('crash').length}`);
console.log(`  fraud risks: ${scenariosByRisk('fraud').length}`);
console.log(`  financial_failure risks: ${scenariosByRisk('financial_failure').length}`);
console.log(`  inventory_gap risks: ${scenariosByRisk('inventory_gap').length}`);

run(
  'npx',
  ['vitest', 'run', 'server/coreLifecycle100.test.js', ...VITEST_FLAGS],
  'LC100 inline guards + chain validation'
);

if (full) {
  run(
    'npx',
    ['vitest', 'run', 'server/transactionalScenarios.test.js', ...VITEST_FLAGS],
    'TX transactional scenarios (20)'
  );
  run(
    'npx',
    ['vitest', 'run', 'server/refundSecurity.test.js', ...VITEST_FLAGS],
    'Refund security / fraud guards'
  );
  run(
    'npx',
    ['vitest', 'run', 'server/inventoryScenarios.test.js', ...VITEST_FLAGS],
    'Inventory scenarios'
  );
  run(
    'npx',
    ['vitest', 'run', 'server/scenarioMatrix.test.js', '--testTimeout=720000', ...VITEST_FLAGS.slice(1)],
    'Scenario matrix (114 stress)'
  );
}

if (includeE2e) {
  if (!process.env.ZAREWA_FRONTEND_ROOT) {
    console.warn('Set ZAREWA_FRONTEND_ROOT to frontend path for E2E (see docs/CORE_LIFECYCLE_100_SCENARIOS.md)');
  }
  run('npx', ['playwright', 'test', 'e2e/core-lifecycle100-smoke.spec.js'], 'LC100 E2E smoke');
}

console.log('\n✓ Core Lifecycle 100 run complete');
