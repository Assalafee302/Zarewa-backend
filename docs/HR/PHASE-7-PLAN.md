# PHASE 7 — Professional Discipline, Case Management, and Complete Company Letters

**Status:** Implemented — see `PHASE-7-COMPLETION.md`.

Phase 6 delivers governance, payroll control, staff development, engagement, analytics, and API stability. Phase 7 makes discipline and company letters fully professional, complete, and audit-ready.

---

## 1. Professional discipline case management

Replace query/warning/suspension-only tracking with full HR case management.

### Case types

Query, verbal warning, written warning, final warning, suspension, investigation, gross misconduct, negligence, absenteeism, lateness, harassment complaint, insubordination, theft/fraud allegation, damage to company property, confidentiality breach, policy violation, performance misconduct, dismissal recommendation.

### Case fields

Case number, employee, branch/HQ, department, designation, incident date, reported date, reported by, case type, severity, description, evidence/documents, witnesses, employee response, investigation officer, investigation findings, HR recommendation, management decision, sanction, appeal status, final outcome, closure date, related letters, related documents, audit timeline.

### Case statuses

Draft, Open, Awaiting employee response, Under investigation, Awaiting HR review, Awaiting management decision, Action issued, Appealed, Closed, Cancelled.

### Database (proposed)

- `hr_discipline_cases` — master case record
- `hr_discipline_case_events` — timeline entries
- `hr_discipline_case_evidence` — document links
- `hr_discipline_case_witnesses` — witness records
- `hr_discipline_appeals` — appeal workflow

### API (proposed)

- `GET/POST /api/hr/discipline-cases`
- `GET/PATCH /api/hr/discipline-cases/:id`
- `POST /api/hr/discipline-cases/:id/events`
- `POST /api/hr/discipline-cases/:id/letters/:letterType`
- `GET /api/hr/discipline-cases/:id/audit`

---

## 2. Discipline workflow

1. Create case (draft)
2. Issue query / notice to employee
3. Record employee response
4. Investigation phase (officer, findings, evidence)
5. HR review and recommendation
6. Management decision
7. Issue sanction letter (warning, suspension, dismissal, etc.)
8. Appeal if applicable
9. Close case — all letters and documents saved to employee profile
10. Full audit trail at every step

---

## 3. Discipline panel UI (`/hr/discipline-exit`)

Improve **Discipline** tab:

- Case dashboard with counts by status/severity
- Filterable case table
- Case detail drawer/modal with sections:
  - Status timeline
  - Evidence
  - Witnesses
  - Employee response
  - HR recommendation
  - Management decision
  - Related letters and documents
  - Audit trail
- Quick actions: issue query, schedule hearing, close case

**Filters:** branch, department, employee, case type, severity, status, date range, outcome.

---

## 4. Discipline reports

| Report | Export |
|--------|--------|
| Open discipline cases | CSV, Excel, PDF, Print |
| Discipline case history | CSV, Excel, PDF, Print |
| Query report | CSV, Excel, PDF, Print |
| Warning report | CSV, Excel, PDF, Print |
| Suspension report | CSV, Excel, PDF, Print |
| Dismissal recommendation report | CSV, Excel, PDF, Print |
| Cases by branch / department / severity / outcome | CSV, Excel, PDF, Print |
| Repeat offenders | CSV, Excel, PDF, Print |
| Pending employee response | CSV, Excel, PDF, Print |
| Pending management decision | CSV, Excel, PDF, Print |
| Closed cases | CSV, Excel, PDF, Print |

Wire into `HrReportsHub` under category `discipline`.

---

## 5. Company letters completion

Make all letters meaningful, professional, and linked to source records.

### Letter categories

**A. Employment** — offer, appointment, confirmation, probation extension/termination, employment verification, introduction, certificate of service, experience/reference.

**B. Salary and payroll** — salary confirmation, increment, promotion with salary change, salary hold/release, deduction notice, loan deduction, allowance approval, bonus approval.

**C. Leave and absence** — leave approval/rejection, resumption, absence query, unauthorized absence warning, sick leave acknowledgement, return-to-work.

**D. Transfer** — inter-branch, in-branch department, HQ↔branch, temporary transfer, transfer completion.

**E. Discipline** — query, hearing invitation, warning, final warning, suspension, investigation notice/outcome, dismissal, termination, appeal acknowledgement/outcome.

**F. Exit** — resignation acknowledgement/acceptance, termination, dismissal, layoff/retrenchment, exit clearance, return of property, final settlement, certificate of service.

**G. Compliance and policy** — handbook receipt, confidentiality pledge, IT security, data protection, conflict of interest, code of conduct, NDA.

**H. Training and development** — training approval/invitation/completion, promotion eligibility, career development plan.

**I. General administrative** — ID card approval/replacement, department/designation/reporting line change, address update, general HR memo.

---

## 6. Letter template quality standard

Each letter must include:

- Company name and address/contact
- Date, employee name, employee number, job title, department, branch/HQ
- Subject line and professional body text
- Relevant source record details and effective date
- Approval/signature block (prepared by, approved by, CC)
- PDF export, print preview
- Saved copy on employee profile
- Source record link and version/history

No single-paragraph placeholder letters where business context requires more detail.

---

## 7. Letter generation UI (`/hr/documents?tab=letters`)

- Grouped letter categories (A–I above)
- Letter type search
- Required field checklist before generation
- Source record selector (case, transfer, leave request, payroll run, etc.)
- Preview before generate
- Missing data warnings
- Save as draft → generate PDF → print → save to profile
- Letter history and linked source record on profile

---

## 8. Policy documents

Complete acknowledgements for handbook, confidentiality, IT security, data protection, code of conduct, anti-harassment, equal employment opportunity.

Track: version, date signed, signed by, witness/HR officer, PDF copy, expiry/re-acknowledgement schedule.

---

## 9. Phase 7 implementation checklist (for future delivery)

When Phase 7 is implemented, the completion response should include:

- **A.** Discipline case tables/APIs added
- **B.** Discipline workflows completed
- **C.** Discipline UI improvements
- **D.** Discipline reports added
- **E.** Letter categories completed
- **F.** Letter templates added/improved
- **G.** Source record linking completed
- **H.** Policy acknowledgement improvements
- **I.** Tests run and results
- **J.** Remaining limitations

---

## Dependencies on Phase 6

Phase 7 builds on Phase 6 audit trail, grievance workflow, exit interviews, and letter infrastructure. Ensure Phase 6 migrations and `/api/hr/health` are green before starting Phase 7.

## Explicitly out of scope for Phase 7

- Overtime payroll calculation (remains tracking/approval only)
- Biometric/time-clock integration
- Attendance automation beyond daily roll
