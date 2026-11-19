# Security and HIPAA baseline

- Sign the AWS BAA (via AWS Artifact) before any real PHI is handled, and use only HIPAA-eligible AWS services.
- TLS everywhere; RDS encryption at rest; encrypted backups.
- Secrets live in AWS Secrets Manager. Credentials and MFA secrets get field-level encryption (AES-256-GCM; env key in dev, KMS data key in prod).
- **Auth:** argon2 password hashing, TOTP MFA **required** for all staff, httpOnly session cookies that are `secure` and `sameSite`, and a 15-minute idle session timeout.
- **RBAC:** `owner` manages settings and users; `staff` operates the waitlist and offers.
- **Audit log** entries for: login, PHI list/detail views, waitlist changes, offers, bookings and settings changes.
- Rate limiting on auth and webhook endpoints; webhook signature verification.
- **No PHI** in logs, error trackers, analytics or email subjects. pino redaction is configured as a safety net, but the primary rule is to log IDs only.
- Minimum necessary PHI in texts: first name, clinic, provider and date/time only. No diagnoses or visit reasons.
- Dev and staging use synthetic data only (`+1555…` numbers, fake names). Dev Mailpit never sees real data.
- **Team management:** owners invite users by email (a single-use link, valid 7 days, sets their password; MFA is enrolled at first sign-in), change roles, deactivate/reactivate, and reset someone's MFA. Nobody can change their own role or deactivate themselves. Deactivation deletes the user's sessions and blocks sign-in and reset links; the row stays for the audit trail.
- **Platform admins** (SlotFill operators) sign in with password + MFA like everyone else. The admin console shows clinic metadata and staff accounts only, never patients, appointments or messages. Their actions are audited in the affected clinic's log (`platform.*`). The first one is created with `pnpm --filter @slotfill/api admin:create-platform-admin <email>`; the invite link is emailed, never printed or logged.
