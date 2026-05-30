import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolve Vite build output. Hostinger often sets ZAREWA_STATIC_DIR=/app/dist (wrong —
 * that is an absolute path that does not exist). Prefer the first candidate with index.html.
 */
export function resolveStaticRoot(cwd = process.cwd()) {
  const explicit = String(process.env.ZAREWA_STATIC_DIR || '').trim();
  const candidates = [];
  if (explicit) candidates.push(explicit);
  candidates.push(
    path.join(cwd, 'app', 'dist'),
    path.join(backendRoot, 'app', 'dist'),
    path.join(cwd, 'dist'),
    path.join(backendRoot, 'dist')
  );

  for (const raw of candidates) {
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    const indexHtml = path.join(resolved, 'index.html');
    if (fs.existsSync(indexHtml)) {
      return { staticRoot: resolved, indexHtml, found: true };
    }
  }

  const fallback = explicit
    ? path.isAbsolute(explicit)
      ? explicit
      : path.resolve(cwd, explicit)
    : path.join(cwd, 'dist');
  return { staticRoot: fallback, indexHtml: path.join(fallback, 'index.html'), found: false };
}

/** @param {import('express').Express} app */
export function attachStaticSpa(app) {
  const { staticRoot, indexHtml, found } = resolveStaticRoot();
  console.log(
    `[zarewa] static SPA root: ${staticRoot} (index.html ${found ? 'found' : 'MISSING'})`
  );
  if (!found) return false;

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
    res.sendFile(indexHtml, (err) => (err ? next(err) : undefined));
  });
  return true;
}
