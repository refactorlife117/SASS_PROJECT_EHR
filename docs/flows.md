# Core flows

## EHR sync

1. **Initial backfill** on connection: providers, then visit types, then appointments from today to +60 days along with their patients.
2. **Incremental sync** job every 2 minutes per tenant: `listChangedAppointments(since=last_synced_at)`, then upsert. Real adapters with webhooks enqueue the same processing job.
3. **Nightly full resync** of the next 60 days to repair missed events.
4. Every appointment status change emits the internal event `appointment.changed` (an enqueued pg-boss job). Processing that event triggers reminders, cancellation handling and waitlist invites.

### As implemented (Phase 2): `apps/api/src/modules/ehr/sync.ts`

- **Mode:** a connection that has never synced always runs `full` (yesterday → +60 days). `incremental` reads changes since `last_synced_at − 60 s`; the overlap tolerates clock skew and late commits.
- **Two steps:**
  - **Fetch:** all EHR calls happen outside any transaction. Patients are fetched only if unknown locally (all of them in full mode). Providers and visit types are re-listed when an appointment references an unknown one.
  - **Apply:** one tenant transaction does every upsert, every event, and the cursor update. Events are enqueued **through the same transaction** (pg-boss `db` option), so an event exists if and only if its data change committed.
- **Change detection:** an EHR row is skipped unless its `updatedAt` is newer than the stored `ehr_updated_at` (making syncs idempotent and ignoring stale data). Event `change` is one of:
  - `created`
  - `status_changed` (carries `previousStatus`)
  - `rescheduled` (start time or provider changed)
- **Local confirmations win:** EHR `booked` never downgrades a SlotFill `confirmed`.
- **Not handled yet:** appointments _deleted_ (not cancelled) in the EHR. Revisit with the real adapter (Phase 8).
- **Errors:** `ehr_connections.last_error` stores only the error class name (EHR messages could contain PHI); pg-boss retries the job.
- **Scheduling** (`apps/api/src/jobs/`):
  - `ehr.sync-all` runs every 2 min and `ehr.resync-all` runs at 07:00 UTC. Each fans out one `ehr.sync` per tenant with an active connection, via the `ehr_list_active_connections()` pre-tenant lookup.
  - `ehr.sync` is `stately` with `singletonKey = tenantId`: at most one queued and one running per tenant.
  - The worker also fans out once on startup.
- **Dev "webhook":** every `/dev/ehr` change enqueues an incremental `ehr.sync` for the tenant, the way a real EHR webhook would. Changes written straight into `mock_*` tables are picked up by the 2-minute job.

## Reminders

- When an appointment is created or rescheduled, schedule reminder jobs at each `reminder_hours_before`.
- Before sending, re-check that the appointment is still `booked`, that consent isn't `opted_out`, and that it's not quiet hours. During quiet hours, defer to the end of quiet hours if that is still before the appointment.
- Message: `Hi {firstName}, reminder: {clinic} with {provider} on {date} at {time}. Reply 1 to confirm, 2 to cancel. Reply STOP to opt out.`
- Reply `1` → status `confirmed` (local; also written to the EHR if the adapter supports it). Reply `2` → cancel in the EHR, then the cancellation flow runs.
- No diagnoses or visit reasons in any text (minimum necessary PHI).

## Inbound message handling

1. Verify the provider signature (skipped for the dev provider). Dedupe by `provider_message_id`.
2. Resolve the tenant by the `to` number. Store the message.
3. Normalize the body (trim, uppercase).
4. **Compliance keywords first, always:**
   - `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` → mark opted_out, send one confirmation, stop.
   - `START`, `UNSTOP` → opted_in.
   - `HELP` → reply with the clinic name and phone number.
   - `CANCEL` is a carrier opt-out keyword, so appointment cancellation uses `2`, never "CANCEL".
5. Find the context: the most recent outbound message with a context sent to this number (same tenant) in the last 72 hours. Route by context:
   - `reminder` context: `1` / `2`
   - `offer` context: `YES` (also accept `Y`)
   - `waitlist_invite` context: `EARLY`
6. Anything else: reply once with a short help text and flag the message in the dashboard for staff.

## Cancellation → offer engine

**Trigger:** an appointment becomes `cancelled` with `starts_at` between `now + min_notice_min` and `now + backfill_horizon_days`.

1. Create a `slot_offers` row (`open`, `expires_at = starts_at - min_notice_min`).
2. **Select candidates** from active waitlist entries where all of the following hold:
   - the provider matches (or the entry accepts any provider)
   - visit type duration ≤ slot duration
   - `earliest_date` ≤ slot date
   - their `current_appointment_id` (if any) is later than the slot
   - the slot falls inside `preferred_windows` (if set)
   - consent is not opted_out
   - the patient has no other open offer pending a reply
   - the patient hasn't already been sent this offer

   Order by `created_at` ascending (longest waiting first).

3. If it's quiet hours, schedule the first batch for the end of quiet hours, provided that is still before `expires_at`.
4. Send a batch of `offer_batch_size`: `Hi {firstName}, an earlier appointment opened with {provider} on {date} at {time}. Reply YES to take it. First to reply gets it.`
5. Schedule an `offer.next-batch` job after `offer_batch_timeout_min`. If the offer is still `open`, send the next batch. If no candidates remain, leave the offer open until it expires.
6. Schedule `offer.expire` at `expires_at`.

## Accepting an offer (race-safe booking)

```
1. Inbound "YES" with offer context → recipient row found.
2. Inside withTenant: lock the offer with tx.$queryRaw
   (SELECT ... FROM slot_offers WHERE id = ${offerId} FOR UPDATE). Prisma has no row-lock API.
3. If status != 'open' → recipient outcome 'too_late', text "Sorry, that spot was just taken.", COMMIT, done.
4. adapter.isSlotOpen(...). If false → offer 'cancelled', tell patient it's gone, COMMIT, done.
5. adapter.bookAppointment(...) → new EHR appointment.
6. If waitlist entry has current_appointment_id → adapter.cancelAppointment(old, 'moved earlier via SlotFill').
7. Update offer 'filled', recipient 'won', waitlist entry 'fulfilled'; upsert new appointment (source 'slotfill').
8. COMMIT. Then send confirmation to winner and "filled" notice to others offered this slot who haven't replied.
```

- The patient's old appointment, cancelled in step 6, frees a later slot. That cancellation **does** trigger the offer engine, so the freed slot is offered onward (a chain). A test is required for this chain.
- If step 5 or 6 fails after step 4, roll back, alert staff in the dashboard, and tell the patient the clinic will call them.

## Waitlist invites

- If `auto_waitlist_invite` is on and an appointment is booked ≥ `auto_waitlist_min_days_out` days ahead, send this once per appointment: `Would you like an earlier appointment if one opens up? Reply EARLY and we'll text you.`
- `EARLY` → create a waitlist entry with source `sms_opt_in`, provider = their booked provider, visit type = their visit type, and current appointment = this one.

## Metrics

- **Slots recovered**: offers `filled`.
- **Revenue recovered**: sum of `visit_types.estimated_value_cents` for filled offers.
- **Fill rate**: filled / (filled + expired).
- **Median time to fill**: `filled_at - created_at`.
- **Confirmation rate** for reminders.
