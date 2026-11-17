# API and web app

## API (Express, `/api/v1`)

**Auth:** `POST /auth/login`, `POST /auth/mfa/verify`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/mfa/setup`

**Dashboard:** `GET /dashboard/summary?from&to`

**Appointments:** `GET /appointments?from&to&providerId&status` (ISO instants; range ≤ 62 days; audited as `appointment.list`). `GET /providers`: for filters (not in the original plan).

**Waitlist:** `GET /waitlist`, `POST /waitlist`, `PATCH /waitlist/:id`, `DELETE /waitlist/:id`

**Offers:** `GET /offers?status`, `GET /offers/:id` (with recipients), `POST /offers/:id/cancel`

**Messages:** `GET /messages?mobile&context`, `GET /messages/needs-attention`

**Settings:** `GET /settings`, `PATCH /settings`, `GET /visit-types`, `PATCH /visit-types/:id` (estimated value)

**Webhooks** (no session auth; signature-verified; rate-limited): `POST /webhooks/sms/:provider`, `POST /webhooks/ehr/:ehrType`

**Dev only** (registered only when `NODE_ENV=development`, behind `requireAuth`, scoped to the session's tenant):

- Mock EHR (Phase 2): `GET /dev/ehr/state`, `POST /dev/ehr/appointments` (`{patientId, providerId, visitTypeCode, date, time}` in tenant-local time), `POST /dev/ehr/appointments/:id/cancel`, `POST /dev/ehr/appointments/:id/move` (`{date, time}`), `POST /dev/ehr/sync`. Each change enqueues an incremental sync (a simulated webhook).
- SMS (Phase 3): `POST /dev/sms/inbound`, `GET /dev/sms/conversations`.
- `POST /dev/seed` was dropped. Use `pnpm db:seed` (and `SEED_RESET_MOCK=1` to regenerate the mock EHR).

Every body, query and webhook payload is validated with a zod schema from `packages/shared`.

## Web app (Next.js + React Query)

- In dev, Next.js `rewrites` proxy `/api/*` to the Express API so cookies are same-origin.
- One React Query hook per resource (`useWaitlist`, `useOffers`, …). Mutations invalidate the related queries. The offers and messages pages poll every 10 s.

### Pages

- `/login`, `/mfa`
- `/` dashboard: slots recovered, revenue recovered, fill rate, open offers, items needing attention
- `/waitlist`: list, add a patient (search synced patients), edit preferences, remove
- `/appointments`: upcoming appointments by day and provider, with status badges
- `/offers`: open/filled/expired offers with a recipient timeline
- `/messages`: conversation log, with a "needs attention" filter
- `/settings`: reminder timings, batch size/timeout, quiet hours, visit-type values
- `/dev/phone` (dev only): simulated phones; view texts and send replies
- `/dev/ehr` (dev only): mock EHR schedule; cancel, create and move appointments

## Implemented endpoints (all phases)

All endpoints are under `/api/v1`. **S** = signed-in (password + MFA), **O** = owner only, **P** = public, **W** = webhook (signature-verified).

| Area                           | Endpoints                                                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health                         | P `GET /health`, P `GET /health/ready` (checks the database)                                                                                                                                               |
| Auth                           | P `POST /auth/login`, `POST /auth/mfa/setup`, `POST /auth/mfa/verify` (pending session), `POST /auth/logout`, S `GET /auth/me`, P `POST /auth/password/forgot` (always 202), P `POST /auth/password/reset` |
| Dashboard                      | S `GET /dashboard/summary?from&to`                                                                                                                                                                         |
| Appointments                   | S `GET /appointments?from&to&providerId&status`, S `GET /providers`                                                                                                                                        |
| Waitlist                       | S `GET /waitlist?status`, S `POST /waitlist`, S `PATCH /waitlist/:id`, S `DELETE /waitlist/:id` (soft), S `GET /patients?search`                                                                           |
| Offers                         | S `GET /offers?status`, S `GET /offers/:id`, S `POST /offers/:id/cancel`                                                                                                                                   |
| Messages                       | S `GET /messages?mobile&context`, S `GET /messages/needs-attention`, S `POST /messages/:id/resolve`                                                                                                        |
| Settings                       | S `GET /settings`, O `PATCH /settings` (incl. `smsProvider`), S `GET /visit-types`, O `PATCH /visit-types/:id`                                                                                             |
| EHR                            | S `GET /ehr/connection`, O `POST /ehr/drchrono/authorize`, P `GET /ehr/drchrono/callback` (signed state cookie)                                                                                            |
| Webhooks                       | W `POST /webhooks/sms/:provider` (`dev`, `aws` via SNS, `twilio`), W `GET\|POST /webhooks/ehr/drchrono`                                                                                                    |
| Dev only (development/staging) | `/dev/ehr/*` (state, create, move, cancel, sync, remind-now, reminders/replan), `/dev/sms/*` (conversations, inbound, send-test)                                                                           |
