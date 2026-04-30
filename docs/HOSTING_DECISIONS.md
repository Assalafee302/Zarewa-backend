# Hosting decisions (split UI + API)

Copy this table into your runbook or ticket when you cut over. Fill every **Decision** before staging or production deploy.

| Topic | Your decision | Notes |
|--------|----------------|--------|
| **UI public URL** | `https://________________` | Exact origin for `CORS_ORIGIN` (no path, no trailing slash). |
| **API public URL** | `https://________________` | Same value you bake into **`VITE_API_BASE`** for `npm run build` (no trailing slash). |
| **Same registrable domain?** | Yes / No | If **No** (e.g. `*.web.app` UI and `*.run.app` API), set **`ZAREWA_COOKIE_SAMESITE=none`** on the API. If **Yes** (e.g. `app.company.com` + `api.company.com`), **`strict`** is usually fine. |
| **SQLite file path** | `ZAREWA_DB=________________` | Must be on **durable** storage attached to the API process (volume / disk). Plan backups. |
| **UI static host** | ________________ | Firebase Hosting, Netlify, S3+CloudFront, etc. |
| **API host** | ________________ | VM, Cloud Run + volume, Fly.io, etc. |
| **TLS** | ________________ | HTTPS on both UI and API before relying on `Secure` cookies. |
| **SPA fallback** | Configured: Yes / No | All non-file routes must serve `index.html` for client-side routing. |

After you fill this out, use [`.env.split-staging.example`](../.env.split-staging.example) for environment variable names and [SPLIT_DEPLOYMENT_AND_MIGRATION.md](SPLIT_DEPLOYMENT_AND_MIGRATION.md) for the full procedure.
