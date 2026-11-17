# Tenant isolation

## Rules

- Every tenant table has `tenant_id uuid not null` and RLS **enabled** with a `tenant_isolation` policy (`USING` + `WITH CHECK`). `tenants` itself is isolated by `id`.
- Policies call `app_current_tenant_id()`, which returns `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. If the setting is unset, or was reset after a transaction, it returns NULL, so policies match **no rows (fail closed)**.
- The API and worker connect as **`slotfill_app`**: a non-owner role with `NOBYPASSRLS`, so it is always subject to RLS.
- Two connection strings:
  - `MIGRATE_DATABASE_URL`: owner role (`slotfill_owner`), used **only** by Prisma Migrate and the seed script.
  - `DATABASE_URL`: `slotfill_app`, used by the API and worker.
- The worker and webhook handlers resolve the tenant first (from the job payload, or from the inbound `to` number), then use `withTenant`.
- RLS is **not FORCEd**. The app never connects as the table owner, and leaving owners exempt lets the owner-owned `SECURITY DEFINER` lookups below work where the owner isn't a superuser (e.g. RDS).

## `withTenant`

`apps/api/src/db/client.ts` → `createDatabase(url)` returns a `Database`:

```ts
db.withTenant(tenantId, async (tx) => {
  // every query here uses tx; RLS restricts it to tenantId
});
db.unscoped; // RLS denies it all tenant rows. Only for the SECURITY DEFINER lookups below.
```

Internally this is a Prisma interactive transaction whose first statement is `SELECT set_config('app.tenant_id', $1, true)`. That setting is transaction-local (like `SET LOCAL`, but parameterizable). **All tenant queries must use `tx`.** The `Database` is injected via `createApp({ db, ... })`; there is no global Prisma client.

To get an audit entry or other write committed even when the operation fails, **return** a failure result from the `withTenant` callback and throw after it. A throw inside the callback rolls back everything (see `AuthService.verifyMfa`).

## Adding a tenant table (migration recipe)

Prisma can't express RLS in `schema.prisma`:

1. `pnpm --filter @slotfill/api exec prisma migrate dev --create-only --name <name>`
2. Append the following to the generated `migration.sql`, below the hand-written marker comment:
   ```sql
   ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON "<table>"
     USING ("tenant_id" = app_current_tenant_id())
     WITH CHECK ("tenant_id" = app_current_tenant_id());
   REVOKE ALL ON "<table>" FROM slotfill_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON "<table>" TO slotfill_app;  -- grant only what the app needs
   ```
   Grants are explicit in migrations (not only via the dev init script's default privileges), so every environment gets them. Every environment must have a role named `slotfill_app`.
3. `pnpm db:migrate` to apply.
4. `test/tenancy.test.ts` → "RLS coverage" discovers every table with a `tenant_id` column automatically and fails if RLS or the policy is missing.

## Pre-tenant lookups (the only cross-tenant reads)

These are `SECURITY DEFINER` functions owned by the table owner, with `search_path` pinned, `EXECUTE` revoked from `PUBLIC` and granted to `slotfill_app`. Each returns only the columns needed to then switch into `withTenant`.

| Function                         | Used by                            | Returns                                                              |
| -------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `auth_find_user_by_email(email)` | `AuthService.login`                | user id, tenant id, password hash, role, mfa_enabled                 |
| `auth_find_session(token_hash)`  | `SessionStore.find` (each request) | session + tenant/user ids, role, mfa state, last_seen_at, expires_at |

Planned: a lookup from tenant to SMS number for inbound SMS routing (Phase 3). Add each new one to this table.

`sms_tenant_by_number(number)` (used by `MessagingService.handleInbound`) returns the tenant id that owns an inbound `to` number.

`auth_find_user_by_reset_token(token_hash)` (password reset, Phase 7) returns user id, tenant id and expiry for a reset token hash.

`ehr_tenants_by_provider(ehr_type, ehr_provider_id)` (EHR webhooks, Phase 8) returns the tenant ids with an active connection of that EHR type that have that provider.

`ehr_list_active_connections()` (used by `enqueueSyncForAllTenants` in the worker) returns the tenant ids with an active EHR connection, and nothing else.

## Privileges worth knowing

- `audit_log` is **append-only** for the app (`SELECT, INSERT` only).
- `tenants`: the app can `SELECT, UPDATE` its own row only. Tenants are provisioned by the owner role (seed, later an admin tool).
- `_prisma_migrations`: no access for the app.

## Required test

A user of tenant A can never read or write tenant B's data, through any endpoint. This is covered by `apps/api/test/tenancy.test.ts`; extend its "isolation through the API" block whenever endpoints are added.
