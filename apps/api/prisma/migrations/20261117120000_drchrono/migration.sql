-- AlterEnum
ALTER TYPE "ehr_type" ADD VALUE 'drchrono';

-- =====================================================================================
-- Hand-written below this line (Prisma cannot express it). See docs/tenancy.md.
-- =====================================================================================

-- Owners connect a real EHR through the OAuth flow, which creates or replaces the connection row.
GRANT INSERT ON "ehr_connections" TO slotfill_app;

-- Pre-tenant lookup for EHR webhooks: which tenant owns this EHR provider id (for one EHR type).
-- Returns tenant ids only.
CREATE FUNCTION ehr_tenants_by_provider(p_ehr_type text, p_ehr_provider_id text)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT p.tenant_id
    FROM providers p
    JOIN ehr_connections c ON c.tenant_id = p.tenant_id
    WHERE c.ehr_type::text = p_ehr_type AND c.status = 'active' AND p.ehr_provider_id = p_ehr_provider_id
  $$;
REVOKE ALL ON FUNCTION ehr_tenants_by_provider(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ehr_tenants_by_provider(text, text) TO slotfill_app;
