-- AlterTable
ALTER TABLE "users" ADD COLUMN     "reset_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "reset_token_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_reset_token_hash_key" ON "users"("reset_token_hash");

-- =====================================================================================
-- Hand-written below this line (Prisma cannot express it). See docs/tenancy.md.
-- =====================================================================================

-- Pre-tenant lookup for password reset: resolve a token hash to its user and tenant.
CREATE FUNCTION auth_find_user_by_reset_token(p_token_hash text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.tenant_id, u.reset_expires_at FROM users u WHERE u.reset_token_hash = p_token_hash
  $$;
REVOKE ALL ON FUNCTION auth_find_user_by_reset_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_by_reset_token(text) TO slotfill_app;
