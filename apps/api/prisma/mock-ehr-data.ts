// Deterministic SYNTHETIC data for the mock EHR. Names are generic; phone numbers use the
// unassigned 555 area code (+1555xxxxxxx). Never put real patient data here.
import { randomUUID } from 'node:crypto';
import { addDays, weekdayOf, zonedTimeToUtc } from '@slotfill/shared';
import type { AppointmentStatus } from '../src/generated/prisma/client';

const FIRST_NAMES = [
  'James',
  'Mary',
  'Robert',
  'Patricia',
  'John',
  'Jennifer',
  'Michael',
  'Linda',
  'David',
  'Elizabeth',
  'William',
  'Barbara',
  'Richard',
  'Susan',
  'Joseph',
  'Jessica',
  'Thomas',
  'Sarah',
  'Carlos',
  'Karen',
  'Daniel',
  'Lisa',
  'Matthew',
  'Nancy',
  'Anthony',
  'Sandra',
  'Mark',
  'Ashley',
  'Luis',
  'Emily',
  'Kevin',
  'Michelle',
  'Brian',
  'Amanda',
  'Wei',
  'Melissa',
  'Aiden',
  'Priya',
  'Omar',
  'Grace',
];
const LAST_NAMES = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
  'Lee',
  'Perez',
  'Thompson',
  'White',
  'Harris',
  'Sanchez',
  'Clark',
  'Ramirez',
  'Lewis',
  'Robinson',
  'Walker',
  'Young',
  'Allen',
  'King',
  'Wright',
  'Scott',
  'Nguyen',
  'Hill',
  'Flores',
  'Patel',
];
const PROVIDER_NAMES = [
  'Dr. Alicia Chen',
  'Dr. Marcus Reed',
  'Dr. Sofia Alvarez',
  'Dr. Ethan Brooks',
];
const VISIT_TYPES = [
  { code: 'NEW', name: 'New patient visit', durationMin: 60, weight: 1 },
  { code: 'FOLLOWUP', name: 'Follow-up', durationMin: 30, weight: 4 },
  { code: 'PHYSICAL', name: 'Annual physical', durationMin: 45, weight: 2 },
  { code: 'SICK', name: 'Sick visit', durationMin: 20, weight: 2 },
  { code: 'TELE', name: 'Telehealth check-in', durationMin: 20, weight: 1 },
];

const PATIENT_COUNT = 200;
const DAYS = 30;
const DAY_START = 9 * 60;
const LUNCH = [12 * 60, 13 * 60] as const;
const DAY_END = 17 * 60;

/** mulberry32: tiny deterministic PRNG so every seed run produces the same schedule shape. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export interface MockEhrData {
  providers: { id: string; tenantId: string; displayName: string }[];
  visitTypes: { tenantId: string; code: string; name: string; durationMin: number }[];
  patients: {
    id: string;
    tenantId: string;
    firstName: string;
    lastName: string;
    mobileE164: string | null;
  }[];
  appointments: {
    tenantId: string;
    patientId: string;
    providerId: string;
    visitTypeCode: string;
    startsAt: Date;
    durationMin: number;
    status: AppointmentStatus;
  }[];
}

export function generateMockEhr(input: {
  tenantId: string;
  timezone: string;
  /** Tenant-local "YYYY-MM-DD" of the first day. */
  today: string;
  seed: number;
  now: Date;
}): MockEhrData {
  const rand = prng(input.seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const { tenantId } = input;

  const providers = PROVIDER_NAMES.map((displayName) => ({
    id: randomUUID(),
    tenantId,
    displayName,
  }));
  const visitTypes = VISIT_TYPES.map(({ code, name, durationMin }) => ({
    tenantId,
    code,
    name,
    durationMin,
  }));

  const patients: MockEhrData['patients'] = [];
  for (let i = 0; i < PATIENT_COUNT; i++) {
    const previous = patients[patients.length - 1];
    const roll = rand();
    // ~6% share the previous patient's number and surname (a parent booking for children), ~3% have none.
    const family = roll < 0.06 && previous?.mobileE164 ? previous : null;
    patients.push({
      id: randomUUID(),
      tenantId,
      firstName: pick(FIRST_NAMES),
      lastName: family ? family.lastName : pick(LAST_NAMES),
      mobileE164: family
        ? family.mobileE164
        : roll < 0.09
          ? null
          : `+1555${String(Math.floor(rand() * 10_000_000)).padStart(7, '0')}`,
    });
  }

  const weightedVisitTypes = VISIT_TYPES.flatMap((v) => Array<typeof v>(v.weight).fill(v));
  const appointments: MockEhrData['appointments'] = [];
  for (let day = 0; day < DAYS; day++) {
    const dateKey = addDays(input.today, day);
    const weekday = weekdayOf(dateKey);
    if (weekday === 0 || weekday === 6) continue;

    for (const provider of providers) {
      let minute = DAY_START;
      while (minute < DAY_END) {
        if (minute >= LUNCH[0] && minute < LUNCH[1]) {
          minute = LUNCH[1];
          continue;
        }
        const visitType = pick(weightedVisitTypes);
        const end = minute + visitType.durationMin;
        const crossesLunch = minute < LUNCH[0] && end > LUNCH[0];
        if (end > DAY_END || crossesLunch || rand() > 0.72) {
          minute += 15; // leave an open gap
          continue;
        }
        const startsAt = zonedTimeToUtc(dateKey, hhmm(minute), input.timezone);
        const statusRoll = rand();
        const status: AppointmentStatus =
          startsAt < input.now
            ? 'completed'
            : statusRoll < 0.05
              ? 'cancelled'
              : statusRoll < 0.15
                ? 'confirmed'
                : 'booked';
        appointments.push({
          tenantId,
          patientId: pick(patients).id,
          providerId: provider.id,
          visitTypeCode: visitType.code,
          startsAt,
          durationMin: visitType.durationMin,
          status,
        });
        minute = end;
      }
    }
  }

  return { providers, visitTypes, patients, appointments };
}
