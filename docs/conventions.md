# Conventions

## Code

- TypeScript strict mode; no `any` (use `unknown` + zod narrowing).
- Self-documenting names. Comment only when the "why" is non-obvious.
- No premature abstractions. The SMS and EHR adapters are the only planned abstractions, because swapping providers is a hard requirement.
- Validate every request body, query and webhook payload with zod at the boundary. Shared schemas live in `packages/shared` and are imported, never redefined.
- **Never log PHI** (names, phone numbers, message bodies). Log IDs only.
- Timestamps are `timestamptz` in UTC. Each tenant has an IANA timezone; convert at the edges (`lib/time`).
- Phone numbers are stored in E.164.
- All tenant data access goes through `withTenant` (see [tenancy.md](tenancy.md)).
- The only raw SQL is `$queryRaw` for row locks and metrics. Always use tagged templates, never string concatenation.
- Never commit unless explicitly asked.

## Module layout (API)

`apps/api/src/modules/<name>/` holds the routes (thin, zod-validated), the service (the logic, which takes `tx`) and module-local types. Jobs live in `src/jobs/` and call services.

## Testing

- Vitest + Supertest against a **real Postgres** in Docker (no DB mocks). The mock EHR and dev SMS providers are the test doubles.
- Each test gets an isolated tenant (or a truncate between tests). Never depend on test order.
- Use a controllable clock helper for anything time-based (reminders, quiet hours, batch timeouts, expiry).
- Name tests after the behavior: `it('gives the slot to exactly one patient when two reply YES concurrently')`.
- Required tests per phase are listed in [phases.md](phases.md).
