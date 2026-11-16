// Small, explicit mock-EHR fixtures for tests (synthetic data). Written with the owner `admin`
// client, i.e. "directly in the external EHR", not through SlotFill.
import { admin } from './helpers';

export const inDays = (days: number, hourUtc = 15): Date => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};

export async function createMockEhr(tenantId: string, options: { connect?: boolean } = {}) {
  const provider = await admin.mockProvider.create({
    data: { tenantId, displayName: 'Dr. Test Provider' },
  });
  await admin.mockVisitType.create({
    data: { tenantId, code: 'FOLLOWUP', name: 'Follow-up', durationMin: 30 },
  });
  const patient = await admin.mockPatient.create({
    data: { tenantId, firstName: 'Pat', lastName: 'Example', mobileE164: '+15550000001' },
  });
  if (options.connect ?? true) {
    await admin.ehrConnection.create({ data: { tenantId, ehrType: 'mock' } });
  }
  return { provider, patient };
}

export function createMockAppointment(input: {
  tenantId: string;
  patientId: string;
  providerId: string;
  startsAt: Date;
  status?: 'booked' | 'confirmed' | 'cancelled';
}) {
  return admin.mockAppointment.create({
    data: {
      tenantId: input.tenantId,
      patientId: input.patientId,
      providerId: input.providerId,
      visitTypeCode: 'FOLLOWUP',
      startsAt: input.startsAt,
      durationMin: 30,
      status: input.status ?? 'booked',
    },
  });
}
