import os from 'node:os';
import express from 'express';
import { readAiAssistConfig } from './aiAssist.js';
import { createDatabase, defaultDbPath, lastBootPhase } from './db.js';
import { createApp } from './app.js';
import { loadProjectEnv } from './loadProjectEnv.js';
import { mysqlConfigFromEnv } from './mysqlDatabase.js';
import { debugBootLog } from './debugBootLog.js';

loadProjectEnv();

const port = Number(process.env.PORT || 8787) || 8787;
const listenHost = String(process.env.ZAREWA_LISTEN_HOST || '').trim() || undefined;

console.log('[zarewa] boot', new Date().toISOString(), process.version, `PORT=${port}`);

let app;
let dbPath = '';
let bootDegraded = false;

try {
  const db = createDatabase();
  dbPath = defaultDbPath();
  app = createApp(db);
} catch (e) {
  bootDegraded = true;
  const errMsg = String(e?.message || e || 'unknown');
  // #region agent log
  debugBootLog({
    hypothesisId: 'E',
    location: 'index.js:boot',
    message: 'startup catch',
    data: {
      err: errMsg,
      code: e?.code,
      errno: e?.errno,
      sqlMessage: e?.sqlMessage,
      stack: String(e?.stack || '').slice(0, 500),
    },
  });
  // #endregion
  console.error('[zarewa] Startup failed — minimal HTTP only until fixed:', errMsg);
  console.error(e);
  const cfg = mysqlConfigFromEnv();
  const mysqlTarget = `${cfg.host}:${cfg.port}/${cfg.database}`;
  console.error(
    `[zarewa] Expected MySQL at ${mysqlTarget} (user=${cfg.user}). If this is wrong, set ZAREWA_MYSQL_* in repo-root .env — see .env.example`
  );
  dbPath = '(not connected)';
  app = express();
  app.disable('x-powered-by');
  const degradedProbeJson = () => ({
    ok: false,
    service: 'zarewa-api',
    degraded: true,
    database: false,
    bootError: errMsg,
    bootPhase: lastBootPhase,
    bootMarker: 'po-line-type-migrate-v4',
    mysqlTarget,
    mysqlUser: cfg.user,
    fixHint:
      'Start MySQL so host:port accepts TCP connections, create the database if missing, and match ZAREWA_MYSQL_USER / ZAREWA_MYSQL_PASSWORD in .env. Run: npm run mysql:smoke',
    time: new Date().toISOString(),
  });
  const degradedProbeHandler = (_req, res) => {
    /**
     * HTTP 200 so probes that only check status see UP; use `ok: false` + `degraded` in JSON for real state.
     * Paths mirror common K8s / LB checks (see also /api/health).
     */
    res.status(200).json(degradedProbeJson());
  };
  for (const p of [
    '/api/health',
    '/api/readyz',
    '/api/livez',
    '/api/status',
    '/health',
    '/healthz',
    '/livez',
    '/readyz',
    '/status',
  ]) {
    app.get(p, degradedProbeHandler);
  }
  app.use((_req, res) => {
    res.status(503).json({
      ok: false,
      error: 'Server failed during startup.',
      bootError: errMsg,
      bootPhase: lastBootPhase,
      bootMarker: 'po-line-type-migrate-v4',
      mysqlTarget,
      fixHint:
        'See GET /api/health for mysqlTarget, bootPhase, bootMarker, and bootError. Run: npm run mysql:smoke',
    });
  });
}

function onListen() {
  if (bootDegraded) {
    console.log(
      `[zarewa] listening DEGRADED on port ${port}${listenHost ? ` host=${listenHost}` : ''} — probes: /api/health /api/readyz … /readyz /status (see bootError in JSON)`
    );
    return;
  }
  console.log(`Zarewa listening on http://127.0.0.1:${port} (db: ${dbPath})`);
  if (listenHost === '0.0.0.0' || listenHost === '::') {
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets || []) {
        if (net && net.family === 'IPv4' && !net.internal) {
          console.log(`  Same network: http://${net.address}:${port}`);
        }
      }
    }
  }
  const ai = readAiAssistConfig();
  if (!ai.enabled) {
    console.log(
      '[zarewa] AI assistant off — set ZAREWA_AI_API_KEY (or OPENAI_API_KEY). Local Ollama: ZAREWA_AI_BASE_URL=http://127.0.0.1:11434/v1 ZAREWA_AI_API_KEY=ollama ZAREWA_AI_MODEL=llama3.2'
    );
  } else {
    console.log(`[zarewa] AI assistant on (model: ${ai.model}).`);
  }
}

if (listenHost) {
  app.listen(port, listenHost, onListen);
} else {
  app.listen(port, onListen);
}
