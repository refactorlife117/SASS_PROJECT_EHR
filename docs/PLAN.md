# SlotFill — Implementation Plan (MVP)

> Working name "SlotFill"; rename freely. This plan is written for Claude Code.
> Work **one phase at a time**. At the end of each phase, stop, summarize what was built, list how to verify it, and wait for review. Never commit unless explicitly asked.
>
> This is the canonical, unabridged plan. The topic docs in this folder split it up for on-demand reading.

---

## 1. Product summary

A multi-tenant SaaS for small US medical clinics that:

1. Sends appointment reminders by SMS and captures confirm/cancel replies.
2. Detects cancelled slots and **automatically offers them to waitlisted patients** by SMS in small batches, first YES wins.
3. Books the accepting patient into the slot in the clinic's EHR and moves their old appointment.
4. Shows the clinic a dashboard of slots filled and revenue recovered.

The clinic's EHR is the source of truth for schedules and patients. SlotFill owns the waitlist, offers, messaging, consent, and metrics.

### In scope (MVP)
- Multi-tenant backend with strict tenant isolation
- Staff auth with MFA, roles, audit logging
- EHR integration through an adapter; **Mock EHR first**, one real EHR later
- SMS through a provider adapter; **dev provider (email via Nodemailer + in-app phone simulator)** first
- Reminders, waitlist, offer engine, booking write-back, dashboard

### Out of scope (for now)
WhatsApp, voice, AI chat, patient mobile app, multiple real EHRs, billing/payments, intake forms, eligibility checks.

---

## 2. Tech stack

| Concern | Choice |
|---|---|
| Language | TypeScript (strict) everywhere |
| API | Node.js + Express |
| Database | PostgreSQL 16 with row-level security (RLS) |
| DB access & migrations | Prisma ORM + Prisma Migrate (`$queryRaw` for row locks and metrics SQL) |
| Background jobs | pg-boss (Postgres-backed queue; no Redis needed) |
| Validation | zod (shared schemas between API and web) |
| Web app | Next.js (App Router) + React + TanStack React Query |
| Auth | Session cookies (httpOnly), argon2 password hashing, TOTP MFA |
| Logging | pino with PHI redaction |
| Dev email | Nodemailer → Mailpit (local SMTP catcher in Docker) |
| SMS (dev) | `dev` provider: email via Nodemailer + in-app phone simulator |
| SMS (prod) | AWS End User Messaging SMS (covered by AWS BAA), Twilio adapter later |
| Email (prod) | Amazon SES (covered by AWS BAA) |
| Hosting | AWS: ECS Fargate (api, worker, web), RDS Postgres, Secrets Manager, KMS, CloudWatch |
| Tests | Vitest + Supertest, real Postgres in Docker |
| Package manager | pnpm workspaces |

---

## 3. Repository structure

```
slotfill/
├── apps/
│   ├── api/                 # Express HTTP server
│   │   ├── prisma/          # schema.prisma, migrations (incl. custom RLS SQL), seed
│   │   └── src/
│   │       ├── modules/     # auth, tenants, appointments, waitlist, offers, messaging, ehr, dashboard, dev
│   │       ├── db/          # Prisma client, tenant-scoped tx helper
│   │       ├── providers/
│   │       │   ├── sms/     # dev, aws, twilio adapters
│   │       │   └── ehr/     # mock, (later) athena/elation/drchrono
│   │       ├── jobs/        # pg-boss job definitions
│   │       ├── lib/         # crypto, logger, time, errors
│   │       ├── server.ts    # HTTP entry
│   │       └── worker.ts    # job worker entry (separate process)
│   └── web/                 # Next.js app
├── packages/
│   └── shared/              # zod schemas, shared types, enums
├── docker-compose.yml       # postgres, mailpit
├── .env.example
└── PLAN.md
```

The API and the worker are the same codebase, run as two processes.

---

## 4. Conventions

