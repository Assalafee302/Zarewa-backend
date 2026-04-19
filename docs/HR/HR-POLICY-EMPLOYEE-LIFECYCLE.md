# HR Policy: Employee Lifecycle

## Scope
- Recruitment, onboarding, probation, confirmation, transfers, promotion, and separation.

## Required Controls
- Mandatory staff profile fields for all active staff.
- Probation and confirmation dates tracked and reportable.
- Promotion and transfer history preserved in immutable audit events.
- Separation workflow requires reason, effective date, and approval.

## System Rules
- `hr_staff_profiles` remains canonical employee master record.
- Any status-affecting action writes `hr_audit_events`.
- Branch scope applies to every lifecycle action.
