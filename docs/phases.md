# Phases and acceptance criteria

Work one phase at a time. At the end of a phase: stop, summarize what was built, list the verification steps, and wait for review. When a phase is accepted, set its status here **and** update the "Current phase" line in `CLAUDE.md`.

| Phase                                 | Status    |
| ------------------------------------- | --------- |
| 0 — Scaffold                          | ✅ done   |
| 1 — Tenancy, auth, audit              | ✅ done   |
| 2 — Mock EHR + sync                   | 🔍 review |
| 3 — Messaging layer                   | ☐         |
| 4 — Reminders                         | ☐         |
| 5 — Waitlist + offer engine + booking | ☐         |
| 6 — Dashboard + settings              | ☐         |
| 7 — Hardening + AWS deployment        | ☐         |
| 8 — First real EHR adapter            | ☐         |
| 9 — Twilio adapter (optional)         | ☐         |

---

## Phase 0 — Scaffold

- pnpm monorepo, TypeScript strict, ESLint + Prettier, Vitest.
- `docker-compose.yml` with Postgres and Mailpit.
- Express app with a health route; worker entry with pg-boss started; Next.js app with a React Query provider.
- `.env.example` documenting all variables.
- Add nested `apps/api/CLAUDE.md` and `apps/web/CLAUDE.md` with app-specific commands and notes.

**Done when:** `docker compose up -d && pnpm dev` runs the api, worker and web; the health check returns OK; tests run.

## Phase 1 — Tenancy, auth, audit

- `schema.prisma` models + migrations for tenants, settings, users, sessions and audit_log, with RLS SQL appended to the migrations.
- RLS policies and the `withTenant` helper; non-owner DB role.
- Login, TOTP MFA, logout, session middleware, RBAC middleware.
- Seed script that creates 2 demo tenants with users.

**Done when:** login with MFA works in the web app; the isolation test proves tenant A can't see tenant B; audit entries are recorded.

## Phase 2 — Mock EHR + sync

- `mock_` tables and seed: providers, visit types, ~200 patients and 30 days of appointments per tenant, with synthetic US names and `+1555…` numbers.
- `EhrAdapter` interface and `mock` adapter.
- Backfill, incremental sync job, nightly resync, `appointment.changed` events.
- `/appointments` page; `/dev/ehr` page.

**Done when:** changes made on `/dev/ehr` appear in `/appointments` within one sync cycle.

## Phase 3 — Messaging layer

- `SmsProvider` interface and `dev` provider (Nodemailer → Mailpit).
- `messages`, `sms_consents`; inbound handler with dedupe, keyword handling and context routing.
- `/dev/phone` simulator; `/messages` page.

**Done when:** outbound texts appear in Mailpit and in the simulator; STOP/START/HELP work; replying from the simulator hits the inbound handler.

## Phase 4 — Reminders

- Reminder scheduling, quiet hours, confirm (`1`) / cancel (`2`) handling, and cancel written to the mock EHR.

**Done when:** a seeded appointment gets reminders at the right times (use a time-travel/test clock helper); replying `2` cancels it in the mock EHR.

## Phase 5 — Waitlist + offer engine + booking

- Waitlist CRUD and page; waitlist invites with `EARLY`.
- Offer creation, candidate selection, batches, timeouts, expiry, race-safe acceptance, write-back, and chained offers for freed slots.
- `/offers` page.

**Done when:** cancelling a slot on `/dev/ehr` texts the waitlisted patients in the simulator; the first YES gets booked in the mock EHR, that patient's old appointment is cancelled and itself offered onward, and the others get "filled".

**Required tests:**

- [ ] two concurrent YES replies → exactly one booking
- [ ] slot taken in the EHR between the offer and the YES → graceful message
- [ ] quiet hours defer sending
- [ ] opted-out patients are never contacted
- [ ] one mobile shared by two patients routes correctly
- [ ] chain: the freed old appointment is offered onward

## Phase 6 — Dashboard + settings

- Metrics queries and dashboard page; settings and visit-type values pages; "needs attention" list.

**Done when:** after running the Phase 5 scenario, the dashboard shows the correct counts and revenue.

## Phase 7 — Hardening + AWS deployment

- `aws` SMS provider (AWS End User Messaging SMS, inbound via SNS) behind the same interface.
- SES for transactional email (password reset, alerts).
- Infrastructure as code (AWS CDK in TypeScript): VPC, RDS (encrypted, private), ECS Fargate services for api/worker/web, ALB with TLS, Secrets Manager, KMS, CloudWatch logs and alarms.
- Staging environment with synthetic data.

**Done when:** staging is deployed and the full Phase 5 scenario works with real SMS to a test phone.

## Phase 8 — First real EHR adapter

- The chosen EHR's sandbox, OAuth connection flow, adapter implementation, and webhook or polling sync.

**Done when:** the Phase 5 scenario passes against the EHR sandbox.

## Phase 9 — Twilio adapter (optional)

- Only after a Twilio BAA is in place. Implement the `twilio` provider and per-tenant provider selection.

## Always-required tests (every phase from 1 on)

- [ ] Tenant A can never read or write tenant B's data, through any endpoint.
