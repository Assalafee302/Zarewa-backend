# Zarewa backend (API + SQLite)

Express + `better-sqlite3`. Entry: `server/index.js`.

## Quick start

```bash
npm install
npm run server
```

Default DB: `data/zarewa.sqlite` (see `docs/ENVIRONMENT.md`).

## Layout note (`frontend/src/lib`)

Parts of `server/` import isomorphic helpers from **`../frontend/src/lib/`** (paths are relative to `server/`). In this monorepo, keep **`frontend/`** as a sibling of **`backend/`**. If you ship **backend-only** in its own Git repository, see [`docs/DUAL_REPO_BACKEND.md`](docs/DUAL_REPO_BACKEND.md).

## API + Vite together

From this directory, **`npm run dev:stack`** starts the API and the SPA from **`../frontend`** (override with **`ZAREWA_FRONTEND_ROOT`**).

## Tests

- `npm run test` — Vitest (`server/**/*.test.js`, `shared/**/*.test.js`)
- `npm run test:e2e` — Playwright (starts API + Vite via `scripts/e2e-web.mjs`)

## Docs

See `docs/` for environment variables, split deployment, access control, and operations.
