-- CreateEnum
CREATE TYPE "ehr_type" AS ENUM ('mock');

-- CreateEnum
CREATE TYPE "ehr_connection_status" AS ENUM ('active', 'error', 'disabled');

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('booked', 'confirmed', 'cancelled', 'no_show', 'completed');

-- CreateEnum
CREATE TYPE "appointment_source" AS ENUM ('ehr', 'slotfill');

-- CreateTable
CREATE TABLE "ehr_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "ehr_type" "ehr_type" NOT NULL,
    "credentials_enc" BYTEA,
    "status" "ehr_connection_status" NOT NULL DEFAULT 'active',
    "last_synced_at" TIMESTAMPTZ(6),
    "last_full_sync_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ehr_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "ehr_provider_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visit_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "estimated_value_cents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "visit_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "ehr_patient_id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "mobile_e164" TEXT,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "ehr_appointment_id" TEXT NOT NULL,
    "patient_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "visit_type_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "status" "appointment_status" NOT NULL,
    "source" "appointment_source" NOT NULL DEFAULT 'ehr',
    "ehr_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,

    CONSTRAINT "mock_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_visit_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "duration_min" INTEGER NOT NULL,

    CONSTRAINT "mock_visit_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_patients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "mobile_e164" TEXT,

    CONSTRAINT "mock_patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_appointments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "visit_type_code" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "status" "appointment_status" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mock_appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ehr_connections_tenant_id_key" ON "ehr_connections"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "providers_tenant_id_ehr_provider_id_key" ON "providers"("tenant_id", "ehr_provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "visit_types_tenant_id_code_key" ON "visit_types"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "patients_tenant_id_mobile_e164_idx" ON "patients"("tenant_id", "mobile_e164");

-- CreateIndex
CREATE UNIQUE INDEX "patients_tenant_id_ehr_patient_id_key" ON "patients"("tenant_id", "ehr_patient_id");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_starts_at_idx" ON "appointments"("tenant_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_tenant_id_ehr_appointment_id_key" ON "appointments"("tenant_id", "ehr_appointment_id");

-- CreateIndex
CREATE INDEX "mock_providers_tenant_id_idx" ON "mock_providers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "mock_visit_types_tenant_id_code_key" ON "mock_visit_types"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "mock_patients_tenant_id_idx" ON "mock_patients"("tenant_id");

-- CreateIndex
CREATE INDEX "mock_appointments_tenant_id_starts_at_idx" ON "mock_appointments"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "mock_appointments_tenant_id_updated_at_idx" ON "mock_appointments"("tenant_id", "updated_at");

-- AddForeignKey
ALTER TABLE "ehr_connections" ADD CONSTRAINT "ehr_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "providers" ADD CONSTRAINT "providers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_types" ADD CONSTRAINT "visit_types_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_visit_type_id_fkey" FOREIGN KEY ("visit_type_id") REFERENCES "visit_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================================
-- Hand-written below this line (Prisma cannot express it). See docs/tenancy.md.
-- =====================================================================================

-- Data integrity
ALTER TABLE "patients" ADD CONSTRAINT "patients_mobile_e164_format"
  CHECK ("mobile_e164" IS NULL OR "mobile_e164" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "mock_patients" ADD CONSTRAINT "mock_patients_mobile_e164_format"
  CHECK ("mobile_e164" IS NULL OR "mobile_e164" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_duration_positive" CHECK ("duration_min" > 0);
ALTER TABLE "visit_types" ADD CONSTRAINT "visit_types_duration_positive" CHECK ("duration_min" > 0);
ALTER TABLE "visit_types" ADD CONSTRAINT "visit_types_value_non_negative" CHECK ("estimated_value_cents" >= 0);
ALTER TABLE "mock_appointments" ADD CONSTRAINT "mock_appointments_duration_positive" CHECK ("duration_min" > 0);

-- ehr_connections: created by provisioning (owner role / seed); the app reads and updates sync state.
ALTER TABLE "ehr_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ehr_connections"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "ehr_connections" FROM slotfill_app;
GRANT SELECT, UPDATE ON "ehr_connections" TO slotfill_app;

ALTER TABLE "providers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "providers"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "providers" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "providers" TO slotfill_app;

ALTER TABLE "visit_types" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "visit_types"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "visit_types" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "visit_types" TO slotfill_app;

ALTER TABLE "patients" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patients"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "patients" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "patients" TO slotfill_app;

ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointments"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "appointments" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "appointments" TO slotfill_app;

ALTER TABLE "mock_providers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mock_providers"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "mock_providers" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "mock_providers" TO slotfill_app;

ALTER TABLE "mock_visit_types" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mock_visit_types"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "mock_visit_types" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "mock_visit_types" TO slotfill_app;

ALTER TABLE "mock_patients" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mock_patients"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "mock_patients" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "mock_patients" TO slotfill_app;

ALTER TABLE "mock_appointments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mock_appointments"
  USING ("tenant_id" = app_current_tenant_id())
  WITH CHECK ("tenant_id" = app_current_tenant_id());
REVOKE ALL ON "mock_appointments" FROM slotfill_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "mock_appointments" TO slotfill_app;

-- Pre-tenant lookup for the worker's sync scheduler: which tenants have an active EHR connection.
-- Returns ids only.
CREATE FUNCTION ehr_list_active_connections()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.tenant_id FROM ehr_connections c WHERE c.status = 'active' ORDER BY c.tenant_id
  $$;
REVOKE ALL ON FUNCTION ehr_list_active_connections() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ehr_list_active_connections() TO slotfill_app;
