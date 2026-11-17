-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "sms_provider" TEXT;

-- =====================================================================================
-- Hand-written below this line (Prisma cannot express it). See docs/tenancy.md.
-- =====================================================================================

ALTER TABLE "tenants" ADD CONSTRAINT "tenants_sms_provider_known"
  CHECK ("sms_provider" IS NULL OR "sms_provider" IN ('dev', 'aws', 'twilio'));
