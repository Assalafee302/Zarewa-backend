#!/usr/bin/env node
/**
 * Run vitest against local XAMPP MySQL (overrides Hostinger .env credentials).
 *   node scripts/vitest-local-xampp.mjs
 *   node scripts/vitest-local-xampp.mjs server/loginSecurity.test.js
 */
import { spawn } from 'node:child_process';

process.env.ZAREWA_MYSQL_HOST = '127.0.0.1';
process.env.ZAREWA_MYSQL_PORT = '3306';
process.env.ZAREWA_MYSQL_USER = 'root';
process.env.ZAREWA_MYSQL_PASSWORD = '';
process.env.ZAREWA_MYSQL_DATABASE = process.env.ZAREWA_MYSQL_DATABASE || 'zarewa_test';

const args = ['vitest', 'run', ...process.argv.slice(2)];
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 1));