- TypeScript strict mode; no `any`.
- Self-documenting names; comments only where the "why" is non-obvious.
- No premature abstractions. The SMS and EHR adapters are the only planned abstractions, because swapping providers is a hard requirement.
- Validate every request body, query, and webhook payload with zod at the boundary.
- **Never log PHI** (names, phone numbers, message bodies). Log IDs only. Configure pino redaction as a safety net.
- All timestamps stored as `timestamptz` in UTC. Each tenant has an IANA timezone; convert at the edges.
- Phone numbers stored in E.164 format.
- All tenant data access goes through a helper that opens a transaction and sets `app.tenant_id` (see §7).
- Dev and staging use **synthetic data only**. Never real patient data outside production.
- Never commit unless explicitly asked.

---

## 5. Architecture

```
Clinic EHR  ⇄  EHR adapter  ⇄  API + Worker  ⇄  SMS adapter  ⇄  Patients' phones
                                    │
                                Postgres
                                    │
                         Next.js staff dashboard
```

### 5.1 SMS provider adapter

```ts
interface SmsProvider {
  send(input: { from: string; to: string; body: string }): Promise<{ providerMessageId: string }>;
  verifyInbound(req: Request): boolean;
  parseInbound(req: Request): { providerMessageId: string; from: string; to: string; body: string };
}
```

Selected by `SMS_PROVIDER=dev|aws|twilio`.

- **`dev`** (build now):
  - `send` stores the message, and emails it via Nodemailer to Mailpit (subject: `SMS to +1555…`), so outbound texts can be seen at http://localhost:8025.
  - The **phone simulator** page in the web app (`/dev/phone`, dev only) lists conversations per number and lets you type a reply. A reply calls `POST /api/dev/sms/inbound`, which runs the **same inbound handler** as the real webhook.
- **`aws`** (Phase 7): AWS End User Messaging SMS for sending; inbound via two-way SMS → SNS topic → HTTPS endpoint.
- **`twilio`** (Phase 9, only once a Twilio BAA is in place): `send` via Twilio API, inbound via Twilio webhook with signature verification.

Each tenant has its own sending number (`tenants.sms_number`). Inbound messages route to a tenant by the `to` number.

### 5.2 EHR adapter

```ts
interface EhrAdapter {
  listAppointments(range: { from: Date; to: Date }): Promise<EhrAppointment[]>;
  listChangedAppointments(since: Date): Promise<EhrAppointment[]>;
  getPatient(ehrPatientId: string): Promise<EhrPatient>;
  listProviders(): Promise<EhrProvider[]>;
  isSlotOpen(input: { ehrProviderId: string; startsAt: Date; durationMin: number }): Promise<boolean>;
  bookAppointment(input: { ehrPatientId: string; ehrProviderId: string; startsAt: Date; durationMin: number; visitType: string }): Promise<{ ehrAppointmentId: string }>;
  cancelAppointment(ehrAppointmentId: string, reason: string): Promise<void>;
}
```

- **`mock`** (build now): a fake EHR stored in its own tables prefixed `mock_` (Prisma models `MockAppointment`, etc.), with a seed script that generates realistic synthetic clinics, providers, patients, and 30 days of appointments. Dev-only page `/dev/ehr` lets you cancel, create, and move appointments to trigger flows.
- **Real adapter** (Phase 8): first EHR to be chosen later (candidates: athenahealth, Elation, DrChrono). Uses webhooks/change subscriptions where available, polling otherwise.

---

## 6. Data model

All tenant-owned tables have `tenant_id uuid not null` and RLS enabled. Abbreviated:

