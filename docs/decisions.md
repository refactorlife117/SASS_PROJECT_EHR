# Decisions

## Open (do not block on these)

- First real EHR to integrate (Phase 8): athenahealth, Elation or DrChrono.
- Product name and domain ("SlotFill" is a working name).
- Per-clinic SMS sender registration model for A2P 10DLC, or toll-free numbers with verification.
- Pricing (flat per location vs per filled slot).

## Log

Record decisions here as they are made: date, decision, reason.

| Date       | Decision                                                                                                                        | Why                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-16 | TypeScript 6.0.x, not 7                                                                                                         | typescript-eslint 8.x supports TS < 6.1 only                                                                                    |
| 2026-11-16 | Prisma 7.x stable (not the 8 RC)                                                                                                | Avoid a release-candidate ORM for a HIPAA product                                                                               |
| 2026-11-16 | Docker Postgres on host port 5433                                                                                               | 5432 is commonly occupied by a local Postgres install                                                                           |
| 2026-11-16 | `pgboss` schema pre-created and owned by the app role; pg-boss `createSchema: false`                                            | The app role must not hold database-level CREATE                                                                                |
| 2026-11-16 | Internal packages export TS source (`exports: ./src/index.ts`); api runs via tsx, web uses `transpilePackages`                  | No build step for `packages/shared` in dev. A production bundling step is decided in Phase 7                                    |
| 2026-11-16 | Request logs record the path only, never the query string                                                                       | Queries like `?mobile=` carry PHI                                                                                               |
| 2026-11-16 | RLS ENABLEd, not FORCEd; fail-closed `app_current_tenant_id()`                                                                  | App never connects as owner; owner-owned SECURITY DEFINER lookups must work on RDS (owner not superuser)                        |
| 2026-11-16 | Pre-tenant lookups only via narrow SECURITY DEFINER functions (`auth_find_user_by_email`, `auth_find_session`)                  | Login and session resolution happen before the tenant is known; keeps every table under RLS                                     |
| 2026-11-16 | `Database` object (`db.withTenant`, `db.unscoped`) injected into `createApp`; no global Prisma client                           | Testability (real test DB) and makes "use tx" the only path to tenant data                                                      |
| 2026-11-16 | Sessions: random 256-bit token in an httpOnly SameSite=Strict cookie; DB stores HMAC-SHA256(SESSION_SECRET, token)              | A DB read alone cannot hijack sessions; Strict SameSite is the CSRF defense for this staff-only app                             |
| 2026-11-16 | Two-step login: password creates a 10-min pending session; MFA verify replaces it with a new token (12 h absolute, 15 min idle) | MFA is mandatory; rotation prevents session fixation                                                                            |
| 2026-11-16 | TOTP via otplib 13 with replay protection (`users.mfa_last_time_step`), ±30 s tolerance                                         | RFC 6238; a code can be used once                                                                                               |
| 2026-11-16 | Password hashing with `@node-rs/argon2` (argon2id)                                                                              | Prebuilt binaries, no install script under pnpm 12                                                                              |
| 2026-11-16 | `quiet_hours_*` stored as "HH:MM" text with a CHECK constraint, not `time`                                                      | Prisma maps `time` to 1970-dated `Date` objects; text is clearer for tenant-local wall-clock times                              |
| 2026-11-16 | Auth rate limiting is in-memory (express-rate-limit), 10 attempts / 15 min / IP                                                 | Fine for one instance; move to a shared store in Phase 7 when running several API tasks                                         |
| 2026-11-16 | Mock EHR tables are tenant-scoped (`tenant_id` + RLS) and reached only via `MockEhr` and `/dev/ehr`                             | Same isolation guarantees and coverage test as real data; the mock behaves like a per-clinic external system                    |
| 2026-11-16 | `EhrAdapter` gains `listVisitTypes()`; `getPatient` may return null                                                             | Backfill needs visit types; EHRs can return unknown ids                                                                         |
| 2026-11-16 | Sync events enqueued in the same Prisma transaction as the upserts (pg-boss `db.executeSql` via `tx.$queryRawUnsafe`)           | No lost or phantom `appointment.changed` events, with no outbox table                                                           |
| 2026-11-16 | Incremental cursor = sync start time, re-read with a 60 s overlap; stale/unchanged rows skipped by `ehr_updated_at`             | Safe against clock skew and late commits; syncs are idempotent                                                                  |
| 2026-11-16 | `ehr.sync` queue: `stately` policy keyed by tenant; event queues fetched in batches of 50 with per-job settlement               | One sync per tenant at a time; the initial backfill (~1.8k events) drained in seconds instead of ~1 h at the default 1 job/poll |
| 2026-11-16 | Shared time helpers (`zonedTimeToUtc`, `toDateKey`, …) in `packages/shared` using Intl (no date library)                        | One implementation for API, seed and web; DST cases covered by tests                                                            |
| 2026-11-16 | Prisma P2025 (record not found) maps to HTTP 404                                                                                | Under RLS another tenant's row must look exactly like a missing one                                                             |
