# Architecture

```
Clinic EHR  ⇄  EHR adapter  ⇄  API + Worker  ⇄  SMS adapter  ⇄  Patients' phones
                                    │
                                Postgres
                                    │
                         Next.js staff dashboard
```

The API and the worker share one codebase and run as two processes (`server.ts`, `worker.ts`).

## Repository structure

```
slotfill/
├── apps/
│   ├── api/                 # Express HTTP server
│   │   ├── prisma/          # schema.prisma, migrations (incl. custom RLS SQL), seed
│   │   └── src/
│   │       ├── modules/     # auth, tenants, appointments, waitlist, offers, messaging, ehr, dashboard, dev
│   │       ├── db/          # Prisma client, tenant-scoped tx helper
│   │       ├── providers/
│   │       │   ├── sms/     # dev, aws, twilio adapters
│   │       │   └── ehr/     # mock, (later) athena/elation/drchrono
│   │       ├── jobs/        # pg-boss job definitions
│   │       ├── lib/         # crypto, logger, time, errors
│   │       ├── server.ts    # HTTP entry
│   │       └── worker.ts    # job worker entry (separate process)
│   └── web/                 # Next.js app
├── packages/
│   └── shared/              # zod schemas, shared types, enums
├── docker-compose.yml       # postgres, mailpit
├── .env.example
└── docs/
```

## Background jobs (pg-boss)

- **Queue definitions:** `apps/api/src/jobs/queues.ts` has each queue's name, zod payload schema (IDs only, never PHI) and policy. `createJobQueue(boss).send(name, data, options, tx?)` validates the payload.
  - **Pass `tx` whenever the job is caused by a data change in that transaction.** The job then commits or rolls back with it.
- **Handlers:** `apps/api/src/jobs/handlers.ts`. `registerJobHandlers` sets per-queue batch size and concurrency. Each job in a batch is settled on its own (`perJobResults`), so one failure doesn't fail its neighbors; a failed job stores only the error class name.
- **Who runs what:** the worker (`createBoss(url, 'worker')`) runs handlers, cron and maintenance. The API runs a producer-only instance (`'producer'`: no cron, no supervision).

## SMS provider adapter

```ts
interface SmsProvider {
  send(input: { from: string; to: string; body: string }): Promise<{ providerMessageId: string }>;
  verifyInbound(req: Request): boolean;
  parseInbound(req: Request): { providerMessageId: string; from: string; to: string; body: string };
}
```

Selected by `SMS_PROVIDER=dev|aws|twilio`.

- **`dev`** (build now): `send` stores the message and emails it via Nodemailer to Mailpit (subject: `SMS to +1555…`; view at http://localhost:8025). The **phone simulator** (`/dev/phone`, dev only) lists conversations per number and lets you type a reply. A reply calls `POST /api/dev/sms/inbound`, which runs the **same inbound handler** as the real webhook.
- **`aws`** (Phase 7): AWS End User Messaging SMS for sending. Inbound goes two-way SMS → SNS topic → HTTPS endpoint.
- **`twilio`** (Phase 9, only once a Twilio BAA is in place): sends via the Twilio API. Inbound arrives on a Twilio webhook with signature verification.

Each tenant has its own sending number (`tenants.sms_number`). Inbound messages are routed to a tenant by the `to` number.

## EHR adapter

```ts
interface EhrAdapter {
  listAppointments(range: { from: Date; to: Date }): Promise<EhrAppointment[]>;
  listChangedAppointments(since: Date): Promise<EhrAppointment[]>;
  getPatient(ehrPatientId: string): Promise<EhrPatient>;
  listProviders(): Promise<EhrProvider[]>;
  isSlotOpen(input: {
    ehrProviderId: string;
    startsAt: Date;
    durationMin: number;
  }): Promise<boolean>;
  bookAppointment(input: {
    ehrPatientId: string;
    ehrProviderId: string;
    startsAt: Date;
    durationMin: number;
    visitType: string;
  }): Promise<{ ehrAppointmentId: string }>;
  cancelAppointment(ehrAppointmentId: string, reason: string): Promise<void>;
}
```

- **`mock`** (built, Phase 2): `apps/api/src/providers/ehr/mock.ts` (`MockEhr`). It's a fake EHR stored in its own `mock_`-prefixed tables (tenant-scoped, under RLS). The seed generates synthetic providers, visit types, ~200 patients and 30 days of appointments per tenant. The dev-only page `/dev/ehr` can create, move and cancel appointments.
  - Booking takes a per-provider advisory lock, so concurrent bookings can't double-book a slot.
  - Adapters are created with `createEhrAdapterFactory({ db })`, a `Record<EhrType, …>`, so adding an EHR type fails to compile until it has an adapter.
- **Implemented interface vs. the sketch above:**
  - Adds `listVisitTypes()`, which backfill needs.
  - `getPatient` returns `null` for an unknown id.
  - `bookAppointment` throws `EhrSlotUnavailableError` when the slot was taken in the meantime.
- **Real adapter** (Phase 8): the EHR is chosen later (athenahealth, Elation or DrChrono). It uses webhooks or change subscriptions where available, and polling otherwise.
