# Workspace integration tests

Pure helper tests run without MySQL:

```bash
# Backend
npm run test -- shared/lib/workspaceSanitize.test.js shared/lib/helpClearance.test.js

# Frontend
npm run test -- src/lib/workspace*.test.js src/lib/smartMemoComposer.test.js
```

Integration tests (`server/confidentialMemo.test.js`, `server/officeOps.test.js`, etc.) require a local MySQL test database on `127.0.0.1:3306`. Configure `ZAREWA_MYSQL_*` in repo-root `.env` (see `.env.example`) before running:

```bash
npm run test -- server/confidentialMemo.test.js server/officeOps.test.js
```

If MySQL is unavailable, rely on pure helper tests and manual QA on `/` workspace and `/workspace/monitoring`.
