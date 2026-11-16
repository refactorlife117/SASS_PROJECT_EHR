# Local development

Prerequisites: Node ≥ 22.12 (24 recommended), Docker Desktop, pnpm via corepack (`corepack enable pnpm`).

```bash
cp .env.example .env        # first time only
docker compose up -d        # postgres :5433 (host), mailpit SMTP :1025, UI :8025
pnpm install
pnpm db:migrate             # (Phase 1+) prisma migrate dev
pnpm db:seed                # (Phase 1+) demo tenants, users, mock EHR data
pnpm dev                    # api :4000, worker, web :3000
```

- Health: http://localhost:4000/api/v1/health (direct) or http://localhost:3000/api/v1/health (through the Next proxy).
- Outbound dev SMS: Mailpit UI at http://localhost:8025, or the `/dev/phone` simulator (Phase 3+).
- Mock EHR controls: `/dev/ehr` (Phase 2+).

## Demo logins (after `pnpm db:seed`)

| Tenant                                 | Users                                  | Password                |
| -------------------------------------- | -------------------------------------- | ----------------------- |
| Maple Family Clinic (America/New_York) | `owner@maple.test`, `staff@maple.test` | `slotfill-dev-password` |
| Cedar Pediatrics (America/Chicago)     | `owner@cedar.test`, `staff@cedar.test` | `slotfill-dev-password` |

The first login enrolls MFA: scan the QR code with any authenticator app. To reset a user's MFA in dev, run `UPDATE users SET mfa_enabled=false, mfa_secret_enc=NULL WHERE email=...` as the owner role. Override the password with `SEED_USER_PASSWORD`.

**Mock EHR data:** the seed also creates a mock EHR connection per tenant and generates mock EHR data (4 providers, 5 visit types, ~200 patients with `+1555…` numbers, 30 days of weekday appointments 9–5 local time), but only if the tenant has none. The worker backfills it into SlotFill on start, and syncs every 2 minutes after that. Because the appointments are relative to the day you seeded, regenerate them when they get stale: `SEED_RESET_MOCK=1 pnpm db:seed`. That also clears SlotFill's synced copy, so the worker re-backfills it.

## Database

- Docker Postgres is exposed on **host port 5433**, because 5432 is often taken by a locally installed Postgres.
- `docker/postgres/init/01-roles.sql` runs **only on first start with an empty volume**. It creates:
  - `slotfill_owner`: owner/superuser, used only for migrations.
  - `slotfill_app`: runtime role: non-owner, `NOBYPASSRLS`, gets DML on `public` tables through default privileges.
  - The `pgboss` schema, owned by `slotfill_app` (pg-boss runs with `createSchema: false`).
  - The `slotfill_test` database, with the same setup.
- To re-run the init script: `docker compose down -v && docker compose up -d`. **This deletes all local data.**

## Commands

| Command                                | What it does                                                     |
| -------------------------------------- | ---------------------------------------------------------------- |
| `pnpm dev`                             | api server + worker + web, with watch                            |
| `pnpm test`                            | Vitest in every package                                          |
| `pnpm lint`                            | ESLint (type-checked, strict) for the repo                       |
| `pnpm typecheck`                       | `tsc --noEmit` in every package                                  |
| `pnpm format` / `format:check`         | Prettier                                                         |
| `pnpm --filter @slotfill/api <script>` | Run one package's script (`dev:server`, `dev:worker`, `test`, …) |

## Environment variables

| Var                                               | Purpose                                                 |
| ------------------------------------------------- | ------------------------------------------------------- |
| `NODE_ENV`, `LOG_LEVEL`                           | Runtime mode; pino level                                |
| `API_PORT`                                        | Express port (4000)                                     |
| `API_URL`                                         | Where the Next dev proxy sends `/api/*`                 |
| `APP_BASE_URL`                                    | Web app base URL                                        |
| `DATABASE_URL`                                    | Non-owner app role (API + worker); subject to RLS       |
| `MIGRATE_DATABASE_URL`                            | Owner role; used only by Prisma Migrate                 |
| `TEST_DATABASE_URL` / `TEST_MIGRATE_DATABASE_URL` | Same roles, `slotfill_test` database                    |
| `SESSION_SECRET`                                  | Session cookie signing (Phase 1)                        |
| `ENCRYPTION_KEY`                                  | AES-256-GCM key for field encryption (dev; KMS in prod) |
| `SMS_PROVIDER`                                    | `dev` \| `aws` \| `twilio` (Phase 3)                    |
| `SMTP_HOST` / `SMTP_PORT`                         | `localhost` / `1025` (Mailpit)                          |
| `DEV_SMS_EMAIL_TO`                                | e.g. `dev-sms@slotfill.local`                           |

The API validates env with zod at startup (`apps/api/src/lib/env.ts`). Each entrypoint validates only what it uses. Keep `.env.example` in sync whenever a variable is added.

## Gotchas

- pnpm 12 blocks dependency install scripts by default. Allowed ones are listed under `allowBuilds` in `pnpm-workspace.yaml` (currently esbuild and Prisma). Password hashing uses `@node-rs/argon2`, which ships prebuilt binaries, so it needs no build script.
- On Windows, stopping `pnpm dev` from a tool or IDE may leave orphaned `node` processes holding ports 3000/4000. Kill the process tree (`taskkill /PID <pid> /T /F`).
- `next dev` writes `apps/web/AGENTS.md` (Next.js version-specific agent rules). Leave it in place.
