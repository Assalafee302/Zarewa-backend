import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    globals: false,
    pool: 'forks',
    fileParallelism: false,
    poolOptions: {
      forks: { singleFork: true },
    },
    environment: 'node',
    // Keep legacy full bootstrap payloads in tests; production defaults to shell.
    env: {
      ZAREWA_BOOTSTRAP_DEFAULT_MODE: 'full',
    },
    include: ['server/**/*.test.js', 'shared/**/*.test.js'],
    testTimeout: 360_000,
    hookTimeout: 600_000,
    teardownTimeout: 60_000,
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
