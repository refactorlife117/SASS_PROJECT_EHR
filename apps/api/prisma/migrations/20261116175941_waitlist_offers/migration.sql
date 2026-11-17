-- CreateEnum
CREATE TYPE "waitlist_status" AS ENUM ('active', 'fulfilled', 'removed');

-- CreateEnum
CREATE TYPE "waitlist_source" AS ENUM ('staff', 'sms_opt_in');

-- CreateEnum
CREATE TYPE "offer_status" AS ENUM ('open', 'filled', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "offer_reply" AS ENUM ('accepted', 'declined');

-- CreateEnum
CREATE TYPE "offer_outcome" AS ENUM ('won', 'too_late');

-- CreateEnum
CREATE TYPE "waitlist_invite_status" AS ENUM ('sent', 'accepted');

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "provider_id" UUID,
    "visit_type_id" UUID NOT NULL,
    "current_appointment_id" UUID,
    "earliest_date" DATE NOT NULL,
    "preferred_windows" JSONB,
    "status" "waitlist_status" NOT NULL DEFAULT 'active',
    "source" "waitlist_source" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slot_offers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "visit_type_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "source_appointment_id" UUID NOT NULL,
    "status" "offer_status" NOT NULL DEFAULT 'open',
    "cancel_reason" TEXT,
    "next_batch_no" INTEGER NOT NULL DEFAULT 1,
    "filled_by_patient_id" UUID,
    "filled_appointment_id" UUID,
    "filled_visit_type_id" UUID,
    "filled_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slot_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_recipients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "waitlist_entry_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "mobile_e164" TEXT NOT NULL,
    "batch_no" INTEGER NOT NULL,
    "message_id" UUID,
    "sent_at" TIMESTAMPTZ(6),
    "reply" "offer_reply",
    "reply_message_id" UUID,
    "replied_at" TIMESTAMPTZ(6),
    "outcome" "offer_outcome",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "status" "waitlist_invite_status" NOT NULL DEFAULT 'sent',
    "message_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waitlist_entries_tenant_id_status_created_at_idx" ON "waitlist_entries"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "slot_offers_source_appointment_id_key" ON "slot_offers"("source_appointment_id");

-- CreateIndex
CREATE INDEX "slot_offers_tenant_id_status_created_at_idx" ON "slot_offers"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "offer_recipients_tenant_id_mobile_e164_idx" ON "offer_recipients"("tenant_id", "mobile_e164");

-- CreateIndex
CREATE UNIQUE INDEX "offer_recipients_offer_id_waitlist_entry_id_key" ON "offer_recipients"("offer_id", "waitlist_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_invites_appointment_id_key" ON "waitlist_invites"("appointment_id");

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_visit_type_id_fkey" FOREIGN KEY ("visit_type_id") REFERENCES "visit_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_current_appointment_id_fkey" FOREIGN KEY ("current_appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_visit_type_id_fkey" FOREIGN KEY ("visit_type_id") REFERENCES "visit_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_filled_visit_type_id_fkey" FOREIGN KEY ("filled_visit_type_id") REFERENCES "visit_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_source_appointment_id_fkey" FOREIGN KEY ("source_appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_filled_by_patient_id_fkey" FOREIGN KEY ("filled_by_patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_recipients" ADD CONSTRAINT "offer_recipients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_recipients" ADD CONSTRAINT "offer_recipients_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "slot_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_recipients" ADD CONSTRAINT "offer_recipients_waitlist_entry_id_fkey" FOREIGN KEY ("waitlist_entry_id") REFERENCES "waitlist_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_recipients" ADD CONSTRAINT "offer_recipients_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_invites" ADD CONSTRAINT "waitlist_invites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_invites" ADD CONSTRAINT "waitlist_invites_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================================
-- Hand-written below this line (Prisma cannot express it). See docs/tenancy.md.
-- =====================================================================================

ALTER TABLE "offer_recipients" ADD CONSTRAINT "offer_recipients_mobile_e164_format"
  CHECK ("mobile_e164" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_duration_positive" CHECK ("duration_min" > 0);

ALTER TABLE "waitlist_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "waitlist_entries"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "waitlist_entries" FROM slotfill_app;
-- Entries are soft-removed (status = removed), never deleted by the app.
GRANT SELECT, INSERT, UPDATE ON "waitlist_entries" TO slotfill_app;

ALTER TABLE "slot_offers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "slot_offers"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "slot_offers" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE ON "slot_offers" TO slotfill_app;

ALTER TABLE "offer_recipients" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "offer_recipients"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "offer_recipients" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE ON "offer_recipients" TO slotfill_app;

ALTER TABLE "waitlist_invites" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "waitlist_invites"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "waitlist_invites" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE ON "waitlist_invites" TO slotfill_app;
