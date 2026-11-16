-- Runs once, on first container start (empty volume).
-- slotfill_owner (POSTGRES_USER) owns the schema and is used only by Prisma Migrate.
-- slotfill_app is the runtime role for the API and worker: not an owner, cannot bypass RLS.

CREATE ROLE slotfill_app LOGIN PASSWORD 'slotfill_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE DATABASE slotfill_test OWNER slotfill_owner;

\connect slotfill
GRANT CONNECT ON DATABASE slotfill TO slotfill_app;
GRANT USAGE ON SCHEMA public TO slotfill_app;
ALTER DEFAULT PRIVILEGES FOR ROLE slotfill_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO slotfill_app;
ALTER DEFAULT PRIVILEGES FOR ROLE slotfill_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO slotfill_app;
-- pg-boss manages its own tables; give the app role its own schema for them.
CREATE SCHEMA pgboss AUTHORIZATION slotfill_app;

\connect slotfill_test
GRANT CONNECT ON DATABASE slotfill_test TO slotfill_app;
GRANT USAGE ON SCHEMA public TO slotfill_app;
ALTER DEFAULT PRIVILEGES FOR ROLE slotfill_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO slotfill_app;
ALTER DEFAULT PRIVILEGES FOR ROLE slotfill_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO slotfill_app;
CREATE SCHEMA pgboss AUTHORIZATION slotfill_app;
