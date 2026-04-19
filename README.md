# Zarewa Backend

Backend API for **Zarewa** — an integrated operations platform for sales, procurement, production, inventory, customer finance (ledger, advances, refunds), general ledger, treasury controls, office workflows, HR, and executive reporting. This service is a **Node.js** application built with **Express 5** and **SQLite** (`better-sqlite3`), exposing a JSON **REST API** under `/api`.

---

## Table of contents

- [Architecture at a glance](#architecture-at-a-glance)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [HTTP API overview](#http-api-overview)
- [Authentication and security](#authentication-and-security)
- [Database](#database)
- [Development workflows](#development-workflows)
- [Testing](#testing)
- [Scripts reference](#scripts-reference)
- [Deployment and operations](#deployment-and-operations)
- [Documentation index](#documentation-index)
- [Repository layout vs. monorepo](#repository-layout-vs-monorepo)

---

## Architecture at a glance

| Layer | Technology |
|--------|------------|
| HTTP server | Express 5 (`server/app.js`, `server/index.js`) |
| Persistence | SQLite with WAL, foreign keys (`server/db.js`) |
| Schema | Applied from `server/schemaSql.js`, evolved via migrations (`server/migrate.js`) |
| Auth | Cookie-backed sessions + CSRF for mutating requests; optional Firebase ID token login (`server/auth.js`) |
| AI (optional) | OpenAI-compatible chat when API keys are set (`server/aiAssist.js`) |

On startup the process creates the database file if needed, runs migrations, seeds baseline data (unless empty-seed mode), and optionally ensures a legacy demo pack for development. Static assets: if `dist/index.html` exists (or `ZAREWA_STATIC_DIR` points at a built SPA), the same process can serve the frontend and API on one origin.

**Shared domain logic** used by both the API and the SPA lives under [`shared/`](shared/) (ledger math, notifications helpers, refund stores, etc.). Dev and release tooling still expects a **sibling `frontend/`** package for Vite and `npm run verify:complete` — see [Repository layout vs. monorepo](#repository-layout-vs-monorepo).

---

## Prerequisites

- **Node.js** — Use a current LTS (production docs target **Node 20**; align with your CI or host image).
- **npm** — For installing dependencies and running scripts.
- **Native build toolchain** — `better-sqlite3` may compile on install; on Linux you may need `build-essential` (see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).

---

## Quick start

```bash
git clone <repository-url>
cd Zarewa-backend
npm install
npm run server
```

The server listens on **`http://127.0.0.1:8787`** by default (`PORT` overrides this). The default database file is **`data/zarewa.sqlite`** (created automatically).

**Smoke check:** `GET /api/health` should return a simple OK payload.

---

## Configuration

Environment variables are documented in **[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md)**. Highlights:

| Concern | Variables (examples) |
|--------|------------------------|
| Database | `ZAREWA_DB` — path to SQLite file or `:memory:` for tests |
| Listen | `PORT`, optional `ZAREWA_LISTEN_HOST` (e.g. `0.0.0.0` for LAN) |
| CORS / cookies | `CORS_ORIGIN`, `NODE_ENV`, `COOKIE_SECURE`, `ZAREWA_COOKIE_SAMESITE` |
| Static SPA | `ZAREWA_STATIC_DIR` — folder containing built `index.html` |
| AI assistant | `ZAREWA_AI_API_KEY` / `OPENAI_API_KEY`, optional `ZAREWA_AI_BASE_URL`, `ZAREWA_AI_MODEL` |
| Empty client DB | `ZAREWA_EMPTY_SEED` — minimal seed after wipe for UAT |
| E2E | `E2E_UI_PORT`, `E2E_API_PORT`, `E2E_REUSE_SERVER` |

Do not commit secrets; use your host environment or a local `.env` loaded by your process manager.

---

## Project layout

| Path | Role |
|------|------|
| [`server/`](server/) | Express app, HTTP routes (`httpApi.js`), auth, migrations, domain modules, `index.js` entry |
| [`shared/`](shared/) | Isomorphic helpers and constants shared with the frontend package |
| [`scripts/`](scripts/) | Dev stack, DB utilities, imports, stress tests, deploy helpers |
| [`e2e/`](e2e/) | Playwright end-to-end specs |
| [`data/`](data/) | Default SQLite path (`zarewa.sqlite`); often gitignored for real data |
| [`docs/`](docs/) | Environment, access control, deployment, finance, HR, and runbooks |

---

## HTTP API overview

All application routes are prefixed with **`/api`**. Implementation is centralized in [`server/httpApi.js`](server/httpApi.js). The surface area is large; below is a **domain-oriented** map (not an exhaustive path list).

### Public / bootstrap

- **`GET /api/health`** — Liveness.
- **`GET /api/bootstrap`** — Workspace bootstrap payload (branches, permissions context, etc.; used by the SPA).
- **`GET /api/session`** — Current session (or anonymous).

### Session and identity

- Password login, logout, forgot/reset password, change password, profile and dashboard preferences.
- **`POST /api/session/firebase`** — Exchange Firebase ID token for a server session (when configured).
- Workspace/branch selection on the session.

### Administration and RBAC

- User listing and creation, role and permission patches, workspace department hooks, org setup targets.
- Role definitions and permission checks are implemented in [`server/auth.js`](server/auth.js); matrices and policies are described in **[`docs/RBAC_MATRIX.md`](docs/RBAC_MATRIX.md)** and **[`docs/ACCESS_CONTROL.md`](docs/ACCESS_CONTROL.md)**.

### Sales, customers, and ledger

- Customers, quotations, cutting lists, customer ledger entries, advances, receipts, refunds, refund intelligence, audit logs.
- Branch-scoped enforcement for ledger posting ([`server/branchScope.js`](server/branchScope.js)).

### Procurement and inventory

- Suppliers, transport agents, purchase orders (including transport, GRN, supplier payments), stone inventory and receipts, stock views.

### Production

- Cutting-list and production-job flows: allocations, start/complete, conversion preview, manager review, cancellations.

### Finance and control

- GL accounts, trial balance, journals, journal posting, reports, executive summary.
- Treasury, payment/refund requests, accounting period locks, bank reconciliation import paths, inter-branch loans (where exposed).

### Pricing

- Price list and material pricing sheet maintenance (permission-gated, including MD price-exception flows).

### Office and work management

- Office threads, messages, directory, filing, AI-assisted memo polish / filing (when AI is enabled), compose templates, inter-branch requests, unified **work items** and material requests.

### Other

- Workspace search, dashboard summaries, management targets/reviews, MD operations pack report, optional **`/api/ai/*`** routes for assistant status and chat.

For deep behavior (refunds, accounting policies, office runbooks), use the [documentation index](#documentation-index).

---

## Authentication and security

- **Sessions** — Opaque tokens stored server-side; cookies used for browser clients. Mutating requests expect **CSRF** token alignment (see comments in `server/auth.js` and tests in `server/csrfEnforcement.test.js`).
- **Permissions** — Route handlers use `requirePermission(...)` with fine-grained keys (sales, finance, production, HR, etc.).
- **CORS** — Configured in [`server/app.js`](server/app.js); production should use an explicit allowlist (`CORS_ORIGIN`), not `*`.
- **Headers** — Security headers (CSP, frame denial, nosniff, referrer policy) are set in `app.js`.
- **Rate limiting** — Ledger-related POST rate limits are configurable via `ZAREWA_LEDGER_POST_MAX` and `ZAREWA_LEDGER_POST_WINDOW_MS` (see `docs/ENVIRONMENT.md`).

---

## Database

- **Default file:** `data/zarewa.sqlite` (override with `ZAREWA_DB`).
- **Modes:** WAL journaling, foreign keys enabled.
- **Migrations:** Run automatically on open; manual CLI: **`npm run db:migrate`**.
- **Wipe local DB:** **`npm run db:wipe`** (destructive; development).
- **Empty-client seed:** after wipe, **`ZAREWA_EMPTY_SEED=1`** with a fresh DB gives minimal data — see `docs/ENVIRONMENT.md`.
- **Backups:** For production, schedule file-level backups of the SQLite file (and `-wal`/`-shm` sidecars if present).

---

## Development workflows

### API only

```bash
npm run server
# or
node server/index.js
```

### API + Vite (full UI stack)

From this repo, with a **`frontend/`** sibling (or **`ZAREWA_FRONTEND_ROOT`** set):

```bash
npm run dev:stack
```

This starts the API (default `0.0.0.0` for LAN-friendly dev) and the Vite dev server. See [`scripts/dev-stack.mjs`](scripts/dev-stack.mjs).

### LAN / device testing

Use **`npm run start:lan`** or set `ZAREWA_LISTEN_HOST=0.0.0.0` so phones on the same Wi‑Fi can reach the API; CORS in development can allow private LAN origins when enabled in `app.js`.

---

## Testing

| Command | Purpose |
|---------|---------|
| **`npm run lint`** | ESLint across the repo |
| **`npm test`** | Vitest — `server/**/*.test.js`, `shared/**/*.test.js` |
| **`npm run test:watch`** | Vitest watch mode |
| **`npm run test:e2e`** | Playwright — starts API + UI via `scripts/e2e-web.mjs` and runs `e2e/` |
| **`npm run test:all`** | Vitest + Playwright |

Focused suites (examples from `package.json`): `test:transactions`, `test:operations`, `test:financial`, `test:critical-workflows`, `verify:ci` (lint + transaction tests).

**E2E database:** Playwright uses `data/playwright.sqlite` by default. Reset only that file: **`npm run wipe:e2e-db`**. Port conflicts: set `E2E_UI_PORT` / `E2E_API_PORT` per `docs/ENVIRONMENT.md`.

**Full release gate (requires sibling frontend):** **`npm run verify:complete`** — production frontend build, full Vitest, full Playwright.

---

## Scripts reference

Beyond tests and the server, notable `npm` scripts include:

- **Imports / data:** `hr:import-staff`, `import:access-sales`, `import:access-staging`, `import:access-finance`, `import:validate`, and related merge/legacy helpers.
- **Stress / QA:** `stress:api`, `stress:lifecycle`, `stress:qa-mega`, `stress:finance100`, etc.
- **Maintenance:** `retention:prune`, `bench:dashboard`.
- **Verification:** `verify:split-deploy`, `verify:complete`.

See [`package.json`](package.json) for the full list and exact command names.

---

## Deployment and operations

- **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** — Checklist, HTTPS, cookies, Ubuntu/systemd notes.
- **[`scripts/deploy/README.md`](scripts/deploy/README.md)** — Automated server setup path.
- **[`docs/SPLIT_DEPLOYMENT_AND_MIGRATION.md`](docs/SPLIT_DEPLOYMENT_AND_MIGRATION.md)** — API and static UI on different hosts.
- **Post-deploy smoke:** `npm run verify:split-deploy` with `ZAREWA_VERIFY_API_ORIGIN` (see `docs/ENVIRONMENT.md`).

---

## Documentation index

| Topic | Document |
|-------|----------|
| Environment variables | [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) |
| Access control | [`docs/ACCESS_CONTROL.md`](docs/ACCESS_CONTROL.md) |
| RBAC matrix | [`docs/RBAC_MATRIX.md`](docs/RBAC_MATRIX.md) |
| Deployment | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |
| Split deploy / migration | [`docs/SPLIT_DEPLOYMENT_AND_MIGRATION.md`](docs/SPLIT_DEPLOYMENT_AND_MIGRATION.md) |
| Refunds | [`docs/REFUND_OPERATIONS.md`](docs/REFUND_OPERATIONS.md) |
| Accounting policies | [`docs/ACCOUNTING_POLICIES.md`](docs/ACCOUNTING_POLICIES.md) |
| QA gates | [`docs/QA_GATES.md`](docs/QA_GATES.md) |
| Office operations | [`docs/OFFICE_OPERATIONS_RUNBOOK.md`](docs/OFFICE_OPERATIONS_RUNBOOK.md) |
| HR policies | [`docs/HR/`](docs/HR/) |
| Backend-only / monorepo | [`docs/DUAL_REPO_BACKEND.md`](docs/DUAL_REPO_BACKEND.md) |

---

## Repository layout vs. monorepo

- **Shared code** for API + UI lives in **`shared/`** in this tree.
- **Frontend dev and full verification** expect the Vite app in a sibling directory: **`../frontend`**, unless **`ZAREWA_FRONTEND_ROOT`** points elsewhere ([`scripts/frontendPaths.mjs`](scripts/frontendPaths.mjs)).
- If you maintain **only** this backend repository, read **[`docs/DUAL_REPO_BACKEND.md`](docs/DUAL_REPO_BACKEND.md)** for integration options (sibling clone, submodule, or future packaging of shared modules).

---

## License / support

Package **`@zarewa/backend`** is marked **private** in `package.json`. For internal policies, stakeholder demos, and staff-facing summaries, see additional materials under `docs/` (for example `STAKEHOLDER_DEMO_PLAYBOOK.md`, `STAFF_APPROVALS.md`).
