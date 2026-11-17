# apps/api: Express API + pg-boss worker

One codebase, two processes, both wired by `createServices(infra)` in `src/services.ts`:

- `src/server.ts`: HTTP (`createApp(deps)` in `src/app.ts`).
- `src/worker.ts`: pg-boss. Creates queues, registers handlers and cron, and fans out an initial EHR sync.

## Scripts

`pnpm --filter @slotfill/api <script>`:

- `dev`, `dev:server`, `dev:worker`, `start:server`, `start:worker`
- `test`, `typecheck`
- `db:generate`, `db:migrate`, `db:deploy`, `db:seed`
- `db:bootstrap` / `db:release`: managed Postgres. Creates the app role and pg-boss schema, then runs migrations.

The env comes from the repo-root `.env` (`src/lib/env.ts` validates it). The Prisma client is generated into `src/generated/prisma` (gitignored; regenerated on postinstall; no database needed).

## Where things go

- **Data access:** `src/db/client.ts`: `createDatabase(url)` → `{ withTenant(tenantId, fn, { timeoutMs? }), unscoped, disconnect }`. **Read `docs/tenancy.md` first.**
- **Jobs:**
  - `src/jobs/queues.ts`: queue names, payload schemas (IDs only), policies, heartbeat; `JobQueue.send(name, data, opts, tx?)`.
  - `src/jobs/handlers.ts`: handlers, batch/concurrency settings, cron.
  - **Pass `tx` when a job is caused by a data change.**
- **Domain** (`src/modules/<name>/`). Each module's routes are thin and zod-validated; its service holds the logic and takes `tx`.

  | Module         | Contents                                                                            |
  | -------------- | ----------------------------------------------------------------------------------- |
  | `auth`         | sessions, MFA, password reset, RBAC middleware                                      |
  | `audit`        | `recordAudit`                                                                       |
  | `ehr`          | `sync.ts`, `connect-routes.ts` (DrChrono OAuth), `webhook-routes.ts`                |
  | `messaging`    | queue/deliver/inbound pipeline, `templates.ts` (**every** SMS text), webhook routes |
  | `reminders`    | reminders and their replies                                                         |
  | `offers`       | offer engine and race-safe booking                                                  |
  | `waitlist`     | waitlist CRUD, invites, `EARLY`                                                     |
  | `dashboard`    | metrics SQL                                                                         |
  | `settings`     | settings, visit types, dashboard routes                                             |
  | `alerts`       | staff emails                                                                        |
  | `appointments` | appointment and provider lists                                                      |
  | `dev`          | dev-only routes (development/staging)                                               |

- **Providers** (`src/providers/`), the only abstractions:
  - `sms/{dev,aws,twilio}.ts`: a registry of configured providers; a clinic can pick one.
  - `ehr/{mock,drchrono}.ts`: chosen by `ehr_connections.ehr_type`.
- **Lib** (`src/lib/`): `env`, `logger` (PHI redaction), `errors`, `crypto` (AES-GCM; key in hex or base64), `email` (SMTP/SES), `clock`, `quiet-hours`.

## New PHI route checklist

1. `requireAuth` (plus `requireRole('owner')` for settings-like changes). Put guards on each route: routers are mounted at the `/api/v1` root.
2. All data goes through `db.withTenant(authOf(req).tenantId, tx => …)`.
3. Call `recordAudit` for PHI list/detail views and for changes.
4. Add a cross-tenant test (see `test/tenancy.test.ts` and the module tests).

## Tests

- `test/*.test.ts` run against the real `slotfill_test` DB, serially. `resetDb()` truncates every table and pg-boss jobs.
- `createTestContext()` gives `services`, an app-role `db`, `jobs`, and:
  - `clock`: a `FakeClock` that ticks +1 ms per read;
  - `mailer`: dev SMS emails;
  - `email`: staff emails;
  - `runJobs()`: a deterministic worker that honors deferred `startAfter` against the fake clock.
- `buildTestApp(ctx, { devRoutes? })`.
- Fixtures: `createTenant(name, { smsNumber, contactPhone, timezone })`, `createUser({ role, mfaSecret })`, `signIn`, `queuedJobs(queue)`, `auditActions`. `test/ehr-fixtures.ts` has the mock EHR; `test/fake-drchrono.ts` is a fake DrChrono API server.
- Unit tests live in `src/**/*.test.ts`.

## Rules specific to this app

- Log IDs, never PHI. Request logs record the path only. Errors from external APIs carry the status code, never response bodies.
- To audit a failure, **return** a failure result from the `withTenant` callback and throw outside it.
- EHR calls never run inside the inbound-SMS transaction; enqueue a job. The one exception is `offer.accept`, which holds the offer lock while calling the EHR (plan §7.6).
- Never set a local appointment to `cancelled` yourself: cancel in the EHR, then sync, so `appointment.changed` fires and the offer engine runs.
- Outbound SMS: always `messaging.queueSms(tx, …)` with the right context (`reminder`, `offer`, `waitlist_invite` or `system`). Never call a provider directly.
