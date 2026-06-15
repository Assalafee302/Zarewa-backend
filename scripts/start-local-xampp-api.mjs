#!/usr/bin/env node
/**
 * Start API against local XAMPP MySQL (root, no password, zarewa_db).
 * Overrides repo .env Hostinger credentials — run after: C:\xampp\mysql_start.bat
 *
 *   node scripts/start-local-xampp-api.mjs
 */
process.env.ZAREWA_MYSQL_HOST = '127.0.0.1';
process.env.ZAREWA_MYSQL_PORT = '3306';
process.env.ZAREWA_MYSQL_USER = 'root';
process.env.ZAREWA_MYSQL_PASSWORD = '';
process.env.ZAREWA_MYSQL_DATABASE = 'zarewa_db';
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';
if (!process.env.ZAREWA_ALLOW_SEEDED_USERS) process.env.ZAREWA_ALLOW_SEEDED_USERS = '1';
process.env.ZAREWA_COOKIE_DOMAIN = '';
process.env.COOKIE_SECURE = '0';
process.env.ZAREWA_COOKIE_SAMESITE = 'lax';

await import('../server/index.js');
