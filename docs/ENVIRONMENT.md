# Environment variables (Zarewa API)

Use these when deploying or running automated tests. There is no committed `.env` in the repo; set values in your host environment or your deployment platform.

| Variable | Purpose |
|----------|---------|
| `VITE_API_BASE` | **Frontend (build-time).** Public origin of the API, no trailing slash (example: `https://api.example.com`). When unset, the SPA uses relative `/api` URLs (Vite dev proxy to `127.0.0.1:8787`, or same-origin when the API serves `dist/`). Set this for **split static + API** production builds. |
| `NODE_ENV` | Set to `production` in live environments. Affects cookie `Secure` flag (see below) and CORS defaults in `server/app.js`. |
| `COOKIE_SECURE` | If `1` or `true`, session and CSRF cookies use the `Secure` attribute. If unset, `Secure` is enabled when `NODE_ENV=production`. Set **`0` or `false`** to force **no** `Secure` flag (e.g. HTTP trial by IP); use HTTPS and `1` for real deployments. |
| `ZAREWA_MYSQL_HOST` | MySQL host (default `127.0.0.1`). |
| `ZAREWA_MYSQL_PORT` | MySQL port (default `3306`). |
| `ZAREWA_MYSQL_USER` | MySQL user (default `root`). |
| `ZAREWA_MYSQL_PASSWORD` | MySQL password (default empty). |
| `ZAREWA_MYSQL_DATABASE` | Application schema name (default `zarewa_db`). |
| `ZAREWA_MYSQL_TEST_DATABASE` | Vitest schema (default `zarewa_test`). Forks append a worker suffix. |
| `ZAREWA_MYSQL_E2E_DATABASE` | Playwright E2E schema (default `zarewa_e2e`). |
| `E2E_UI_PORT` | Optional. Vite port for Playwright (default **5180**). Set when **5180 is already in use** (e.g. a leftover `e2e-web` process) so `npm run test:e2e` can start: `E2E_UI_PORT=5182 E2E_API_PORT=8789 npm run test:e2e`. |
| `E2E_API_PORT` | Optional. API port paired with `E2E_UI_PORT` (default **8788**). |
| `E2E_REUSE_SERVER` | When `1`, Playwright does not spawn `scripts/e2e-web.mjs` and expects a stack already listening on the configured ports — use only when you intentionally reuse a running dev server. |
| `PORT` | HTTP listen port (default from `server/index.js` / Playwright server). |
| `CORS_ORIGIN` | Comma-separated allowed origins for the SPA. Do not use `*` in production (`server/app.js`). |
| `ZAREWA_COOKIE_SAMESITE` | Session + CSRF cookie SameSite: `strict` (default), `lax`, or `none`. Use **`none`** only when the UI and API are **different sites** (unrelated registrable domains); the server then sends **`SameSite=None; Secure`** (HTTPS required). For typical `app.*` + `api.*` on the same company domain, `strict` or `lax` is usually enough. See `docs/SPLIT_DEPLOYMENT_AND_MIGRATION.md`. |
| `ZAREWA_COOKIE_DOMAIN` | Optional cookie domain override (example: `.example.com`) so the SPA host can read `zarewa_csrf` when UI/API run on sibling subdomains (for example `app.example.com` + `api.example.com`). Leave unset for same-origin deploys. |
| `ZAREWA_TEST_ENFORCE_CSRF` | When `1`, API tests enforce CSRF on mutating routes (optional stricter CI). |
| `ZAREWA_EMPTY_SEED` | When `1` or `true`, a **new** database gets schema, migrations, default users, master templates, one zero-balance treasury account, and HR profile stubs — **no** demo customers, quotations, receipts, procurement, or legacy demo pack. Use after `npm run db:wipe` (or `db:wipe-empty-client`) for client UAT. **Recommended for production cutover** so live document numbers are not inflated by demo data; first quotation is then `QT-{branch}-YY-0001` (see below). |
| *(built-in)* | **Document numbering:** quotations, ledger receipts, cutting lists, and most operational ids use **PREFIX-BRANCH-YY-NNNN** assigned in [`server/humanId.js`](../server/humanId.js). Example: **QT-KD-26-0001** (quotation, Kaduna branch code from [`branches`](../server/migrate.js), year **26**, sequence **0001**). The user’s **workspace branch** (`req.workspaceBranchId`, default Kaduna `BR-KD`) selects the branch segment. |
| `ZAREWA_STATIC_DIR` | Optional absolute path to the Vite `dist` folder. Defaults to `dist` under the current working directory. If `index.html` exists there, the API process also serves the SPA and client routes (same origin as `/api`). |
| `ZAREWA_AI_API_KEY` | Optional. API key for **Zare** help chat, memo polish, and the general AI dock (OpenAI-compatible). If unset, `OPENAI_API_KEY` is used. When neither is set, Zare still works from the local knowledge base; LLM polish and `/api/ai/chat` return 503. |
| `OPENAI_API_KEY` | Fallback API key when `ZAREWA_AI_API_KEY` is not set. |
| `ZAREWA_AI_BASE_URL` | Optional. Provider base URL, default `https://api.openai.com/v1`. **Gemini (OpenAI-compatible):** `https://generativelanguage.googleapis.com/v1beta/openai/` with a Google AI API key. **Ollama:** `http://127.0.0.1:11434/v1`. **Azure OpenAI:** your resource URL + `/openai/v1`. |
| `ZAREWA_AI_MODEL` | Optional. Default chat model for all AI features when help/polish models are unset. Defaults: `gpt-4o-mini` (OpenAI), `gemini-2.0-flash` (Google base URL), `llama3.2` (Ollama port 11434). |
| `ZAREWA_AI_HELP_MODEL` | Optional. Model for **Zare** `/api/help/chat` (RAG + generation). Example: `gpt-4o` or `gemini-2.0-flash`. |
| `ZAREWA_AI_POLISH_MODEL` | Optional. Model for memo polish (`/api/help/memo-assist`, `/api/office/ai/polish-memo`). Alias: `ZAREWA_AI_MEMO_MODEL`. |
| `ZAREWA_AI_HELP_MAX_TOKENS` | Optional. Max tokens for Zare LLM replies (default **2000**, max 4096). |
| `ZAREWA_AI_EMBEDDING_MODEL` | Optional. Embedding model for help RAG (`text-embedding-3-small` default). |
| `ai.knowledge.view` | Permission for **AI Knowledge Center** read access (also granted via `settings.manage` or `audit.view`). |
| `ai.knowledge.manage` | Permission to create, update, and archive knowledge center records (also via `settings.manage`). |
| `ai.query.access` | Permission to use **AI Intelligence Router** (`POST /api/ai-router/query`). |
| `ZARE_AI_UNIFIED_MODE` | When `1` or `true`, enables the **Phase 4 unified AI orchestration layer** (Router → Knowledge Center → Help fallback). When unset or `false`, all AI paths behave exactly as before Phase 4. See [`AI_UNIFICATION_LAYER.md`](AI_UNIFICATION_LAYER.md). |
| `ZARE_AI_AUTOMATION_MODE` | When `1` or `true`, enables **Phase 5 AI automation proposals** (`ai_action_proposals`). Proposals require human approve/reject; no auto-execution of payments, postings, or HR issuance. See [`AI_AUTOMATION_ENGINE.md`](AI_AUTOMATION_ENGINE.md). |
| `ZARE_AI_HUGGINGFACE_ENABLED` | When `1` or `true`, enables **Hugging Face** as a secondary AI provider in the multi-provider layer. Requires `HUGGINGFACE_API_KEY` (or `HF_TOKEN` / `ZARE_AI_HF_API_KEY`). See [`AI_PROVIDER_LAYER.md`](AI_PROVIDER_LAYER.md). |
| `HUGGINGFACE_API_KEY` / `HF_TOKEN` / `ZARE_AI_HF_API_KEY` | Hugging Face Inference API token (server-side only). |
| `ZARE_AI_HF_BASE_URL` | Optional Hugging Face inference base URL (default `https://api-inference.huggingface.co`). Set for self-hosted HF with `ZARE_AI_HF_SELF_HOSTED=true`. |
| `ZARE_AI_HF_SELF_HOSTED` | When `true`, use OpenAI-compatible `/v1/chat/completions` and `/v1/embeddings` on `ZARE_AI_HF_BASE_URL`. |
| `ZARE_AI_OPENAI_DAILY_TOKEN_LIMIT` | Optional daily OpenAI token budget (default **500000**). When exceeded, routing prefers Hugging Face. |
| `ai.proposals.view` | Permission to list and read AI action proposals. |
| `ai.proposals.manage` | Permission to create, approve, and reject AI action proposals. |
| `ZAREWA_CSP` | Optional. Overrides the `Content-Security-Policy` header for all HTTP responses (default policy is set in `server/app.js`). |
| `ZAREWA_LEDGER_POST_MAX` | Optional. Max authenticated **ledger money POSTs** (receipt, advance, apply-advance, refund-advance) per user per rolling window. Default `45`; clamped 1–50000. |
| `ZAREWA_LEDGER_POST_WINDOW_MS` | Optional. Rolling window for the ledger POST limiter in milliseconds. Default `60000` (one minute); clamped 5000–3600000. |
| `ZAREWA_TEST_SKIP_RATE_LIMIT` | When `1`, authenticated rate limiters (including ledger POSTs) are disabled — **tests and scripted stress only**, never in production. |
| `ZAREWA_VERIFY_API_ORIGIN` | **Post-deploy smoke only.** Public API base URL (no trailing slash) for `npm run verify:split-deploy` / [`scripts/verify-split-deploy.mjs`](../scripts/verify-split-deploy.mjs). |
| `ZAREWA_VERIFY_UI_ORIGIN` | **Optional.** With `ZAREWA_VERIFY_API_ORIGIN`, sends an OPTIONS preflight with this `Origin` to confirm CORS allows the SPA. |

**Reset E2E database only:** run `npm run wipe:e2e-db` to drop all tables in `ZAREWA_MYSQL_E2E_DATABASE` (default `zarewa_e2e`) so the next Playwright run starts clean. Does **not** touch the main `ZAREWA_MYSQL_DATABASE` schema.

## HR and long-lived records

HR audit events, payroll runs, discipline cases, and branch history live in the same MySQL schema as the rest of the app. For retention comparable to “life of the company”, treat **scheduled MySQL dumps / host snapshots** (and off-site copies) as the primary archive; if tables grow very large, consider yearly exports or partitioning cold `hr_*` data in a future migration.

Demo users and passwords are seeded for development and automated tests. **Before production:** change every seeded password (or replace users entirely), restrict who can create users, and run `npm run verify:complete` (or your CI equivalent) before cutover. See `docs/ACCESS_CONTROL.md`, `docs/DEPLOYMENT.md`, and the staff-facing summary `docs/STAFF_APPROVALS.md`.
