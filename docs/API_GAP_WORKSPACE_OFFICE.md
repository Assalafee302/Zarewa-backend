# API gap — Online Office Workspace

## Implemented / extended in overhaul

| Area | Endpoint / module |
|------|-------------------|
| BM edit versions | `PATCH /api/office/threads/:id` + `office_record_versions` |
| Filing numbers | `POST /api/office/threads/:id/file` + `filingNumberOps.js` |
| Official notices | `/api/official-notices/*` |
| Office forum | `/api/forum/*` |
| Approval routing | `shared/lib/officeApprovalRouting.js` |
| Staff create | `office.record.create` on `POST /api/office/threads` |

## Reused (no new tables)

- `office_threads`, `office_messages`, `work_items`
- `convert-payment-request`, `convert-material-request`
- `GET /api/work-items/:id/timeline`, `/related`
- Bootstrap + branch scope unchanged
