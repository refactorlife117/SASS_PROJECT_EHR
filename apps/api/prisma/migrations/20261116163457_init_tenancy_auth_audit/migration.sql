-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('owner', 'staff');

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('user', 'system', 'patient');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "sms_number" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_settings" (
    "tenant_id" UUID NOT NULL,
    "reminder_hours_before" INTEGER[] DEFAULT ARRAY[48, 24]::INTEGER[],
    "offer_batch_size" INTEGER NOT NULL DEFAULT 3,
    "offer_batch_timeout_min" INTEGER NOT NULL DEFAULT 15,
    "min_notice_min" INTEGER NOT NULL DEFAULT 120,
    "backfill_horizon_days" INTEGER NOT NULL DEFAULT 14,
    "quiet_hours_start" TEXT NOT NULL DEFAULT '21:00',
    "quiet_hours_end" TEXT NOT NULL DEFAULT '08:00',
    "auto_waitlist_invite" BOOLEAN NOT NULL DEFAULT true,
    "auto_waitlist_min_days_out" INTEGER NOT NULL DEFAULT 10,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL,
    "mfa_secret_enc" BYTEA,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_last_time_step" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "mfa_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entity_id" TEXT,
    "ip" INET,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_sms_number_key" ON "tenants"("sms_number");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_tenant_id_idx" ON "sessions"("tenant_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_at_idx" ON "audit_log"("tenant_id", "at");

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================================
-- Hand-written below this line (Prisma cannot express it). See docs/tenancy.md.
-- =====================================================================================

-- Data integrity
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_quiet_hours_format"
  CHECK ("quiet_hours_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "quiet_hours_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_offer_batch_size_positive" CHECK ("offer_batch_size" >= 1);

-- Current tenant for RLS. Set per transaction by withTenant() via set_config('app.tenant_id', ..., true).
-- An unset or reset setting yields NULL, so every policy denies all rows (fail closed).
CREATE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- RLS is ENABLEd but not FORCEd: the app connects as slotfill_app (never the table owner), so it is
-- always subject to RLS. Not forcing lets the owner-owned SECURITY DEFINER lookups below work in
-- environments where the owner is not a superuser (e.g. RDS).

-- tenants: the app may read/update its own tenant row only. Tenants are provisioned by the owner role.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenants"
  USING ("id" = app_current_tenant_id())
  WITH CHECK ("id" = app_current_tenant_id());
REVOKE ALL ON "tenants" FROM slotfill_app;
GRANT SELECT, UPDATE ON "tenants" TO slotfill_app;

ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_settings"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "tenant_settings" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE ON "tenant_settings" TO slotfill_app;

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "users"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "users" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "users" TO slotfill_app;

ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sessions"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "sessions" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sessions" TO slotfill_app;

-- audit_log is append-only for the app: no UPDATE/DELETE/TRUNCATE.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "audit_log" FROM slotfill_app;
GRANT SELECT, INSERT ON "audit_log" TO slotfill_app;
GRANT USAGE ON SEQUENCE "audit_log_id_seq" TO slotfill_app;

-- Prisma's bookkeeping table is not the app's business. (Absent in Prisma's shadow database.)
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON "_prisma_migrations" FROM slotfill_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------
-- Pre-tenant lookups. These are the ONLY ways the app reads across tenants, and each returns
-- exactly the columns needed to then switch into withTenant(). Owned by the table owner.
-- ---------------------------------------------------------------------------------------

-- Login: find a user by (lower-cased) email.
CREATE FUNCTION auth_find_user_by_email(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, role user_role, mfa_enabled boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.tenant_id, u.password_hash, u.role, u.mfa_enabled
    FROM users u
    WHERE u.email = lower(p_email)
  $$;

-- Session middleware: resolve a session cookie (by token hash) to its tenant and user.
CREATE FUNCTION auth_find_session(p_token_hash text)
  RETURNS TABLE (
    session_id uuid, tenant_id uuid, user_id uuid, role user_role, mfa_enabled boolean,
    mfa_verified_at timestamptz, last_seen_at timestamptz, expires_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT s.id, s.tenant_id, s.user_id, u.role, u.mfa_enabled,
           s.mfa_verified_at, s.last_seen_at, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = p_token_hash
  $$;

REVOKE ALL ON FUNCTION auth_find_user_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(text) TO slotfill_app;
GRANT EXECUTE ON FUNCTION auth_find_session(text) TO slotfill_app;
