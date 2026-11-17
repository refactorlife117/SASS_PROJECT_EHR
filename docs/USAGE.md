# SlotFill: how to use each phase

This is a hands-on guide: what each phase gives you and how to try it on your machine. For setup details, see [dev-setup.md](dev-setup.md); for the reasoning behind choices, see [decisions.md](decisions.md).

## Status at a glance (2026-11-17)

| Phase                         | Status                      | Verified by                                                                                                 |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0 Scaffold                    | ✅ done                     | builds, health check                                                                                        |
| 1 Tenancy, auth, audit        | ✅ done                     | tests (RLS on every table), live login + MFA                                                                |
| 2 Mock EHR + sync             | ✅ done                     | tests, live: `/dev/ehr` change → `/appointments` in ~2 s; cron path in < 1 sync cycle                       |
| 3 Messaging                   | ✅ done                     | tests, live: Mailpit + simulator, STOP/START/HELP, webhook dedupe                                           |
| 4 Reminders                   | ✅ done                     | tests (time travel), live: reminder → "2" → cancelled in mock EHR                                           |
| 5 Waitlist + offers + booking | ✅ done                     | all required tests (concurrent YES, slot taken, quiet hours, opt-out, shared phone, chain), live end to end |
| 6 Dashboard + settings        | ✅ done                     | tests (exact metrics), live dashboard = DB                                                                  |
| 7 Hardening + AWS             | 🟡 built + verified offline | tests, Docker images build + run, CDK synth + 10 assertion tests. **Deploy needs your AWS account.**        |
| 8 Real EHR (DrChrono)         | 🟡 built + contract-tested  | 12 tests against a doc-based fake DrChrono. **Sandbox check needs a DrChrono account.**                     |
| 9 Twilio (optional)           | ✅ done, inactive           | tests incl. Twilio's official signature vector; blocked in production until the Twilio BAA is signed        |

**Totals:** 202 automated tests (192 API + 10 shared), plus 10 infrastructure tests. Typecheck and lint are clean.

### What needs you (I didn't do these: they need your accounts or decisions)

1. **AWS (Phase 7):**
   - sign the BAA in AWS Artifact;
   - get an ACM certificate and verify a domain in SES;
   - get an SMS origination number (toll-free verification or 10DLC registration);
   - then `cdk deploy` and the release task.

   Step by step: [deploy.md](deploy.md).

2. **DrChrono sandbox (Phase 8):** register an API app, put the client ID and secret in `.env`, and connect from **Settings**. Run the Phase 5 scenario against it and check the items marked _verify in sandbox_ in decisions.md.
3. **Open business decisions** (decisions.md, "Open"): final product name, the 10DLC vs toll-free sender model, and pricing. If you prefer another EHR than DrChrono, only `apps/api/src/providers/ehr/` changes.
4. **Optional:** enable Windows long paths (`LongPathsEnabled=1`, admin) if you want to install `infra/` natively on this PC. Today it's checked in a Linux container.
5. **Git:** the project isn't a git repository yet, and nothing was committed.

### Things I changed in your local dev data while testing

These are all synthetic. Regenerate everything with `SEED_RESET_MOCK=1 pnpm db:seed`.

- **Cancelled through the test scenarios:**
  - a few Maple appointments (Nov 18 1:00 PM Melissa; Nov 18 1:45 PM; Nov 19 2:00 PM Michael);
  - two 7:00 AM test appointments (Nov 26/27).
- **Waitlist entries** for Michael, Wei and a second Michael, with one filled offer and one open chain offer.
- **Reminders** planned for all upcoming appointments. They go out on schedule while `pnpm dev` runs, but only to Mailpit.
- **Demo visit values** set (New $250, Physical $220, Follow-up $150, Sick $120, Telehealth $90).

## Before anything: start the stack

```bash
docker compose up -d          # Postgres (host port 5433) + Mailpit (SMTP 1025, UI 8025)
pnpm install
pnpm db:migrate               # apply all migrations
pnpm db:seed                  # 2 demo clinics, users, mock EHR data
pnpm dev                      # API :4000, worker, web :3000
```

Open http://localhost:3000.

**Demo logins** (password `slotfill-dev-password`):

| Clinic              | Users                                  |
| ------------------- | -------------------------------------- |
| Maple Family Clinic | `owner@maple.test`, `staff@maple.test` |
| Cedar Pediatrics    | `owner@cedar.test`, `staff@cedar.test` |

