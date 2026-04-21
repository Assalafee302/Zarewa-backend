import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { registerHttpApi } from './httpApi.js';
import { attachAuthContext } from './auth.js';

/** Browser `Origin` has no path; env entries sometimes include a trailing `/`. */
function normalizeCorsOrigin(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return t.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}`;
  } catch {
    return t.replace(/\/+$/, '');
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Dev default: common Vite dev (5173/5174) + preview (4173) on localhost + 127.0.0.1.
  const corsOrigin =
    process.env.CORS_ORIGIN ||
    'http://localhost:5173,http://localhost:5174,http://localhost:4173,http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:4173';
  // Disallow permissive CORS in production by default.
  const isProduction = process.env.NODE_ENV === 'production';
  const allowAllOrigins = corsOrigin === '*' && !isProduction;
  const apiPort = Number(process.env.PORT || 8787) || 8787;
  const devLocalSpaOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:4173',
    'http://localhost:5180',
    'http://localhost:3000',
    `http://localhost:${apiPort}`,
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:4173',
    'http://127.0.0.1:5180',
    'http://127.0.0.1:3000',
    `http://127.0.0.1:${apiPort}`,
  ];
  let allowedOrigins =
    corsOrigin === '*'
      ? []
      : corsOrigin
          .split(',')
          .map((s) => normalizeCorsOrigin(s))
          .filter(Boolean);
  /* Allow common Vite dev origins when not production, or when explicitly opting in (e.g. NODE_ENV=production but API+SPA on same machine). */
  const allowLocalSpa =
    !isProduction || String(process.env.ZAREWA_ALLOW_LOCAL_SPA_CORS || '').trim() === '1';
  if (allowLocalSpa) {
    const seen = new Set(allowedOrigins);
    for (const o of devLocalSpaOrigins.map(normalizeCorsOrigin)) {
      if (!seen.has(o)) {
        seen.add(o);
        allowedOrigins.push(o);
      }
    }
  }

  const allowedOriginSet = new Set(allowedOrigins.map(normalizeCorsOrigin));

  /** Dev-only: allow browsers on private LAN IPs (phone on Wi‑Fi) when the SPA talks directly to this API. */
  const allowDevLanCors =
    !isProduction && String(process.env.ZAREWA_ALLOW_DEV_LAN_CORS ?? '1').trim() !== '0';
  function isDevPrivateLanOrigin(originHeader) {
    if (!originHeader) return false;
    try {
      const u = new URL(originHeader);
      if (u.protocol !== 'http:') return false;
      const host = u.hostname;
      if (!net.isIPv4(host)) return false;
      const parts = host.split('.');
      if (parts.length !== 4) return false;
      const a = Number(parts[0]);
      const b = Number(parts[1]);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (a === 10) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      return false;
    } catch {
      return false;
    }
  }

  app.disable('x-powered-by');
  const contentSecurityPolicy =
    process.env.ZAREWA_CSP ||
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'";
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy);
    next();
  });
  if (allowAllOrigins) {
    app.use(
      cors({
        origin: true,
        credentials: true,
      })
    );
  } else {
    app.use(
      cors({
        origin(originHeader, callback) {
          if (!originHeader) return callback(null, true);
          if (allowedOriginSet.has(normalizeCorsOrigin(originHeader))) {
            return callback(null, originHeader);
          }
          if (allowDevLanCors && isDevPrivateLanOrigin(originHeader)) return callback(null, originHeader);
          return callback(null, false);
        },
        credentials: true,
      })
    );
  }
  app.use(attachAuthContext(db));

  registerHttpApi(app, db);

  const staticRoot = path.resolve(
    process.env.ZAREWA_STATIC_DIR || path.join(process.cwd(), 'dist')
  );
  const spaIndex = path.join(staticRoot, 'index.html');
  if (fs.existsSync(spaIndex)) {
    app.use(
      express.static(staticRoot, {
        index: false,
        maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
        setHeaders(res, filePath) {
          if (/[/\\]assets[/\\]/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api')) return next();
      res.sendFile(spaIndex, (err) => (err ? next(err) : undefined));
    });
  }

  return app;
}
