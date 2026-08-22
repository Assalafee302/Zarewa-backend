/**
 * Pre-deploy refund gate — runs each MySQL-heavy suite in isolation (avoids Vitest worker timeouts).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const suites = [
  'server/refundCancelledOverpayPreview.test.js',
  'server/refundPartnerWalletSplit.test.js',
  'server/refundSecurity.test.js',
];

const vitestArgs = [
  'vitest',
  'run',
  '--fileParallelism=false',
  '--pool=forks',
  '--poolOptions.forks.singleFork=true',
];

for (const file of suites) {
  console.error(`\n── Refund live: ${file} ──\n`);
  const result = spawnSync('npx', [...vitestArgs, file], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.error('\n✓ Refund live gate passed (preview + cancelled overpay + partner wallet + security)\n');
console.error('Next: npm run preview:refund-lab');
console.error('Frontend: npx vitest run src/components/sales/RefundModal.test.jsx (frontend repo)\n');
