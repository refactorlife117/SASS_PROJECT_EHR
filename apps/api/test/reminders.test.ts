import { addDays, formatDateInZone, toDateKey, zonedTimeToUtc } from '@slotfill/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockAppointment, createMockEhr } from './ehr-fixtures';
import { admin, auditActions, createTenant, createTestContext, resetDb } from './helpers';

const ctx = await createTestContext();
const { services } = ctx;
const NY = 'America/New_York';
const CLINIC = '+15550100001';
const PAT_MOBILE = '+15550000001'; // createMockEhr's patient
const HOUR = 3_600_000;

afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDb();
  ctx.mailer.sent.length = 0;
  ctx.clock.set(new Date());
});

/** Tenant-local time `days` days from today, e.g. at(3, '10:00'). */
const at = (days: number, time: string) =>
  zonedTimeToUtc(addDays(toDateKey(new Date(), NY), days), time, NY);

async function setup(options: { localTime?: string; days?: number; hoursBefore?: number[] } = {}) {
  const tenant = await createTenant('Maple Family Clinic', {
    smsNumber: CLINIC,
    contactPhone: '(555) 010-0001',
  });
  if (options.hoursBefore) {
    await admin.tenantSettings.update({
      where: { tenantId: tenant.id },
      data: { reminderHoursBefore: options.hoursBefore },
    });
  }
  const { provider, patient } = await createMockEhr(tenant.id);
  const startsAt = at(options.days ?? 3, options.localTime ?? '10:00');
  const mockAppt = await createMockAppointment({
    tenantId: tenant.id,
    patientId: patient.id,
    providerId: provider.id,
    startsAt,
  });
  await services.sync.sync(tenant.id, 'full');
  await ctx.runJobs(); // appointment.changed -> plan reminders
  const appt = await admin.appointment.findFirstOrThrow({
    where: { ehrAppointmentId: mockAppt.id },
  });
  return { tenant, provider, patient, mockAppt, appt, startsAt };
}

const reminders = (appointmentId: string) =>
  admin.reminder.findMany({
    where: { appointmentId },
    orderBy: [{ hoursBefore: 'desc' }, { createdAt: 'asc' }],
  });
const texts = (to = PAT_MOBILE) =>
  admin.message.findMany({
    where: { mobileE164: to, direction: 'outbound' },
    orderBy: { createdAt: 'asc' },
  });
const reply = (body: string, from = PAT_MOBILE) =>
  services.messaging.handleInbound(
    { providerMessageId: crypto.randomUUID(), from, to: CLINIC, body },
    'dev',
  );
/** Jump the fake clock and let the "worker" run everything now due. */
const travelTo = async (instant: Date) => {
  ctx.clock.set(instant);
  await ctx.runJobs();
};

describe('planning', () => {
  it('plans one reminder per configured offset (48 h and 24 h by default) and sends nothing early', async () => {
    const { appt, startsAt } = await setup();
    const planned = await reminders(appt.id);
    expect(planned.map((r) => [r.hoursBefore, r.status, r.sendAfter.toISOString()])).toEqual([
      [48, 'scheduled', new Date(startsAt.getTime() - 48 * HOUR).toISOString()],
      [24, 'scheduled', new Date(startsAt.getTime() - 24 * HOUR).toISOString()],
    ]);
    expect(await texts()).toEqual([]);
  });

  it('skips offsets that are already in the past (booked 30 h ahead -> only the 24 h reminder)', async () => {
    ctx.clock.set(new Date(at(3, '10:00').getTime() - 30 * HOUR));
    const { appt } = await setup();
    expect((await reminders(appt.id)).map((r) => r.hoursBefore)).toEqual([24]);
  });

  it('is idempotent: replaying the appointment event does not duplicate reminders', async () => {
    const { appt } = await setup();
    await services.reminders.onAppointmentChanged({
      tenantId: appt.tenantId,
      appointmentId: appt.id,
      change: 'created',
      previousStatus: null,
      status: 'booked',
    });
    expect(await reminders(appt.id)).toHaveLength(2);
  });
});

