# SlotFill

Multi-tenant SaaS for small US medical clinics. It sends SMS appointment reminders, detects cancelled slots and offers them by SMS to waitlisted patients (first YES wins), books the patient who accepts into the clinic's EHR, and shows the clinic how many slots were filled and how much revenue was recovered. The EHR is the source of truth for schedules and patients. SlotFill owns the waitlist, offers, messaging, consent and metrics.

**Current phase: all phases built. Remaining steps need your accounts: AWS deploy (Phase 7) and DrChrono sandbox check (Phase 8). See docs/USAGE.md and docs/deploy.md**

## Stack

pnpm monorepo · TypeScript strict · Express API + pg-boss worker (same codebase, two processes) · PostgreSQL 16 with RLS · Prisma · zod (shared in `packages/shared`) · Next.js App Router + React Query · pino · Vitest + Supertest on real Postgres · Mailpit for dev email.

## Working rules

- **One phase at a time.** At the end of a phase, stop, summarize what was built, list how to verify it, and wait for review.
- **Never commit** unless explicitly asked.
- TypeScript strict, **no `any`**. Self-documenting names; comment only a non-obvious "why".
- Validate every request body, query and webhook payload with **zod at the boundary**.
- **No premature abstractions.** The SMS and EHR adapters are the only planned ones.
- Read the relevant doc below before starting work in an area.

## Non-negotiable invariants

- All tenant data access goes through `db.withTenant(tenantId, tx => ...)` and the `tx` client. `db.unscoped` is only for the SECURITY DEFINER pre-tenant lookups. There is no global Prisma client.
- Every tenant table has `tenant_id` + RLS enabled. The RLS SQL is appended to the Prisma migration (`--create-only`).
- **Never log PHI** (names, phones, message bodies). Log IDs only. No PHI in email subjects or error trackers either.
- Store timestamps as `timestamptz` in UTC and convert to the tenant timezone at the edges. Phones are in E.164.
- Dev and staging use **synthetic data only**.
- Inbound SMS: check compliance keywords (STOP/START/HELP…) **first, always**. Appointment cancel is `2`, never `CANCEL`.
- Never resolve a reply by phone number → patient. Use the context of the most recent outbound message.
- Texts contain only first name, clinic, provider and date/time. No diagnoses or visit reasons.
- Accepting an offer uses `SELECT ... FOR UPDATE` on `slot_offers` (race-safe).

## Docs index (read on demand)

| Working on…                                                 | Read                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Folder layout, adapters (SMS/EHR)                           | [docs/architecture.md](docs/architecture.md)                                  |
| Schema, migrations, Prisma models                           | [docs/data-model.md](docs/data-model.md) + [docs/tenancy.md](docs/tenancy.md) |
| RLS, `withTenant`, DB roles                                 | [docs/tenancy.md](docs/tenancy.md)                                            |
| Sync, reminders, inbound, offers, booking, invites, metrics | [docs/flows.md](docs/flows.md)                                                |
| Endpoints, web pages, React Query                           | [docs/api.md](docs/api.md)                                                    |
| Auth, MFA, audit, PHI, HIPAA                                | [docs/security-hipaa.md](docs/security-hipaa.md)                              |
| Code style, tests                                           | [docs/conventions.md](docs/conventions.md)                                    |
| What to build now / acceptance criteria                     | [docs/phases.md](docs/phases.md)                                              |
| Local setup, env vars                                       | [docs/dev-setup.md](docs/dev-setup.md)                                        |
| Open questions / decisions made                             | [docs/decisions.md](docs/decisions.md)                                        |
| Deploying to AWS (runbook)                                  | [docs/deploy.md](docs/deploy.md)                                              |
| How to use / try each phase                                 | [docs/USAGE.md](docs/USAGE.md)                                                |
| Full original plan (canonical)                              | [docs/PLAN.md](docs/PLAN.md)                                                  |

## Agents (run only when the user asks)

- `/review [path]` → **code-reviewer**: correctness, tenancy, PHI and security review. Read-only.
- `/test [area]` → **tester**: writes and runs tests. Edits test files only.
- `/dupes [path]` → **duplicate-code-reviewer**: finds duplicated logic. Read-only.

Do not launch these agents on your own initiative.

## Commands

`docker compose up -d` (Postgres on **host port 5433**, Mailpit on 1025/8025) · `pnpm dev` (api :4000, worker, web :3000) · `pnpm test` · `pnpm lint` · `pnpm typecheck` · `pnpm format`. Phase 1 adds `pnpm db:migrate` and `pnpm db:seed`. Details are in [docs/dev-setup.md](docs/dev-setup.md); app-specific notes are in `apps/api/CLAUDE.md` and `apps/web/CLAUDE.md`.

Before finishing any change, run `pnpm typecheck && pnpm lint && pnpm test`.
