# Phase 12 — Login & Session Security

## Summary

Phase 12 strengthens sign-in, session timeout, failed-login handling, and password reset. Google SSO was removed. Sessions expire after **15 minutes of inactivity** (sliding window). Key events are written to `audit_log`. Two-factor authentication is deferred to a future phase.

## For staff

### Signing in

- Use your **username and password** on the Zarewa sign-in screen.
- Google sign-in is no longer available.
- After **5 failed attempts**, your account is **locked for 30 minutes**.
- If you are locked out, wait for the lock to expire or ask an administrator for a **reset code**.

### Password reset

1. On the sign-in screen, choose **Forgot password**.
2. Enter your username or email. An administrator delivers the **one-time reset code** (the app does not email it automatically unless your organisation configures that separately).
3. Enter the code and set a **new password** (minimum 8 characters with upper, lower, number, and special character).

### Session timeout

- After **15 minutes without API activity**, your session ends.
- You will see a **warning 1 minute before** expiry; click **Continue working** to stay signed in.
- You are redirected to sign in when the session expires.

### Access denied

- If you open a module you cannot use, you will see an **Access denied** page with guidance instead of a silent redirect.

## For IT / administrators

### Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `SESSION_TIMEOUT_MINUTES` | `15` | Inactivity session TTL (sliding, 5–480) |
| `ZAREWA_ALLOW_SEEDED_USERS` | off | Set `1` only in dev to create demo accounts |
| `ZAREWA_DEV_RESET_TOKEN` | off | Return reset token in API response (non-production only) |

### Default / seeded accounts

- Demo users (`admin`, `sales.staff`, etc.) are **not created** unless `ZAREWA_ALLOW_SEEDED_USERS=1` or `NODE_ENV=test`.
- Migration clears `registered_password` and forces `must_change_password` on known demo usernames when seeded users are disabled.
- **Passwords are never shown** in Team & access; use **Reset code** only.

### Audit events

| Action | When |
|--------|------|
| `session.login` | Successful sign-in |
| `session.login_failed` | Failed credential check |
| `session.account_locked` | Account locked after 5 failures |
| `session.logout` | User signed out |
| `session.timeout` | Inactivity expiry |
| `session.password_reset_code_issued` | Admin issued reset code |
| `session.password_reset_complete` | User completed reset |
| `session.change_password` | User changed password |

### Admin APIs

- `GET /api/admin/security/login-summary?hours=24` — failed logins, locks, timeouts (requires `settings.view`)
- `GET /api/admin/security/active-sessions` — active sessions list (requires `settings.view`)

### Post-deploy smoke

```bash
ZAREWA_VERIFY_API_ORIGIN=https://api.example.com npm run verify:login-security
```

Optional successful-login check with a dedicated smoke account:

```bash
ZAREWA_VERIFY_API_ORIGIN=https://api.example.com \
ZAREWA_VERIFY_LOGIN_USER=smoke.user \
ZAREWA_VERIFY_LOGIN_PASSWORD='YourSmoke@Pass1!' \
npm run verify:login-security
```

Settings → **Team** tab includes the **Login & session security** panel.

### Removed

- `POST /api/session/firebase` (Google SSO)

## Phase 13 (planned)

- TOTP 2FA for Admin / MD / Finance
- SIEM integration
- Multi-device session management UI
- Persistent rate limiting (Redis/DB) for clustered APIs
