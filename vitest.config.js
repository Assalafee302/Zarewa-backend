import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    globals: false,
    pool: 'forks',
    environment: 'node',
    include: ['server/**/*.test.js', 'shared/**/*.test.js'],
    testTimeout: 90_000,
    hookTimeout: 600_000,
    teardownTimeout: 30_000,
  },
});