The first login asks you to set up MFA: scan the QR code with any authenticator app.

Run the automated checks with `pnpm typecheck && pnpm lint && pnpm test`. Tests use a separate `slotfill_test` database.

---

## Phase 0: Scaffold

**What you get:** the monorepo (`apps/api`, `apps/web`, `packages/shared`), Docker services, and the health check.

**Try it**

- http://localhost:4000/api/v1/health returns `{"status":"ok",…}`.
- Mailpit's inbox is at http://localhost:8025.

## Phase 1: Tenancy, auth, audit

**What you get:**

- Staff login with mandatory TOTP MFA.
- Sessions that time out after 15 minutes idle (12 hours maximum).
- Owner and staff roles.
- An audit log.
- Database-enforced tenant isolation: each clinic sees only its own rows.

**Try it**

1. Sign in as `owner@maple.test`, scan the QR code, enter the code. You land on Maple's dashboard.
2. Sign out, then sign in as `owner@cedar.test`. You only ever see Cedar's data.
3. Look at the audit trail (as the DB owner):
   ```sql
   SELECT action, at FROM audit_log ORDER BY id DESC LIMIT 20;
   ```
   Connect with `docker compose exec postgres psql -U slotfill_owner -d slotfill`.
4. Reset a user's MFA in dev:
   ```sql
   UPDATE users SET mfa_enabled=false, mfa_secret_enc=NULL WHERE email='owner@maple.test';
   ```

## Phase 2: Mock EHR + sync

**What you get:**

- A fake EHR per clinic (`mock_*` tables).
- The worker copies it into SlotFill, then keeps it in sync: every 2 minutes, nightly, and immediately after changes made on `/dev/ehr`.
- An `appointment.changed` event for every new, cancelled or rescheduled appointment.

**Try it**

1. Open **Appointments** to see the synced schedule, grouped by day in the clinic's time zone. You can filter by provider and status.
2. Open **Mock EHR** (`/dev/ehr`, dev only) in another tab. **Cancel**, **Move** or **Create** an appointment there; it shows up on **Appointments** within a few seconds.
3. A change written straight into `mock_appointments` (no webhook) appears within one 2-minute sync.
4. Regenerate stale mock data (appointments are relative to the seed day):
   ```bash
   SEED_RESET_MOCK=1 pnpm db:seed
   ```

## Phase 3: Messaging layer

**What you get:**

- **SMS provider adapter.** The `dev` provider "sends" by emailing Mailpit.
- **Outbound queue.** Each text is a `messages` row plus an `sms.send` job. Consent is re-checked when it's sent.
- **One inbound pipeline** shared by the provider webhook and the simulator. It:
  1. dedupes repeated deliveries;
  2. handles **STOP/START/HELP first**;
  3. routes a reply to the most recent conversation (reminder/offer/invite) from the last 72 h;
  4. otherwise flags the message for staff and sends at most one "didn't understand" reply per day.
- **SMS consent** tracked per clinic and number.

**Try it**

