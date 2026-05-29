# HR Policy: Recruiting and Hiring

## Scope

- Internal job postings, applicant pipeline, public careers applications, interview scorecards, offer letters, and hire-to-register.

## Required Controls

- Only HR (`hr.staff.manage`) may create or close job postings and move applicants through the pipeline.
- Public applications accept only **open** postings (`status = open`).
- Offer letters require HR action; amounts and start dates are captured at generation time.
- Hired applicants link to staff registration via `applicantId` prefill.

## System Rules

| Capability | Storage / API |
|------------|----------------|
| Job postings | `hr_job_postings` — `GET/POST/PATCH /api/hr/recruiting/jobs` |
| Applicants | `hr_job_applicants` — scorecards in `interview_scores_json`, offers in `offer_letter_text` |
| Public careers (no login) | `GET /api/public/careers/jobs`, `POST /api/public/careers/jobs/:jobId/apply` |
| Interview criteria | `GET /api/hr/recruiting/interview-criteria` |
| Offer letter | `POST /api/hr/recruiting/applicants/:id/offer-letter` |
| Register from hire | `GET /api/hr/recruiting/applicants/:id/prefill` → `/hr/staff/register?applicantId=…` |

## Frontend

- **HR:** `/hr/recruiting` — pipeline, scorecards, offer letters, link to public careers.
- **Public:** `/careers` — browse open roles and apply (no staff session).

## Audit

- Applicant status changes and offer letter generation should be traceable via `hr_job_applicants.updated_at_iso` and HR audit where mutating routes append events.

## Related

- [HR-POLICY-EMPLOYEE-LIFECYCLE.md](./HR-POLICY-EMPLOYEE-LIFECYCLE.md) — onboarding after hire.
- [HR-V2-FEATURES.md](./HR-V2-FEATURES.md) — learning, engagement, org chart, notifications.