describe('sending', () => {
  it('sends each reminder when due, with only first name, clinic, provider and date/time', async () => {
    const { appt, startsAt } = await setup();
    await travelTo(new Date(startsAt.getTime() - 48 * HOUR + 60_000));

    const [first] = await texts();
    expect(first?.contextType).toBe('reminder');
    expect(first?.status).toBe('sent');
    expect(first?.body).toBe(
      `Hi Pat, reminder: Maple Family Clinic with Dr. Test Provider on ${formatDateInZone(startsAt, NY)} at 10:00 AM. Reply 1 to confirm, 2 to cancel. Reply STOP to opt out.`,
    );
    expect(first?.body).not.toContain('Follow-up'); // never the visit type
    expect(ctx.mailer.sent).toHaveLength(1);

    await travelTo(new Date(startsAt.getTime() - 24 * HOUR + 60_000));
    expect(await texts()).toHaveLength(2);
    expect((await reminders(appt.id)).map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('defers a reminder that falls in quiet hours to when they end', async () => {
    // 22:30 appointment -> 24 h reminder due 22:30 the night before (quiet 21:00–08:00).
    const { appt, startsAt } = await setup({ localTime: '22:30', hoursBefore: [24] });
    await travelTo(new Date(startsAt.getTime() - 24 * HOUR + 60_000));
    expect(await texts()).toEqual([]);
    const [deferred] = await reminders(appt.id);
    expect(deferred?.sendAfter).toEqual(at(3, '08:00'));

    await travelTo(at(3, '08:00'));
    expect(await texts()).toHaveLength(1);
  });

  it('skips a quiet-hours reminder when quiet hours end after the appointment', async () => {
    // 07:30 appointment with a 1 h reminder at 06:30: quiet hours end at 08:00, too late.
    const { appt, startsAt } = await setup({ localTime: '07:30', hoursBefore: [1] });
    await travelTo(new Date(startsAt.getTime() - HOUR + 60_000));
    expect(await texts()).toEqual([]);
    expect((await reminders(appt.id))[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'quiet_hours',
    });
  });

  it('never texts an opted-out number', async () => {
    const { tenant, appt, startsAt } = await setup();
    await admin.smsConsent.create({
      data: { tenantId: tenant.id, mobileE164: PAT_MOBILE, status: 'opted_out', source: 'test' },
    });
    await travelTo(new Date(startsAt.getTime() - 24 * HOUR + 60_000));
    expect(await texts()).toEqual([]);
    expect((await reminders(appt.id)).map((r) => r.skipReason)).toEqual(['opted_out', 'opted_out']);
  });

  it('skips patients without a mobile number', async () => {
    const { appt, patient, startsAt } = await setup();
    await admin.patient.updateMany({
      where: { ehrPatientId: patient.id },
      data: { mobileE164: null },
    });
    await travelTo(new Date(startsAt.getTime() - 24 * HOUR + 60_000));
    expect((await reminders(appt.id))[0]?.skipReason).toBe('no_mobile');
  });
});

describe('EHR changes', () => {
  it('cancels pending reminders when the appointment is cancelled in the EHR', async () => {
    const { tenant, appt, mockAppt, startsAt } = await setup();
    await admin.mockAppointment.update({
      where: { id: mockAppt.id },
      data: { status: 'cancelled' },
    });
    await services.sync.sync(tenant.id, 'incremental');
    await ctx.runJobs();
    expect((await reminders(appt.id)).map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
    await travelTo(new Date(startsAt.getTime() - 24 * HOUR + 60_000));
    expect(await texts()).toEqual([]);
  });

  it('re-plans reminders for the new time when the appointment is rescheduled', async () => {
    const { tenant, appt, mockAppt } = await setup();
    const newTime = at(5, '14:00');
    await admin.mockAppointment.update({ where: { id: mockAppt.id }, data: { startsAt: newTime } });
    await services.sync.sync(tenant.id, 'incremental');
    await ctx.runJobs();
    const all = await reminders(appt.id);
    expect(all.filter((r) => r.status === 'cancelled')).toHaveLength(2);
    expect(all.filter((r) => r.status === 'scheduled').map((r) => r.appointmentStartsAt)).toEqual([
      newTime,
      newTime,
    ]);
  });
});

describe('replies', () => {
  async function remindedAppointment() {
    const s = await setup();
    await travelTo(new Date(s.startsAt.getTime() - 48 * HOUR + 60_000));
    return s;
  }

  it('"1" confirms the appointment (locally), thanks the patient and stops further reminders', async () => {
    const { tenant, appt } = await remindedAppointment();
    expect(await reply('1')).toBe('routed');
    await ctx.runJobs();

    expect((await admin.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe(
      'confirmed',
    );
    expect((await reminders(appt.id)).map((r) => r.status)).toEqual(['sent', 'cancelled']);
    expect((await texts()).at(-1)?.body).toContain("Thanks Pat, you're confirmed");
    expect(await auditActions(tenant.id)).toContain('appointment.confirmed_by_sms');
  });

  it('"2" cancels the appointment in the mock EHR, syncs it back, and tells the patient', async () => {
    const { tenant, appt, mockAppt } = await remindedAppointment();
    expect(await reply('2')).toBe('routed');
    await ctx.runJobs(); // cancel-by-patient -> EHR cancel -> ehr.sync -> appointment.changed

    expect(
      (await admin.mockAppointment.findUniqueOrThrow({ where: { id: mockAppt.id } })).status,
    ).toBe('cancelled');
    expect((await admin.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe(
      'cancelled',
    );
    expect((await texts()).at(-1)?.body).toContain('is cancelled');
    expect(await auditActions(tenant.id)).toEqual(
      expect.arrayContaining([
        'appointment.cancel_requested_by_sms',
        'appointment.cancelled_in_ehr',
      ]),
    );
  });

  it('if the EHR cancel fails, tells the patient the clinic will follow up and flags it for staff', async () => {
    const { mockAppt } = await remindedAppointment();
    await admin.mockAppointment.delete({ where: { id: mockAppt.id } }); // EHR call will fail
    await reply('2');
    await ctx.runJobs();
    expect((await texts()).at(-1)?.body).toContain("couldn't cancel");
    const inbound = await admin.message.findFirstOrThrow({
      where: { direction: 'inbound', body: '2' },
    });
    expect(inbound.needsAttention).toBe(true);
  });

  it('answers a reply after the appointment has started with "call the clinic"', async () => {
    const { startsAt } = await remindedAppointment();
    ctx.clock.set(new Date(startsAt.getTime() + 60_000));
    await reply('2');
    expect(
      (
        await admin.message.findMany({ where: { direction: 'outbound', contextType: 'system' } })
      ).at(-1)?.body,
    ).toContain("can't be changed by text");
  });

  it('routes a reply on a shared family number to the most recently reminded appointment only', async () => {
    const { tenant, provider } = await setup({ days: 3 });
    // A second patient (the child) with the same mobile, appointment one hour later.
    const child = await admin.mockPatient.create({
      data: { tenantId: tenant.id, firstName: 'Leo', lastName: 'Example', mobileE164: PAT_MOBILE },
    });
    const childMock = await createMockAppointment({
      tenantId: tenant.id,
      patientId: child.id,
      providerId: provider.id,
      startsAt: at(3, '11:00'),
    });
    await services.sync.sync(tenant.id, 'incremental');
    await ctx.runJobs();
    const parentAppt = await admin.appointment.findFirstOrThrow({
      where: { tenantId: tenant.id, NOT: { ehrAppointmentId: childMock.id } },
    });
    const childAppt = await admin.appointment.findFirstOrThrow({
      where: { ehrAppointmentId: childMock.id },
    });

    // Parent's 48 h reminder goes out at 10:00, the child's at 11:00.
    await travelTo(new Date(at(3, '11:00').getTime() - 48 * HOUR + 60_000));
    expect((await texts()).map((m) => m.body.slice(0, 6))).toEqual(['Hi Pat', 'Hi Leo']);

    await reply('1');
    expect(
      (await admin.appointment.findUniqueOrThrow({ where: { id: childAppt.id } })).status,
    ).toBe('confirmed');
    expect(
      (await admin.appointment.findUniqueOrThrow({ where: { id: parentAppt.id } })).status,
    ).toBe('booked');
  });
});