```sql
tenants (id uuid pk, name text, timezone text, sms_number text unique, created_at timestamptz)

tenant_settings (
  tenant_id uuid pk,
  reminder_hours_before int[] default '{48,24}',
  offer_batch_size int default 3,
  offer_batch_timeout_min int default 15,
  min_notice_min int default 120,          -- don't offer slots starting sooner than this
  backfill_horizon_days int default 14,    -- don't offer slots further out than this
  quiet_hours_start time default '21:00',  -- no texts during quiet hours (tenant local time)
  quiet_hours_end time default '08:00',
  auto_waitlist_invite boolean default true,
  auto_waitlist_min_days_out int default 10
)

users (id, tenant_id, email unique, password_hash, role enum('owner','staff'), mfa_secret_enc bytea, mfa_enabled bool, created_at)
sessions (id, user_id, expires_at, last_seen_at)

ehr_connections (id, tenant_id, ehr_type enum('mock', ...), credentials_enc bytea, status, last_synced_at)

providers (id, tenant_id, ehr_provider_id, display_name, unique(tenant_id, ehr_provider_id))
visit_types (id, tenant_id, code, name, duration_min, estimated_value_cents)
patients (id, tenant_id, ehr_patient_id, first_name, last_name, mobile_e164, unique(tenant_id, ehr_patient_id))

appointments (
  id, tenant_id, ehr_appointment_id, patient_id, provider_id, visit_type_id,
  starts_at timestamptz, duration_min int,
  status enum('booked','confirmed','cancelled','no_show','completed'),
  source enum('ehr','slotfill'),
  ehr_updated_at timestamptz,
  unique(tenant_id, ehr_appointment_id)
)

waitlist_entries (
  id, tenant_id, patient_id,
  provider_id nullable,               -- null = any provider
  visit_type_id,
  current_appointment_id nullable,    -- their existing later appointment, if any
  earliest_date date,
  preferred_windows jsonb,            -- e.g. [{"dow":[1,2,3],"from":"09:00","to":"13:00"}]
  status enum('active','fulfilled','removed'),
  source enum('staff','sms_opt_in'),
  created_at
)

sms_consents (tenant_id, mobile_e164, status enum('opted_in','opted_out'), source text, updated_at, pk(tenant_id, mobile_e164))

slot_offers (
  id, tenant_id, provider_id, visit_type_id, starts_at, duration_min,
  source_appointment_id,
  status enum('open','filled','expired','cancelled'),
  filled_by_patient_id nullable, filled_appointment_id nullable,
  expires_at, created_at
)

offer_recipients (
  id, offer_id, waitlist_entry_id, patient_id, mobile_e164, batch_no int,
  sent_at, reply enum('accepted','declined') nullable, replied_at,
  outcome enum('won','too_late') nullable
)

messages (
  id, tenant_id, direction enum('out','in'), mobile_e164, body text,
  provider text, provider_message_id text unique,
  context_type enum('reminder','offer','waitlist_invite','system') nullable, context_id uuid nullable,
  status enum('queued','sent','delivered','failed','received'), created_at
)

audit_log (id bigserial, tenant_id, actor_type enum('user','system','patient'), actor_id, action, entity, entity_id, ip inet, at timestamptz)
```

Notes:
- **One mobile number can belong to several patients** (a parent booking for children). Never resolve a reply by phone number → patient alone; resolve by the most recent outbound message's context (§7.4).
- `messages.provider_message_id` unique gives idempotent webhook handling.
- Encrypt `credentials_enc` and `mfa_secret_enc` with AES-256-GCM. Key from env in dev; KMS data key in prod.

---

## 7. Core flows

### 7.1 Tenant isolation
- Enable RLS on every tenant table: `USING (tenant_id = current_setting('app.tenant_id')::uuid)`.
- The API connects as a non-owner role (RLS cannot be bypassed).
- Helper `withTenant(tenantId, fn)` opens a Prisma interactive transaction and sets the tenant for that transaction only:
  ```ts
  export function withTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }
  ```
  `set_config(..., true)` is transaction-local (equivalent to `SET LOCAL`, but parameterizable). All tenant queries must use the `tx` client, never the global `prisma` client.
- Prisma can't express RLS in `schema.prisma`. Create migrations with `prisma migrate dev --create-only`, then append the `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` statements to the generated `migration.sql`.
- Two connection strings: `MIGRATE_DATABASE_URL` (owner role, used only by Prisma Migrate) and `DATABASE_URL` (non-owner app role, used by the API and worker).
- The worker and webhook handlers resolve the tenant first (from job payload or `to` number), then use the same helper.
- Required test: a user of tenant A can never read or write tenant B data, through any endpoint.

### 7.2 EHR sync
1. **Initial backfill** on connection: providers, visit types, then appointments from today to +60 days, with their patients.
2. **Incremental sync** job every 2 minutes per tenant: `listChangedAppointments(since=last_synced_at)`; upsert. Real adapters with webhooks enqueue the same processing job.
3. **Nightly full resync** of the next 60 days to repair missed events.
4. Every appointment status change emits an internal event `appointment.changed` (enqueued pg-boss job). Processing that event triggers reminders, cancellation handling, and waitlist invites.

