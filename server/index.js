import os from 'node:os';
import express from 'express';
import { readAiAssistConfig } from './aiAssist.js';
import { createDatabase, defaultDbPath } from './db.js';
import { createApp } from './app.js';
import { loadProjectEnv } from './loadProjectEnv.js';

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
  console.error('[zarewa] Startup failed — minimal HTTP only until fixed:', errMsg);
  console.error(e);
  dbPath = '(not connected)';
  app = express();
  app.disable('x-powered-by');
  app.get('/api/health', (_req, res) => {
    res.status(200).json({
      ok: false,
      service: 'zarewa-api',
      degraded: true,
      database: false,
      bootError: errMsg,
      time: new Date().toISOString(),
    });
  });
  app.use((_req, res) => {
    res.status(503).json({
      ok: false,
      error: 'Server failed during startup.',
      bootError: errMsg,
    });
  });
}

function onListen() {
  if (bootDegraded) {
    console.log(
      `[zarewa] listening DEGRADED on port ${port}${listenHost ? ` host=${listenHost}` : ''} — check bootError from GET /api/health`
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
