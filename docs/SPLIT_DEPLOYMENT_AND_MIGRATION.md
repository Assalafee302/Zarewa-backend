# Split deployment and backend migration

This document is the **canonical plan** for running the **React (Vite) frontend** and the **Node + SQLite API** as separate deployables, and for any later move toward managed services (for example Firebase).

## Current architecture (baseline)

| Layer | Location | Notes |
|--------|----------|--------|
| UI | `src/` — Vite build → `dist/` | Calls `/api/...` via `apiFetch` / `apiUrl` in `src/lib/apiBase.js`. |
| API | `server/` — Express | SQLite file (`ZAREWA_DB`), session cookies, CSRF on mutating requests. |
| Same-origin option | `ZAREWA_STATIC_DIR` / `dist` | If `dist/index.html` exists, the API process can also serve the SPA (today’s simple single-host deploy). |

The client already supports a **separate API origin** by setting **`VITE_API_BASE`** at build time (for example `https://api.yourcompany.com` with **no** trailing slash). When it is empty, dev uses the Vite proxy in **`frontend/vite.config.js`** and production can keep same-origin.

---

## Phase A — Split deploy (recommended first step)

**Goal:** UI on one host (CDN / Firebase Hosting / S3+CloudFront), API on another (VM, Cloud Run, Fly.io, etc.), **same business logic and SQLite**.

### A.1 Build-time (frontend)

1. Set **`VITE_API_BASE`** to the public HTTPS origin of the API (example: `https://api.zarewa.internal`).
2. Run `npm run build`; deploy the **`dist/`** output to static hosting.
3. Ensure static hosting **rewrites** unknown paths to `index.html` for client-side routing (SPA fallback).

### A.2 Runtime (API)

1. **`CORS_ORIGIN`** — comma-separated list of **exact** UI origins (`https://app.example.com`, not `*`) in production. Include every environment (staging, production).
2. **`NODE_ENV=production`** and **`COOKIE_SECURE=1`** (or rely on production default) so session cookies use **HTTPS**.
3. **`ZAREWA_COOKIE_SAMESITE`** — see [Cross-origin cookies](#cross-origin-cookies).
4. **`ZAREWA_DB`** — path to the SQLite file on the API host (persistent volume / disk).
5. Do **not** rely on the API serving `dist/` unless you intentionally keep a single-host setup (`ZAREWA_STATIC_DIR`).

### A.3 Verification checklist

**Automated (API reachable from your machine or CI):**

```bash
ZAREWA_VERIFY_API_ORIGIN=https://your-api-host npm run verify:split-deploy
# Optional: assert CORS allows your SPA origin
ZAREWA_VERIFY_API_ORIGIN=https://your-api-host ZAREWA_VERIFY_UI_ORIGIN=https://your-ui-host npm run verify:split-deploy
```

**Manual (browser):**

- [ ] Login from the deployed UI; confirm session persists across refresh.
- [ ] A mutating action (POST) succeeds (CSRF + cookies working).
- [ ] Download links that use `apiUrl(...)` (CSV, attachments) open or download correctly.
- [ ] LAN / mobile: if you use non-localhost origins, they are listed in `CORS_ORIGIN`.

Fill [HOSTING_DECISIONS.md](HOSTING_DECISIONS.md) before go-live; staging env names live in **`.env.split-staging.example`** at the backend package root (sibling to `server/`).

### A.4 Repository / CI (optional hygiene)

- **Monorepo** is fine: keep one repo with `npm run build` (UI) and `node server/index.js` (API) as separate pipeline jobs or images.
- **GitHub Actions:** CI uploads a **`dist/` artifact** built with **`VITE_API_BASE`** set (see `.github/workflows/ci.yml`, job `frontend_split_artifact`) so split-style production builds are exercised every PR; download **`zarewa-frontend-dist`** when wiring a deploy workflow.
- **API image / host:** this repo does not ship a Dockerfile; add your own container or process manager and inject secrets from the platform (mirror **`.env.split-staging.example`**).
- **Split repos** later: copy `server/` (and shared modules if you extract them) into an API repo; UI repo keeps `src/` + Vite config; align versions of any shared packages.

---

## Cross-origin cookies

Session and CSRF cookies are set by the API (`server/auth.js`).

- **Same registrable domain** (example: UI `https://app.company.com`, API `https://api.company.com`): **`ZAREWA_COOKIE_SAMESITE=strict`** (default) is usually acceptable in modern browsers (schemeful same-site).
- **Different sites** (example: UI on `*.web.app`, API on `*.run.app`, or any unrelated domains): you need **`ZAREWA_COOKIE_SAMESITE=none`**. Browsers require **`SameSite=None; Secure`** — the server forces **Secure** when SameSite is `none`, even if `COOKIE_SECURE` would otherwise be off.

If login succeeds but subsequent requests are anonymous, first check CORS credentials and then SameSite / HTTPS.

---

## Phase B — Operational hardening (still SQLite + Node)

Do these when the API is exposed on the public internet:

- TLS termination (reverse proxy or platform-managed HTTPS).
- File backups for `ZAREWA_DB` (see `docs/ENVIRONMENT.md`).
- Rate limits and monitoring (existing env knobs for ledger limits; add platform-level limits as needed).
- Rotate seeded passwords; tighten `docs/DEPLOYMENT.md` items.

---

## Phase C — “Different backend” (optional, large change)

Replacing **Express + SQLite** with **Firebase** (Firestore + Auth + Functions) or another database is **not** a configuration change: it is a **reimplementation** of persistence, auth, and most of `server/httpApi.js`.

Suggested approach if you ever commit to it:

1. **Inventory** — table/route map from SQLite schema and `server/httpApi.js` to target services.
2. **Auth** — move from cookie sessions to Firebase Auth (or similar) and issue **verified** identity to your API layer (often Cloud Functions or a small Node service).
3. **Data** — model Firestore (or SQL on Cloud SQL) per access patterns; plan **migrations** and **dual-write** or one-off ETL from SQLite.
4. **Parity** — re-run Vitest/Playwright against the new stack or maintain a contract test suite.

Phase A does **not** depend on Phase C; completing Phase A makes Phase C easier because the UI is already decoupled by origin.

---

## Quick reference — env vars for split deploy

| Variable | Role |
|----------|------|
| `VITE_API_BASE` | Built into the SPA; full API origin, no trailing slash. |
| `CORS_ORIGIN` | Allowed browser origins for the API. |
| `ZAREWA_COOKIE_SAMESITE` | `strict` (default), `lax`, or `none` for cross-site. |
| `COOKIE_SECURE` / `NODE_ENV` | HTTPS cookies in production. |

See also [ENVIRONMENT.md](ENVIRONMENT.md), **`.env.example`**, and **`.env.split-staging.example`** in this package (split staging variable list; `.env` is gitignored). The SPA has its own **`frontend/.env.example`** for `VITE_API_BASE`.