### 7.3 Reminders
- When an appointment is created or rescheduled, schedule reminder jobs at each `reminder_hours_before`.
- Before sending, re-check the appointment is still `booked`, consent isn't `opted_out`, and it's not quiet hours (if it is, defer to quiet-hours end if still before the appointment).
- Message: `Hi {firstName}, reminder: {clinic} with {provider} on {date} at {time}. Reply 1 to confirm, 2 to cancel. Reply STOP to opt out.`
- Reply `1` → status `confirmed` (local; write to EHR if the adapter supports it). Reply `2` → cancel in EHR, then the cancellation flow runs.
- No diagnoses or visit reasons in any text (minimum necessary PHI).

### 7.4 Inbound message handling
1. Verify provider signature (dev provider: skip). Dedupe by `provider_message_id`.
2. Resolve tenant by `to` number. Store message.
3. Normalize body (trim, uppercase).
4. **Compliance keywords first, always:** `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` → mark opted_out, send one confirmation, stop. `START`, `UNSTOP` → opted_in. `HELP` → clinic name and phone number.
   - Note: `CANCEL` is a carrier opt-out keyword, so appointment cancellation uses `2`, never "CANCEL".
5. Find the context: the most recent outbound message to this number (same tenant) in the last 72 hours with a context. Route:
   - `reminder` context: `1` / `2`
   - `offer` context: `YES` (also accept `Y`)
   - `waitlist_invite` context: `EARLY`
6. Anything else: reply once with a short help text and flag it in the dashboard for staff.

### 7.5 Cancellation → offer engine
**Trigger:** an appointment becomes `cancelled` with `starts_at` between `now + min_notice_min` and `now + backfill_horizon_days`.

1. Create `slot_offers` row (`open`, `expires_at = starts_at - min_notice_min`).
2. **Select candidates** from active waitlist entries where:
   - provider matches (or entry accepts any provider)
   - visit type duration ≤ slot duration
   - `earliest_date` ≤ slot date
   - their `current_appointment_id` (if any) is later than the slot
   - slot falls inside `preferred_windows` (if set)
   - consent is not opted_out
   - patient has no other open offer pending reply
   - not already sent this offer
   - order by `created_at` ascending (longest waiting first)
3. If quiet hours: schedule the first batch for quiet-hours end, if still before `expires_at`.
4. Send batch of `offer_batch_size`: `Hi {firstName}, an earlier appointment opened with {provider} on {date} at {time}. Reply YES to take it. First to reply gets it.`
5. Schedule `offer.next-batch` job at `offer_batch_timeout_min`. If still `open`, send the next batch. If no candidates remain, leave open until expiry.
6. Schedule `offer.expire` at `expires_at`.

### 7.6 Accepting an offer (race-safe booking)
```
1. Inbound "YES" with offer context → recipient row found.
2. Inside `withTenant`: lock the offer with `tx.$queryRaw` (`SELECT ... FROM slot_offers WHERE id = ${offerId} FOR UPDATE`). Prisma has no row-lock API, so this one query is raw.
3. If status != 'open' → mark recipient outcome 'too_late', text "Sorry, that spot was just taken.", COMMIT, done.
4. adapter.isSlotOpen(...). If false → offer 'cancelled', tell patient it's gone, COMMIT, done.
5. adapter.bookAppointment(...) → new EHR appointment.
6. If the waitlist entry has current_appointment_id → adapter.cancelAppointment(old, 'moved earlier via SlotFill').
7. Update offer 'filled', recipient 'won', waitlist entry 'fulfilled'; upsert new appointment (source 'slotfill').
8. COMMIT. Then send confirmation to winner and "filled" notice to others who were offered this slot and haven't replied.
```
- The patient's old appointment, cancelled in step 6, frees a later slot. That cancellation **does** trigger the offer engine, so the freed slot is offered onward (a chain). Add a test for this chain.
- If step 5 or 6 fails after step 4, roll back, alert staff in dashboard, tell the patient the clinic will call them.

