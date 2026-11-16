-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('outbound', 'inbound');

-- CreateEnum
CREATE TYPE "message_context_type" AS ENUM ('reminder', 'offer', 'waitlist_invite', 'system');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('queued', 'sent', 'delivered', 'failed', 'received');

-- CreateEnum
CREATE TYPE "consent_status" AS ENUM ('opted_in', 'opted_out');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "contact_phone" TEXT;

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "direction" "message_direction" NOT NULL,
    "mobile_e164" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "context_type" "message_context_type",
    "context_id" UUID,
    "status" "message_status" NOT NULL,
    "needs_attention" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_consents" (
    "tenant_id" UUID NOT NULL,
    "mobile_e164" TEXT NOT NULL,
    "status" "consent_status" NOT NULL,
    "source" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_consents_pkey" PRIMARY KEY ("tenant_id","mobile_e164")
);

-- CreateIndex
CREATE INDEX "messages_tenant_id_mobile_e164_created_at_idx" ON "messages"("tenant_id", "mobile_e164", "created_at");

-- CreateIndex
CREATE INDEX "messages_tenant_id_needs_attention_idx" ON "messages"("tenant_id", "needs_attention");

-- CreateIndex
CREATE INDEX "messages_tenant_id_context_type_context_id_idx" ON "messages"("tenant_id", "context_type", "context_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_provider_provider_message_id_key" ON "messages"("provider", "provider_message_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_consents" ADD CONSTRAINT "sms_consents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================================
-- Hand-written below this line (Prisma cannot express it). See docs/tenancy.md.
-- =====================================================================================

ALTER TABLE "messages" ADD CONSTRAINT "messages_mobile_e164_format"
  CHECK ("mobile_e164" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "sms_consents" ADD CONSTRAINT "sms_consents_mobile_e164_format"
  CHECK ("mobile_e164" ~ '^\+[1-9][0-9]{6,14}$');

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "messages"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "messages" FROM slotfill_app;
-- Messages are a record: the app never deletes them.
GRANT SELECT, INSERT, UPDATE ON "messages" TO slotfill_app;

ALTER TABLE "sms_consents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_consents"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "sms_consents" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE ON "sms_consents" TO slotfill_app;

-- Pre-tenant lookup for inbound SMS: which tenant owns this sending number. Returns the id only.
CREATE FUNCTION sms_tenant_by_number(p_number text)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ SELECT t.id FROM tenants t WHERE t.sms_number = p_number $$;
REVOKE ALL ON FUNCTION sms_tenant_by_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sms_tenant_by_number(text) TO slotfill_app;
