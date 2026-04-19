import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores([
    'coverage',
    'playwright-report',
    'test-results',
    'playwright/.cache',
    'playwright.config.js',
    'e2e/**',
  ]),
  {
    files: ['server/**/*.js', 'shared/**/*.js', 'scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]|^motion$' }],
    },
  },
]);
