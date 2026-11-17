-- CreateEnum
CREATE TYPE "reminder_status" AS ENUM ('scheduled', 'sent', 'skipped', 'cancelled');

-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "hours_before" INTEGER NOT NULL,
    "appointment_starts_at" TIMESTAMPTZ(6) NOT NULL,
    "send_after" TIMESTAMPTZ(6) NOT NULL,
    "status" "reminder_status" NOT NULL DEFAULT 'scheduled',
    "skip_reason" TEXT,
    "message_id" UUID,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reminders_tenant_id_status_idx" ON "reminders"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_appointment_id_hours_before_appointment_starts_at_key" ON "reminders"("appointment_id", "hours_before", "appointment_starts_at");

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================================
-- Hand-written below this line (Prisma cannot express it). See docs/tenancy.md.
-- =====================================================================================

ALTER TABLE "reminders" ADD CONSTRAINT "reminders_hours_before_positive" CHECK ("hours_before" > 0);

ALTER TABLE "reminders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reminders"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "reminders" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE ON "reminders" TO slotfill_app;
