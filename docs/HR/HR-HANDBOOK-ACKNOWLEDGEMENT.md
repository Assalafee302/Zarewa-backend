# HR Policy: Handbook Acknowledgement

## Scope
- Employee acknowledgement of handbook receipt, understanding, and acceptance.

## Required Controls
- Store policy key and version for every acceptance.
- Record acceptance timestamp, signer identity, and integrity hash.
- Keep immutable acceptance history for audit and compliance reporting.

## System Rules
- `hr_policy_acknowledgements` stores acceptance entries.
- Hash value (`record_hash`) ensures tamper-evident records.
- Acceptance actions must emit `hr_audit_events`.
