/* eslint-disable no-console -- CLI script output */
// Dev seed: 2 demo tenants with users, a mock EHR connection, and mock EHR data. SYNTHETIC ONLY.
// Runs as the OWNER role (MIGRATE_DATABASE_URL) because it provisions tenants, which the app role
// cannot create. Idempotent: safe to re-run. Mock EHR data is generated only when a tenant has
// none, unless SEED_RESET_MOCK=1 (which also clears SlotFill's synced copy so it re-backfills).
import { PrismaPg } from '@prisma/adapter-pg';
import { toDateKey } from '@slotfill/shared';
import { PrismaClient, type UserRole } from '../src/generated/prisma/client';
import { hashPassword } from '../src/modules/auth/passwords';
import { generateMockEhr } from './mock-ehr-data';

const DEV_PASSWORD = process.env.SEED_USER_PASSWORD ?? 'slotfill-dev-password';
const RESET_MOCK = process.env.SEED_RESET_MOCK === '1';
/** Illustrative values for the mock EHR's visit-type codes (USD cents). */
const DEMO_VISIT_VALUES_CENTS: Record<string, number> = {
  NEW: 25_000,
  PHYSICAL: 22_000,
  FOLLOWUP: 15_000,
  SICK: 12_000,
  TELE: 9_000,
};

const TENANTS: {
  id: string;
  name: string;
  timezone: string;
  smsNumber: string;
  contactPhone: string;
  seed: number;
  users: { email: string; role: UserRole }[];
}[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Maple Family Clinic',
    timezone: 'America/New_York',
    smsNumber: '+15550100001',
    contactPhone: '(555) 010-0001',
    seed: 1001,
    users: [
      { email: 'owner@maple.test', role: 'owner' },
      { email: 'staff@maple.test', role: 'staff' },
    ],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Cedar Pediatrics',
    timezone: 'America/Chicago',
    smsNumber: '+15550100002',
    contactPhone: '(555) 010-0002',
    seed: 2002,
    users: [
      { email: 'owner@cedar.test', role: 'owner' },
      { email: 'staff@cedar.test', role: 'staff' },
    ],
  },
];

type Db = PrismaClient;

async function seedMockEhr(prisma: Db, tenant: (typeof TENANTS)[number]): Promise<string> {
  const tenantId = tenant.id;
  if (RESET_MOCK) {
    await prisma.$transaction([
      prisma.mockAppointment.deleteMany({ where: { tenantId } }),
      prisma.mockPatient.deleteMany({ where: { tenantId } }),
      prisma.mockVisitType.deleteMany({ where: { tenantId } }),
      prisma.mockProvider.deleteMany({ where: { tenantId } }),
      prisma.appointment.deleteMany({ where: { tenantId } }),
      prisma.patient.deleteMany({ where: { tenantId } }),
      prisma.visitType.deleteMany({ where: { tenantId } }),
      prisma.provider.deleteMany({ where: { tenantId } }),
      prisma.ehrConnection.updateMany({
        where: { tenantId },
        data: { lastSyncedAt: null, lastFullSyncAt: null, lastError: null },
      }),
    ]);
  } else if ((await prisma.mockProvider.count({ where: { tenantId } })) > 0) {
    return 'mock EHR data already present (SEED_RESET_MOCK=1 to regenerate)';
  }

  const now = new Date();
  const data = generateMockEhr({
    tenantId,
    timezone: tenant.timezone,
    today: toDateKey(now, tenant.timezone),
    seed: tenant.seed,
    now,
  });
  await prisma.$transaction([
    prisma.mockProvider.createMany({ data: data.providers }),
    prisma.mockVisitType.createMany({ data: data.visitTypes }),
    prisma.mockPatient.createMany({ data: data.patients }),
    prisma.mockAppointment.createMany({ data: data.appointments }),
  ]);
  return `${String(data.providers.length)} providers, ${String(data.patients.length)} patients, ${String(data.appointments.length)} appointments`;
}

async function main(): Promise<void> {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) throw new Error('MIGRATE_DATABASE_URL is required');
  // Staging runs production builds (NODE_ENV=production) with synthetic data; only real production
  // (APP_ENV=production) must never get demo tenants/users.
  if (process.env.APP_ENV === 'production') {
    throw new Error('Refusing to seed demo data in production');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const passwordHash = await hashPassword(DEV_PASSWORD);
  const summaries: string[] = [];

  try {
    for (const tenant of TENANTS) {
      const fields = {
        name: tenant.name,
        timezone: tenant.timezone,
        smsNumber: tenant.smsNumber,
        contactPhone: tenant.contactPhone,
      };
      await prisma.tenant.upsert({
        where: { id: tenant.id },
        create: { id: tenant.id, ...fields },
        update: fields,
      });
      await prisma.tenantSettings.upsert({
        where: { tenantId: tenant.id },
        create: { tenantId: tenant.id },
        update: {},
      });
      for (const user of tenant.users) {
        await prisma.user.upsert({
          where: { email: user.email },
          create: { tenantId: tenant.id, email: user.email, role: user.role, passwordHash },
          // Re-seeding resets the password but keeps MFA enrollment.
          update: { passwordHash, role: user.role },
        });
      }
      // The worker backfills new (never-synced) connections on its next run.
      await prisma.ehrConnection.upsert({
        where: { tenantId: tenant.id },
        create: { tenantId: tenant.id, ehrType: 'mock', status: 'active' },
        update: {},
      });
      summaries.push(
        `  ${tenant.name}: ${tenant.users.map((u) => `${u.email} (${u.role})`).join(', ')}\n` +
          `    mock EHR: ${await seedMockEhr(prisma, tenant)}`,
      );
      // Demo visit values (drive "revenue recovered"). Visit types appear once the worker has
      // synced; only unset (0) values are filled, so values edited in Settings are kept.
      for (const [code, cents] of Object.entries(DEMO_VISIT_VALUES_CENTS)) {
        await prisma.visitType.updateMany({
          where: { tenantId: tenant.id, code, estimatedValueCents: 0 },
          data: { estimatedValueCents: cents },
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log('Seeded demo tenants (synthetic data):');
  for (const line of summaries) console.log(line);
  console.log(`  Password for all demo users: ${DEV_PASSWORD}`);
  console.log('  First login enrolls MFA (scan the QR code with an authenticator app).');
  console.log('  Start the worker (pnpm dev) to backfill the mock EHR into SlotFill.');
}

await main();
