/**
 * Vitest setupFiles entry — refuse to run when env points at a production MySQL schema.
 */
import { loadProjectEnv } from './loadProjectEnv.js';
import { assertVitestNotUsingProductionMysql } from './mysqlProdGuard.js';

loadProjectEnv();
assertVitestNotUsingProductionMysql();
// Phase 1 free-text accessory gate defaults ON in app code; keep tests on the prior open path
// unless a suite explicitly sets ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES=1.
if (process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES == null) {
  process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES = '0';
}
