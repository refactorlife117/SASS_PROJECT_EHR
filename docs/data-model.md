# Data model

All tenant-owned tables have `tenant_id uuid not null` and RLS enabled (see [tenancy.md](tenancy.md)). The schema below is abbreviated; the Prisma schema is the source of truth once it exists.

```sql
tenants (id uuid pk, name text, timezone text, sms_number text unique, created_at timestamptz)

tenant_settings (
  tenant_id uuid pk,
  reminder_hours_before int[] default '{48,24}',
  offer_batch_size int default 3,
  offer_batch_timeout_min int default 15,
  min_notice_min int default 120,          -- don't offer slots starting sooner than this
  backfill_horizon_days int default 14,    -- don't offer slots further out than this
  quiet_hours_start time default '21:00',  -- no texts during quiet hours (tenant local time)
  quiet_hours_end time default '08:00',
  auto_waitlist_invite boolean default true,
  auto_waitlist_min_days_out int default 10
)

users (id, tenant_id, email unique, password_hash, role enum('owner','staff'), mfa_secret_enc bytea, mfa_enabled bool, created_at)
sessions (id, user_id, expires_at, last_seen_at)

ehr_connections (id, tenant_id, ehr_type enum('mock', ...), credentials_enc bytea, status, last_synced_at)

providers (id, tenant_id, ehr_provider_id, display_name, unique(tenant_id, ehr_provider_id))
visit_types (id, tenant_id, code, name, duration_min, estimated_value_cents)
patients (id, tenant_id, ehr_patient_id, first_name, last_name, mobile_e164, unique(tenant_id, ehr_patient_id))

appointments (
  id, tenant_id, ehr_appointment_id, patient_id, provider_id, visit_type_id,
  starts_at timestamptz, duration_min int,
  status enum('booked','confirmed','cancelled','no_show','completed'),
  source enum('ehr','slotfill'),
  ehr_updated_at timestamptz,
  unique(tenant_id, ehr_appointment_id)
)

waitlist_entries (
  id, tenant_id, patient_id,
  provider_id nullable,               -- null = any provider
  visit_type_id,
  current_appointment_id nullable,    -- their existing later appointment, if any
  earliest_date date,
  preferred_windows jsonb,            -- e.g. [{"dow":[1,2,3],"from":"09:00","to":"13:00"}]
  status enum('active','fulfilled','removed'),
  source enum('staff','sms_opt_in'),
  created_at
)

sms_consents (tenant_id, mobile_e164, status enum('opted_in','opted_out'), source text, updated_at, pk(tenant_id, mobile_e164))

slot_offers (
  id, tenant_id, provider_id, visit_type_id, starts_at, duration_min,
  source_appointment_id,
  status enum('open','filled','expired','cancelled'),
  filled_by_patient_id nullable, filled_appointment_id nullable,
  expires_at, created_at
)

offer_recipients (
  id, offer_id, waitlist_entry_id, patient_id, mobile_e164, batch_no int,
  sent_at, reply enum('accepted','declined') nullable, replied_at,
  outcome enum('won','too_late') nullable
)

messages (
  id, tenant_id, direction enum('out','in'), mobile_e164, body text,
  provider text, provider_message_id text unique,
  context_type enum('reminder','offer','waitlist_invite','system') nullable, context_id uuid nullable,
  status enum('queued','sent','delivered','failed','received'), created_at
)

audit_log (id bigserial, tenant_id, actor_type enum('user','system','patient'), actor_id, action, entity, entity_id, ip inet, at timestamptz)
```

## Notes

Implemented so far: `tenants`, `tenant_settings`, `users`, `sessions`, `audit_log` (Phase 1); `ehr_connections`, `providers`, `visit_types`, `patients`, `appointments` and the `mock_*` tables (Phase 2). See `apps/api/prisma/schema.prisma`. Differences from the sketch above:

- `sessions` also has `tenant_id` (for RLS), `token_hash` (HMAC of the cookie token; the raw token is never stored), `mfa_verified_at` (null = password-only pending session) and `created_at`.
- `users.mfa_last_time_step`: TOTP replay protection. `users.email` is stored lower-cased (CHECK constraint).
- `tenant_settings.quiet_hours_*` are `"HH:MM"` text with a format CHECK, not `time`.
- `tenants.sms_number` is nullable until a number is provisioned.
- `tenants.is_platform`: the single internal tenant for platform admins. `user_role` also has `platform_admin`.
- `users.invited_at` (set while an invite is pending; the invite link is a reset token) and `users.disabled_at` (deactivated).
- `ehr_connections`: one per tenant (`tenant_id` unique). Adds `last_full_sync_at` and `last_error` (error class only). `status` is `active | error | disabled`. The app role can only SELECT/UPDATE it; connections are provisioned by the owner role.
- `appointments` also has `created_at` and `updated_at`. `patients.mobile_e164` is nullable and has an E.164 CHECK.
- `visit_types.estimated_value_cents` defaults to 0 and is never overwritten by sync (it belongs to the clinic).
- **Mock EHR tables** (`mock_providers`, `mock_visit_types`, `mock_patients`, `mock_appointments`): the fake external EHR. They carry `tenant_id` and are under RLS like everything else. Their ids are the "EHR ids" that the domain tables store in `ehr_*_id`. `mock_appointments.updated_at` drives incremental sync.

- **One mobile number can belong to several patients** (for example, a parent who books for their children). Never resolve a reply by phone number → patient alone. Resolve it by the context of the most recent outbound message (see [flows.md](flows.md#inbound-message-handling)).
- The unique constraint on `messages.provider_message_id` makes webhook handling idempotent.
- `credentials_enc` and `mfa_secret_enc` are encrypted with AES-256-GCM. The key comes from env in dev and from a KMS data key in prod.
- Metrics need a fill timestamp. Add `filled_at` to `slot_offers` (median time to fill = `filled_at - created_at`).
- `offer_recipients` has no `tenant_id` in the sketch. Add one so that RLS applies uniformly.
- `mock_*` tables (the mock EHR) are dev-only fakes and are kept separate from the real domain tables.