### 7.7 Waitlist invites
- If `auto_waitlist_invite` and an appointment is booked ≥ `auto_waitlist_min_days_out` days ahead, send once per appointment: `Would you like an earlier appointment if one opens up? Reply EARLY and we'll text you.`
- `EARLY` → create a waitlist entry (source `sms_opt_in`, provider = their booked provider, visit type = their visit type, current appointment = this one).

### 7.8 Metrics
- **Slots recovered**: offers `filled`.
- **Revenue recovered**: sum of `visit_types.estimated_value_cents` for filled offers.
- **Fill rate**: filled / (filled + expired).
- **Median time to fill**: `filled_at - created_at`.
- **Confirmation rate** for reminders.

---

## 8. API (Express, `/api/v1`)

Auth: `POST /auth/login`, `POST /auth/mfa/verify`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/mfa/setup`

Dashboard: `GET /dashboard/summary?from&to`

Appointments: `GET /appointments?from&to&providerId&status`

Waitlist: `GET /waitlist`, `POST /waitlist`, `PATCH /waitlist/:id`, `DELETE /waitlist/:id`

Offers: `GET /offers?status`, `GET /offers/:id` (with recipients), `POST /offers/:id/cancel`

Messages: `GET /messages?mobile&context`, `GET /messages/needs-attention`

Settings: `GET /settings`, `PATCH /settings`, `GET /visit-types`, `PATCH /visit-types/:id` (estimated value)

Webhooks (no session auth; signature-verified): `POST /webhooks/sms/:provider`, `POST /webhooks/ehr/:ehrType`

Dev only (registered only when `NODE_ENV=development`): `POST /dev/sms/inbound`, `GET /dev/sms/conversations`, `POST /dev/ehr/appointments/:id/cancel`, `POST /dev/ehr/appointments`, `POST /dev/seed`

---

## 9. Web app (Next.js + React Query)

- Next.js `rewrites` proxy `/api/*` to the Express API in dev, so cookies are same-origin.
- One React Query hook per resource (`useWaitlist`, `useOffers`, …). Mutations invalidate the related queries. Offers and messages poll every 10 s on their pages.

Pages:
- `/login`, `/mfa`
- `/` dashboard: slots recovered, revenue recovered, fill rate, open offers, items needing attention
- `/waitlist`: list, add patient (search synced patients), edit preferences, remove
- `/appointments`: upcoming list by day and provider, status badges
- `/offers`: open/filled/expired with recipient timeline
- `/messages`: conversation log; "needs attention" filter
- `/settings`: reminder timings, batch size/timeout, quiet hours, visit-type values
- `/dev/phone` (dev only): simulated phones, view texts, send replies
- `/dev/ehr` (dev only): mock EHR schedule, cancel/create/move appointments

---

## 10. Security and HIPAA baseline

- AWS BAA signed (via AWS Artifact) before any real PHI; use only HIPAA-eligible AWS services.
- TLS everywhere; RDS encryption at rest; encrypted backups.
- Secrets in AWS Secrets Manager; field-level encryption for credentials and MFA secrets.
- MFA required for all staff accounts; 15-minute idle session timeout; secure, httpOnly, sameSite cookies.
- RBAC: `owner` manages settings and users; `staff` operates waitlist and offers.
- Audit log entries for: login, PHI list/detail views, waitlist changes, offers, bookings, settings changes.
- Rate limiting on auth and webhook endpoints; webhook signature verification.
- No PHI in logs, error trackers, analytics, or email subjects (dev Mailpit uses synthetic data only).
- Minimum necessary PHI in texts: first name, clinic, provider, date/time only.

---

## 11. Phases and acceptance criteria

### Phase 0 — Scaffold
- pnpm monorepo, TypeScript strict, ESLint + Prettier, Vitest.
- `docker-compose.yml` with Postgres and Mailpit.
- Express app with health route; worker entry with pg-boss started; Next.js app with React Query provider.
- `.env.example` documenting all variables.

**Done when:** `docker compose up -d && pnpm dev` runs api, worker, and web; health check returns OK; tests run.

### Phase 1 — Tenancy, auth, audit
- `schema.prisma` models + migrations for tenants, settings, users, sessions, audit_log (with RLS SQL appended to migrations).
- RLS policies and `withTenant` helper; non-owner DB role.
- Login, TOTP MFA, logout, session middleware, RBAC middleware.
- Seed script creating 2 demo tenants with users.

**Done when:** login with MFA works in the web app; isolation test proves tenant A can't see tenant B; audit entries recorded.

### Phase 2 — Mock EHR + sync
- `mock_` tables and seed (providers, visit types, ~200 patients, 30 days of appointments per tenant, synthetic US names and `+1555…` numbers).
- `EhrAdapter` interface and `mock` adapter.
- Backfill, incremental sync job, nightly resync, `appointment.changed` events.
- `/appointments` page; `/dev/ehr` page.

**Done when:** changes made on `/dev/ehr` appear in `/appointments` within one sync cycle.

### Phase 3 — Messaging layer
- `SmsProvider` interface and `dev` provider (Nodemailer → Mailpit).
- `messages`, `sms_consents`; inbound handler with dedupe, keyword handling, context routing.
- `/dev/phone` simulator; `/messages` page.

**Done when:** outbound texts appear in Mailpit and the simulator; STOP/START/HELP work; replying from the simulator hits the inbound handler.

### Phase 4 — Reminders
- Reminder scheduling, quiet hours, confirm (`1`) / cancel (`2`) handling, cancel written to mock EHR.

**Done when:** a seeded appointment gets reminders at the right times (use a time-travel/test clock helper); replying `2` cancels it in the mock EHR.

### Phase 5 — Waitlist + offer engine + booking
- Waitlist CRUD and page; waitlist invites with `EARLY`.
- Offer creation, candidate selection, batches, timeouts, expiry, race-safe acceptance, write-back, chained offers for freed slots.
- `/offers` page.

**Done when:** cancelling a slot on `/dev/ehr` texts waitlisted patients in the simulator; first YES gets booked in the mock EHR, their old appointment is cancelled and itself offered onward; others get "filled".

**Required tests:** two concurrent YES replies → exactly one booking; slot taken in EHR between offer and YES → graceful message; quiet hours defer; opted-out patients never contacted; one mobile shared by two patients routes correctly.

### Phase 6 — Dashboard + settings
- Metrics queries and dashboard page; settings and visit-type values pages; "needs attention" list.

**Done when:** after running the Phase 5 scenario, the dashboard shows correct counts and revenue.

### Phase 7 — Hardening + AWS deployment
- `aws` SMS provider (AWS End User Messaging SMS, inbound via SNS) behind the same interface.
- SES for transactional email (password reset, alerts).
- Infrastructure as code (AWS CDK in TypeScript): VPC, RDS (encrypted, private), ECS Fargate services for api/worker/web, ALB with TLS, Secrets Manager, KMS, CloudWatch logs and alarms.
- Staging environment with synthetic data.

**Done when:** staging is deployed and the full Phase 5 scenario works with real SMS to a test phone.

### Phase 8 — First real EHR adapter
- Chosen EHR's sandbox, OAuth connection flow, adapter implementation, webhook or polling sync.

**Done when:** the Phase 5 scenario passes against the EHR sandbox.

### Phase 9 — Twilio adapter (optional)
- Only after a Twilio BAA is in place. Implement `twilio` provider; per-tenant provider selection.

---

## 12. Local development

```bash
docker compose up -d        # postgres :5432, mailpit SMTP :1025, UI :8025
pnpm install
pnpm db:migrate            # prisma migrate dev
pnpm db:seed                # demo tenants, users, mock EHR data
pnpm dev                    # api :4000, worker, web :3000
```

Key env vars: `DATABASE_URL` (app role), `MIGRATE_DATABASE_URL` (owner role), `SESSION_SECRET`, `ENCRYPTION_KEY`, `SMS_PROVIDER=dev`, `SMTP_HOST=localhost`, `SMTP_PORT=1025`, `DEV_SMS_EMAIL_TO=dev-sms@slotfill.local`, `APP_BASE_URL`.

---

## 13. Open decisions (do not block on these)

- First real EHR to integrate (Phase 8).
- Product name and domain.
- Per-clinic SMS sender registration model for A2P 10DLC (see note in chat), or toll-free numbers with verification.
- Pricing (flat per location vs per filled slot).
