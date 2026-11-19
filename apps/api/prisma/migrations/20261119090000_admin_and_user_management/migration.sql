-- AlterEnum
ALTER TYPE "user_role" ADD VALUE 'platform_admin';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "is_platform" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "disabled_at" TIMESTAMPTZ(6),
ADD COLUMN     "invited_at" TIMESTAMPTZ(6);

-- =====================================================================================
-- Hand-written below this line (Prisma cannot express it). See docs/tenancy.md.
-- =====================================================================================

-- Admin onboarding creates a clinic by inserting its tenant row inside withTenant(<new id>). The
-- tenants policy's WITH CHECK (id = app_current_tenant_id()) still applies, so the app can only ever
-- create the one tenant its transaction is scoped to.
GRANT INSERT ON "tenants" TO slotfill_app;

-- Platform admins live only in the platform tenant, and the platform tenant holds only platform
-- admins. Defense in depth: the API never assigns this role, but no code path can mix them either.
-- The role is compared as text because this migration also adds the enum value (not usable here).
CREATE FUNCTION users_role_matches_tenant() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF (NEW.role::text = 'platform_admin') IS DISTINCT FROM
       (SELECT t.is_platform FROM tenants t WHERE t.id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'platform_admin users must belong to the platform tenant, and only to it';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER users_role_matches_tenant
  BEFORE INSERT OR UPDATE OF role, tenant_id ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_role_matches_tenant();

-- Deactivated users can't sign in, keep a session or use a reset/invite link.
CREATE OR REPLACE FUNCTION auth_find_user_by_email(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, role user_role, mfa_enabled boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.tenant_id, u.password_hash, u.role, u.mfa_enabled
    FROM users u
    WHERE u.email = lower(p_email) AND u.disabled_at IS NULL
  $$;

CREATE OR REPLACE FUNCTION auth_find_session(p_token_hash text)
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
    WHERE s.token_hash = p_token_hash AND u.disabled_at IS NULL
  $$;

CREATE OR REPLACE FUNCTION auth_find_user_by_reset_token(p_token_hash text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.tenant_id, u.reset_expires_at FROM users u
    WHERE u.reset_token_hash = p_token_hash AND u.disabled_at IS NULL
  $$;

-- Platform admin console: the list of clinics. Operational fields only, never patient data.
CREATE FUNCTION admin_list_clinics()
  RETURNS TABLE (
    tenant_id uuid, name text, timezone text, sms_number text, created_at timestamptz,
    active_users bigint, invited_users bigint,
    ehr_type text, ehr_status text, ehr_last_synced_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.id, t.name, t.timezone, t.sms_number, t.created_at,
           (SELECT count(*) FROM users u
             WHERE u.tenant_id = t.id AND u.disabled_at IS NULL AND u.invited_at IS NULL),
           (SELECT count(*) FROM users u
             WHERE u.tenant_id = t.id AND u.disabled_at IS NULL AND u.invited_at IS NOT NULL),
           c.ehr_type::text, c.status::text, c.last_synced_at
    FROM tenants t
    LEFT JOIN ehr_connections c ON c.tenant_id = t.id
    WHERE NOT t.is_platform
    ORDER BY t.created_at DESC, t.id
  $$;

-- The platform tenant's id, or NULL before the first platform admin is created.
CREATE FUNCTION platform_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ SELECT t.id FROM tenants t WHERE t.is_platform ORDER BY t.created_at LIMIT 1 $$;

REVOKE ALL ON FUNCTION admin_list_clinics() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_list_clinics() TO slotfill_app;
GRANT EXECUTE ON FUNCTION platform_tenant_id() TO slotfill_app;
