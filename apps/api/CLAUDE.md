# apps/api: Express API + pg-boss worker

One codebase, two processes:

- `src/server.ts` is the HTTP entry. It wires real dependencies into `createApp(deps)` from `src/app.ts`; tests pass a test DB instead.
- `src/worker.ts` is the pg-boss entry: it creates queues, registers handlers and cron, and fans out an initial EHR sync.

## Scripts

`pnpm --filter @slotfill/api <script>`:

- `dev` (server + worker), `dev:server`, `dev:worker`
- `test`, `typecheck`
- `db:generate`, `db:migrate`, `db:deploy`, `db:seed`

The env comes from the repo-root `.env`. The Prisma client is generated into `src/generated/prisma` (gitignored; regenerated on `postinstall`).

## Where things go

- `src/db/client.ts`: `createDatabase(url)` → `{ withTenant(tenantId, fn, { timeoutMs? }), unscoped, disconnect }`. **Read `docs/tenancy.md` before touching data access.**
- `src/jobs/`:
  - `queues.ts`: queue names, payload schemas and policies; `JobQueue.send(name, data, opts, tx?)`.
  - `handlers.ts`: handlers, batching, cron.
  - Pass `tx` when a job is caused by a data change. See the background jobs section in `docs/architecture.md`.
- `src/modules/ehr/sync.ts`: `EhrSyncService` (backfill, incremental sync, `appointment.changed` events). See the EHR sync section in `docs/flows.md`.
- `src/modules/appointments/`: `GET /appointments`, `GET /providers`.
- `src/modules/dev/`: dev-only routes, mounted only when `devRoutes` is set (`NODE_ENV=development`).
- `src/modules/<name>/`: `routes.ts` (thin; zod-parse input with `@slotfill/shared` schemas) → `service.ts` (logic; uses `db.withTenant`). Mount under the `/api/v1` router in `app.ts`.
- `src/modules/auth/`:
  - `sessions.ts`: `SessionStore` (token, HMAC, idle/absolute expiry).
  - `middleware.ts`: `loadSession`, `requireAuth`, `requirePendingMfa`, `requireSession`, `requireRole`, `authOf(req)`.
  - `service.ts`: login, MFA setup/verify, logout, me.
  - `passwords.ts`: argon2id.
- `src/modules/audit/audit.ts`: `recordAudit(tx, tenantId, entry)`. Call it inside the same `withTenant` transaction as the change it records.
- `src/lib/`:
  - `env.ts`: zod env, one loader per entrypoint.
  - `logger.ts`: pino, with PHI redaction as a safety net.
  - `errors.ts`: `AppError`. ZodErrors become a 400 that doesn't echo the input.
  - `crypto.ts`: AES-256-GCM `FieldCipher`, HMAC, random tokens.
- `src/providers/{sms,ehr}/`: the only planned abstractions. See `docs/architecture.md`. `providers/ehr/mock.ts` (`MockEhr`) is the fake EHR. Domain code reaches EHRs only through `EhrAdapter`, never the `mock_*` tables.

## New PHI routes checklist

1. `requireAuth` (and `requireRole('owner')` where `docs/security-hipaa.md` says owner-only).
2. All data access goes through `db.withTenant(authOf(req).tenantId, tx => …)`.
3. Call `recordAudit` for PHI list/detail views and for changes.
4. Add a cross-tenant case to `test/tenancy.test.ts` → "isolation through the API".

## Tests

- `test/*.test.ts` are integration tests against the real `slotfill_test` DB. `test/global-setup.ts` runs `migrate deploy`. Files run serially, and `resetDb()` truncates every table.
- `test/helpers.ts`:
  - `admin`: owner-role client, used **only** for fixtures and assertions.
  - Setup: `createTestContext()` gives an app-role `db` plus a real pg-boss `jobs`; call `close()` in `afterAll`. Then `buildTestApp(ctx, { devRoutes? })`.
  - Fixtures: `createTenant`, `createUser({ mfaSecret })`, `signIn(agent, …)`, `totpCode`.
  - Assertions: `auditActions`, `queuedJobs(queue)` (job payloads).
- `test/ehr-fixtures.ts`: `createMockEhr(tenantId)`, `createMockAppointment`, `inDays(n)`. These are small mock-EHR fixtures written "in the external EHR".
- `src/**/*.test.ts` are unit tests.

## Rules specific to this app

- Log IDs, never PHI. Request logs record the path only. Don't add query strings, bodies or headers to logs.
- Error messages returned to clients or logged must not contain PHI.
- A router mounted at the `/api/v1` root must put guards on each route, not `router.use(requireAuth)`. A router-level guard also catches unrelated paths and turns 404s into 401s.
- To audit a failure, **return** a failure result from the `withTenant` callback and throw outside it. A throw inside rolls the audit entry back.
