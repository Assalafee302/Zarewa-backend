# HR Policy Control Matrix

This matrix maps handbook policy statements to enforceable system controls.

## Governance

- Source handbook sections:
  - Mission / vision / overview
  - Equal employment opportunity
  - Anti-harassment
  - Hours of work, attendance, punctuality
  - Personnel records confidentiality
  - Computer and information security
  - Employee receipt and acceptance

## Control Mapping

| Policy Area | Required Control | System Enforcement |
| --- | --- | --- |
| Equal employment opportunity | Non-discriminatory HR actions | Structured request reasons + audit trail on approvals/rejections |
| Anti-harassment | Case intake and investigation log | HR incident request type + restricted visibility + immutable events |
| Attendance and punctuality | Time windows, exceptions, corrections | Attendance events, lateness flags, correction request workflow |
| Personnel records confidentiality | Need-to-know access model | Field-level access policy by role and branch scope |
| IT and information security | Controlled credential and data handling | RBAC checks, sensitive data masking, audited privileged reads |
| Handbook acknowledgement | Signed/versioned acceptance | Policy acceptance records with version, timestamp, actor metadata |

## Required Technical Guarantees

- Every state transition writes an `hr_audit_events` record.
- Sensitive fields are masked for unauthorized viewers.
- Branch-scoped users can only access matching branch records.
- Approvals require an explicit remark and actor identity.
- Policy acceptance is versioned and immutable.
