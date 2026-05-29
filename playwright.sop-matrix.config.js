import base from './playwright.config.js';

/** 500-case SOP matrix — uses saved admin session; excludes workspace/smoke packs. */
export default {
  ...base,
  globalSetup: './e2e/global-setup.mjs',
  testMatch: ['**/operational-sop-matrix-500.spec.js'],
  workers: 3,
  fullyParallel: true,
  timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: 'test-results/sop-matrix-500.json' }]],
};
