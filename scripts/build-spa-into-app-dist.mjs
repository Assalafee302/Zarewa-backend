/**
 * Hostinger / same-origin deploy: build the Vite SPA and copy it to app/dist
 * so ZAREWA_STATIC_DIR=app/dist is populated.
 *
 * SPA root resolution (first match wins):
 * 1. ZAREWA_SPA_ROOT — explicit path (e.g. ./frontend submodule)
 * 2. Sibling checkout — ../Zarewa-frontend-main, ../frontend, ./frontend
 * 3. Git clone — ZAREWA_SPA_GIT_URL (default: Zarewa-frontend on GitHub) into .build/spa
 *
 * Set ZAREWA_SKIP_SPA_BUILD=1 to skip (API-only builds).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { debugAgentLog } from './debug-agent-log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');
const appDist = path.join(backendRoot, 'app', 'dist');
const DEFAULT_SPA_GIT_URL = 'https://github.com/Assalafee302/Zarewa-frontend.git';
const cloneDir = path.join(backendRoot, '.build', 'spa');

function readDeployIdentity() {
  const pkg = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8'));
  let sha = 'unknown';
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: backendRoot,
    encoding: 'utf8',
  });
  if (r.status === 0) sha = String(r.stdout || '').trim();
  console.log(`[zarewa] DEPLOY REPO: ${pkg.name} @ ${sha}`);
  console.log('[zarewa] Hostinger GitHub link must be: Assalafee302/Zarewa-backend');
  return { packageName: pkg.name, sha };
}

function run(cmd, args, cwd, env = process.env) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function hasSpaPackage(dir) {
  return fs.existsSync(path.join(dir, 'package.json'));
}

function resolveSiblingSpaRoot() {
  const candidates = [
    path.join(backendRoot, 'frontend'),
    path.join(backendRoot, '..', 'Zarewa-frontend-main'),
    path.join(backendRoot, '..', 'Zarewa-frontend'),
    path.join(backendRoot, '..', 'frontend'),
  ];
  for (const candidate of candidates) {
    if (hasSpaPackage(candidate)) return path.resolve(candidate);
  }
  return null;
}

function cloneSpaFromGit() {
  const gitUrl = String(process.env.ZAREWA_SPA_GIT_URL || DEFAULT_SPA_GIT_URL).trim();
  const gitRef = String(process.env.ZAREWA_SPA_GIT_REF || 'main').trim();
  fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
  if (fs.existsSync(cloneDir)) {
    fs.rmSync(cloneDir, { recursive: true, force: true });
  }
  console.log(`[zarewa] SPA clone: ${gitUrl} (${gitRef}) → ${cloneDir}`);
  run('git', ['clone', '--depth', '1', '--branch', gitRef, gitUrl, cloneDir], backendRoot);
  if (!hasSpaPackage(cloneDir)) {
    console.error(`[zarewa] Cloned repo at ${cloneDir} has no package.json.`);
    process.exit(1);
  }
  return cloneDir;
}

function resolveSpaRoot() {
  const forceGit = String(process.env.ZAREWA_SPA_FORCE_GIT || '').trim() === '1';

  const explicit = String(process.env.ZAREWA_SPA_ROOT || '').trim();
  if (explicit) {
    const resolved = path.resolve(backendRoot, explicit);
    if (!hasSpaPackage(resolved)) {
      console.error(`[zarewa] ZAREWA_SPA_ROOT=${explicit} resolved to ${resolved} — no package.json.`);
      process.exit(1);
    }
    return { spaRoot: resolved, source: 'ZAREWA_SPA_ROOT' };
  }

  if (!forceGit) {
    const sibling = resolveSiblingSpaRoot();
    if (sibling) {
      return { spaRoot: sibling, source: 'sibling' };
    }
  }

  if (String(process.env.ZAREWA_SKIP_SPA_BUILD || '').trim() === '1') {
    return { spaRoot: null, source: 'skipped' };
  }

  return { spaRoot: cloneSpaFromGit(), source: 'git-clone' };
}

const { spaRoot, source } = resolveSpaRoot();
const deployIdentity = readDeployIdentity();

// #region agent log
debugAgentLog({
  hypothesisId: 'A',
  location: 'build-spa-into-app-dist.mjs:resolve',
  message: 'SPA root resolution',
  data: {
    source,
    spaRoot: spaRoot || null,
    skip: process.env.ZAREWA_SKIP_SPA_BUILD || null,
    nodeEnv: process.env.NODE_ENV || null,
    cwd: process.cwd(),
    deployPackage: deployIdentity.packageName,
    deploySha: deployIdentity.sha,
  },
  runId: process.env.ZAREWA_DEBUG_RUN_ID || 'pre-fix',
});
// #endregion

if (!spaRoot) {
  console.log('[zarewa] SPA build skipped (ZAREWA_SKIP_SPA_BUILD=1).');
  process.exit(0);
}

const spaPkg = path.join(spaRoot, 'package.json');
const useOmitDev =
  source === 'git-clone' ||
  String(process.env.ZAREWA_SPA_NPM_OMIT_DEV || '').trim() === '1' ||
  String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

console.log(`[zarewa] SPA build root: ${spaRoot} (${source})`);
console.log(`[zarewa] SPA build: npm ci${useOmitDev ? ' --omit=dev' : ''} in ${spaRoot}`);
run('npm', useOmitDev ? ['ci', '--omit=dev'] : ['ci'], spaRoot);

const buildScript = String(process.env.ZAREWA_SPA_BUILD_SCRIPT || 'build:serve:lan').trim();
console.log(`[zarewa] SPA build: npm run ${buildScript} in ${spaRoot}`);
run('npm', ['run', buildScript], spaRoot);

const viteDist = path.join(spaRoot, 'dist');
const indexHtml = path.join(viteDist, 'index.html');

// #region agent log
debugAgentLog({
  hypothesisId: 'B',
  location: 'build-spa-into-app-dist.mjs:post-build',
  message: 'SPA build output check',
  data: {
    indexHtmlExists: fs.existsSync(indexHtml),
    viteDist,
    assetCount: fs.existsSync(viteDist)
      ? fs.readdirSync(viteDist, { recursive: true }).length
      : 0,
  },
  runId: process.env.ZAREWA_DEBUG_RUN_ID || 'pre-fix',
});
// #endregion

if (!fs.existsSync(indexHtml)) {
  console.error(`[zarewa] Expected ${indexHtml} after frontend build.`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(appDist), { recursive: true });
fs.rmSync(appDist, { recursive: true, force: true });
fs.cpSync(viteDist, appDist, { recursive: true });

// #region agent log
debugAgentLog({
  hypothesisId: 'C',
  location: 'build-spa-into-app-dist.mjs:copy',
  message: 'Copied SPA to app/dist',
  data: {
    appDist,
    appIndexExists: fs.existsSync(path.join(appDist, 'index.html')),
  },
  runId: process.env.ZAREWA_DEBUG_RUN_ID || 'pre-fix',
});
// #endregion

console.log(`[zarewa] Copied SPA dist → ${appDist}`);