1. Open **Phone sim** (`/dev/phone`, dev only). Pick a patient phone and click **Send test text to this phone**. The text appears in the thread and in Mailpit (http://localhost:8025, subject `SMS to +1555…`).
2. Use the quick-reply buttons as the patient:
   - **HELP** gets the clinic's name and phone.
   - **STOP** opts out and sends one confirmation. **CANCEL** also opts out; it's a carrier keyword, so appointments are cancelled with `2`.
   - **START** opts back in.
3. Type something random. The clinic sends one "didn't understand" reply and the message is flagged.
4. Open **Messages** to see every conversation, with all patients who share a number. **Needs attention** shows the flagged replies; **Mark handled** clears them.
5. Webhook (what a real provider calls):
   ```bash
   curl -X POST localhost:4000/api/v1/webhooks/sms/dev -H 'content-type: application/json' \
     -d '{"from":"+15550009999","to":"+15550100001","body":"HELP","providerMessageId":"demo-1"}'
   ```
   Repeating the same `providerMessageId` returns `"duplicate"`.

**Note:** on Windows, the first texts after a worker restart take about a second each to reach Mailpit (opening a Docker port connection). Later texts reuse pooled connections.

## Phase 4: Reminders

**What you get:**

- Each booked appointment gets reminder texts at the clinic's offsets (default 48 h and 24 h before).
- Before sending, SlotFill re-checks that the appointment is still booked and at the same time, and that the patient has a mobile and hasn't opted out.
- Quiet hours (default 21:00–08:00 clinic time) push a reminder to the end of quiet hours, or skip it if that would be after the appointment.
- Replies:
  - **1** (or YES/Y/CONFIRM) confirms the appointment. This is recorded in SlotFill only; the mock EHR has no confirm API. Remaining reminders stop.
  - **2** cancels it **in the EHR**, then syncs. The normal cancellation event fires, which Phase 5's offer engine picks up. If the EHR call fails, the patient is told the clinic will follow up, and the reply is flagged under **Messages → Needs attention**.
- Each reply goes to the exact appointment that was reminded, even on a shared family number.

**Try it**

1. Appointments synced before Phase 4 existed have no reminders yet. On **Mock EHR**, click **Plan reminders** once; this plans reminders for all upcoming appointments. After that, new or changed appointments are planned automatically.
2. On **Mock EHR**, click **Remind now** on any appointment. In **Phone sim**, find that patient: the reminder is there, and also in Mailpit.
3. Reply **1**: the appointment shows _Confirmed_ on **Appointments**.
4. On another appointment, click **Remind now**, then reply **2**. On **Mock EHR** it turns _Cancelled_ within a second or two, then the same happens on **Appointments**, and the patient gets a cancellation text.
5. Reminders also go out by themselves at their due times while `pnpm dev` runs. They are synthetic texts that only reach Mailpit.

**Where it lives:** `apps/api/src/modules/reminders/service.ts`, `src/lib/quiet-hours.ts`, and the `reminders` table (one row per reminder, with status and skip reason).

## Phase 5: Waitlist + offer engine + booking

**What you get**

- **Waitlist.** Staff add patients on the **Waitlist** page: search by name, optionally pick their current (later) appointment, then choose provider (or _any_), visit type, earliest date and optional preferred days/times. Patients can also join by replying **EARLY** to an invite.
- **Invites.** "Would you like an earlier appointment… Reply EARLY" is sent once per appointment booked ≥ 10 days ahead. It isn't sent for appointments copied in during the first sync with a clinic's EHR, so connecting a clinic doesn't text its whole existing calendar.
- **Offers.** When a booked appointment is cancelled (in the EHR or by a patient replying "2") and the slot is between 2 h and 14 days away, it becomes an **offer**:
  - It is texted to eligible waitlisted patients in batches of 3, longest-waiting first.
  - Another batch goes out every 15 minutes until someone takes it or it expires 2 hours before the slot.
  - Quiet hours delay a batch.
  - Opted-out numbers are never texted.
  - A shared family phone gets only one offer at a time.
- **Booking (first YES wins).** The YES runs a job that:
  - locks the offer;
  - re-checks the slot in the EHR;
  - books the patient;
  - cancels their later appointment;
  - texts them a confirmation, and tells everyone else it was taken.

  The freed later appointment is **offered onward automatically** (the chain). If the EHR fails midway, everything is rolled back, the patient is told the clinic will call, and their reply shows under **Messages → Needs attention**. **NO** declines politely.

- **Offers page.** Open, filled, expired and cancelled offers, with a per-patient timeline (batch, texted, reply, outcome) and **Cancel offer** for open ones.

**Try it**

1. On **Waitlist**, click **Add patient**. Search a name, pick their upcoming appointment (this fills in provider and visit type), then **Add to waitlist**. Repeat for 2–3 patients who have appointments with the same provider later in the next two weeks.
2. On **Mock EHR**, **Cancel** an earlier appointment with that provider, 2 h–14 days away and at least as long as their visit type.
3. Within a few seconds, **Offers** shows an _open_ offer, and **Phone sim** shows the offer text on each waitlisted patient's phone.
4. In **Phone sim**, reply **YES** as the first patient. Then:
   - The offer becomes _filled_.
   - **Mock EHR** shows them booked into the slot and their old appointment _Cancelled_.
   - The others get "was just taken".
   - A **new offer** appears for the freed later slot (the chain).
5. Invite flow: on **Mock EHR**, **Create** an appointment ≥ 10 days out for a patient with a mobile. Their phone gets the invite; reply **EARLY** and they appear on **Waitlist** (badge _via SMS_).

**Where it lives:** `apps/api/src/modules/offers/service.ts` (engine and booking), `modules/waitlist/service.ts` (waitlist, invites, EARLY), and the tables `waitlist_entries`, `slot_offers`, `offer_recipients`, `waitlist_invites`.

## Phase 6: Dashboard + settings

**What you get**

- **Dashboard** (`/`) for the last 7, 30 or 90 days:

  | Tile                   | Meaning                                         |
  | ---------------------- | ----------------------------------------------- |
  | Slots recovered        | Filled offers                                   |
  | Revenue recovered      | Total value of the visits that filled them      |
  | Fill rate              | Filled ÷ (filled + expired)                     |
  | Median time to fill    | Median time from offer to fill                  |
  | Reminder confirmations | Share of reminded appointments confirmed by SMS |

  Also live counts of open offers, active waitlist and items needing attention (click through), plus the latest messages that need attention.

- **Settings** (`/settings`). Owners can edit; staff see read-only values.
  - Clinic phone shown in HELP replies.
  - Reminder offsets (changing them re-plans every upcoming reminder).
  - Offer batch size and batch timeout.
  - Minimum notice and how far ahead slots are offered.
  - Quiet hours.
  - Waitlist invites on/off and their minimum days ahead.
  - **Visit values**, which drive revenue.

**Try it**

1. Run the Phase 5 walkthrough (waitlist → cancel → YES). The dashboard shows 1 slot recovered and its visit's value (demo values: New $250, Physical $220, Follow-up $150, Sick $120, Telehealth $90; `pnpm db:seed` fills them in once visit types have synced).
2. Sign in as `owner@maple.test`, open **Settings**, change a visit value or the reminder offsets, and save. As `staff@maple.test` the same page is read-only.

**Where it lives:** `apps/api/src/modules/dashboard/service.ts` (metrics, raw SQL under RLS), `modules/settings/routes.ts`.

## Phase 7: Hardening + AWS deployment

**What you get**

- **AWS SMS provider** (`SMS_PROVIDER=aws`):
  - sends with AWS End User Messaging SMS (`SendTextMessage`, transactional, from the clinic's number);
  - receives two-way SMS through **Amazon SNS**: every webhook post must come from an allowed topic, with an SNS-hosted signing certificate and a valid RSA signature (SHA1 or SHA256), and subscriptions are confirmed automatically.
- **Email:** SMTP/Mailpit in dev, **Amazon SES** in AWS.
  - **Password reset:** "Forgot password?" on the login page sends a single-use link valid for 30 minutes. Using it signs the user out everywhere, and MFA is still required.
  - **Staff alerts:** owners are emailed when a booking or patient cancellation couldn't be completed in the EHR. The email contains no patient data, only a link to _Needs attention_.
- **Production guards:** the app refuses to start when deployed with the dev SMS provider, a non-https URL or `NODE_ENV` other than production. Dev tools (mock EHR, phone simulator) exist only in development and staging; production returns 404.
- **Readiness** endpoint `/api/v1/health/ready` (checks the database), and security headers on the web app.
- **Docker images** (`docker/api.Dockerfile`, `docker/web.Dockerfile`) and `pnpm --filter @slotfill/api db:release`: an idempotent database bootstrap (roles and the pg-boss schema) followed by migrations.
- **AWS CDK infrastructure** in `infra/`: VPC, encrypted RDS, ECS Fargate, ALB + TLS + WAF, Secrets Manager, KMS, SNS, CloudWatch alarms. See **[deploy.md](deploy.md)** for the full runbook.

**Try it (locally)**

1. **Password reset:** sign out, click **Forgot password?**, enter `staff@maple.test`. Open the email in Mailpit (http://localhost:8025), follow the link, set a new password of 12+ characters, and sign in again (MFA is still asked).
2. **Production images:**
   ```bash
   docker build -f docker/api.Dockerfile -t slotfill-api .
   docker build -f docker/web.Dockerfile -t slotfill-web .
   ```
   Running `slotfill-web` gives 404 on `/dev/*`. Build with `--build-arg NEXT_PUBLIC_DEV_TOOLS=true` for staging.
3. **Infrastructure without AWS:** see _Checking the infrastructure without AWS_ in deploy.md. It synthesizes about 100 CloudFormation resources per stage and runs 8 assertion tests.

**What's left for you** (needs your AWS account): sign the BAA, get the ACM certificate, set up SES and SMS number registration, `cdk deploy`, push the images, run the release task, and run the Phase 5 scenario on staging with your phone. The steps are in deploy.md.

## Phase 8: First real EHR adapter (DrChrono)

**What you get**

- **DrChrono adapter** (`apps/api/src/providers/ehr/drchrono.ts`), the first real EHR, behind the same `EhrAdapter` interface as the mock:
  - Data synced: doctors become providers; appointment profiles become visit types (plus _Appointment_ for unprofiled visits); patients come in with `cell_phone` normalized to E.164; appointments are converted from the clinic's local time.
  - Status mapping: Cancelled/No Show/Complete/Confirmed carry over; _deleted_ counts as cancelled; breaks are never appointments but do block slots.
  - Bookings use the practice's default office and exam room. Cancelling sets status `Cancelled`.
  - The access token refreshes automatically, and tokens are stored **encrypted** (AES-256-GCM).
- **Connect flow:** an owner clicks **Settings → EHR connection → Connect DrChrono**, signs in at DrChrono and approves. SlotFill stores the tokens and starts a full backfill.
- **Webhook** `/api/v1/webhooks/ehr/drchrono`:
  - answers DrChrono's verification GET;
  - accepts deliveries only with the right secret header;
  - turns any appointment event into an immediate sync for the clinic that owns that doctor, so the 2-minute polling becomes a backstop.

**Try it**

- **Without a DrChrono account:** `pnpm test` runs 12 contract tests against a fake DrChrono server built to the docs (OAuth, pagination, token refresh, sync mapping, booking/cancel, webhooks).
- **With a DrChrono developer sandbox:**
  1. In DrChrono, create an API application with redirect URI `<APP_BASE_URL>/api/v1/ehr/drchrono/callback`.
  2. Put its client ID and secret in `.env` as `DRCHRONO_CLIENT_ID` and `DRCHRONO_CLIENT_SECRET`, and restart `pnpm dev`.
  3. Sign in as an owner. **Settings → Connect DrChrono**, approve, and you return to Settings showing _Connected_.
  4. The worker backfills. **Appointments** shows the sandbox schedule; cancel one in DrChrono and the offer engine runs exactly as with the mock.
  5. Webhook (optional; needs a public URL such as a tunnel): in DrChrono, create a webhook to `<public URL>/api/v1/webhooks/ehr/drchrono` with a secret token, set `DRCHRONO_WEBHOOK_SECRET` to the same value, verify it, and subscribe to `APPOINTMENT_CREATE/MODIFY/DELETE`.
- **In AWS:** create a Secrets Manager secret `{"clientId","clientSecret","webhookSecret"}` and deploy with `-c drchronoSecretArn=<arn>`.

**Plan "done when"** (the Phase 5 scenario against the EHR sandbox) needs a sandbox account, so it's for you to run with the steps above. Things to confirm there are listed in decisions.md (Phase 8 rows marked _verify in sandbox_).

## Phase 9: Twilio adapter + per-clinic SMS provider (optional)

**What you get**

- **Twilio provider** (`apps/api/src/providers/sms/twilio.ts`):
  - sends through the Messages API (Basic auth) and returns the message SID;
  - accepts inbound texts as form-encoded webhooks at `/api/v1/webhooks/sms/twilio`, checked with **X-Twilio-Signature** (HMAC-SHA1; verified against Twilio's official example);
  - answers the webhook with empty TwiML.
- **Several providers at once:** the deployment default (`SMS_PROVIDER`) plus any other configured provider.
  - Each clinic can pick one under **Settings → SMS provider**, owner only. The selector appears when more than one is configured.
  - Every message records the provider it was queued for. If that provider isn't available, delivery **fails with `provider_unavailable`** instead of silently switching to a different vendor.
- **BAA guard:** a deployed server (staging/production) **refuses to start** with Twilio credentials unless `TWILIO_BAA_SIGNED=true`. The CDK stack refuses `twilioSecretArn` unless `twilioBaaSigned=true`.

**Try it**

- `pnpm test` runs 8 Twilio and per-clinic tests (signature vector, send, signed inbound, routing, settings, guard).
- **Locally with a Twilio test account** (synthetic data only):
  1. Set `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` in `.env`, and restart.
  2. **Settings** now offers _dev_ and _twilio_.
  3. For inbound, point the Twilio number's messaging webhook at `<public URL>/api/v1/webhooks/sms/twilio`. `APP_BASE_URL` must be that public URL, because the signature covers it.
- **In AWS:** only after signing Twilio's BAA. Create a secret `{"accountSid","authToken"}` and deploy with `-c twilioSecretArn=<arn> -c twilioBaaSigned=true`.
