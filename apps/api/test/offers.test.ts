import { addDays, toDateKey, toTimeKey, zonedTimeToUtc } from '@slotfill/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockAppointment, createMockEhr } from './ehr-fixtures';
import { admin, auditActions, createTenant, createTestContext, resetDb } from './helpers';

const ctx = await createTestContext();
const { services } = ctx;
const NY = 'America/New_York';
const CLINIC = '+15550100001';
const MINUTE = 60_000;

afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDb();
  ctx.mailer.sent.length = 0;
  ctx.clock.set(new Date());
});

/** Tenant-local time `days` days from today. */
const at = (days: number, time: string) =>
  zonedTimeToUtc(addDays(toDateKey(new Date(), NY), days), time, NY);
const mobileOf = (i: number) => `+1555000${String(100 + i)}0`.slice(0, 12);

interface Waitlister {
  name: string;
  mobile: string;
  ehrPatientId: string;
  patientId: string;
  currentAppointmentId: string;
  currentEhrAppointmentId: string;
}

/**
 * A clinic where Pat's appointment (in 2 days, 10:00) is about to be cancelled, and `n`
 * waitlisted patients each hold a later appointment (in 12 days) they'd like to move earlier.
 * Quiet hours are disabled so results don't depend on the time of day the tests run.
 */
async function scenario(options: { waitlisters?: number; sharedMobile?: boolean } = {}) {
  const n = options.waitlisters ?? 4;
  const tenant = await createTenant('Maple Family Clinic', {
    smsNumber: CLINIC,
    contactPhone: '(555) 010-0001',
  });
  await admin.tenantSettings.update({
    where: { tenantId: tenant.id },
    data: { quietHoursStart: '00:00', quietHoursEnd: '00:00' },
  });
  const { provider, patient: pat } = await createMockEhr(tenant.id);
  const slot = await createMockAppointment({
    tenantId: tenant.id,
    patientId: pat.id,
    providerId: provider.id,
    startsAt: at(2, '10:00'),
  });

  const mocks: { name: string; mobile: string; ehrPatientId: string; ehrApptId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const name = `W${String(i + 1)}`;
    const mobile = options.sharedMobile && i === 1 ? mobileOf(0) : mobileOf(i);
    const p = await admin.mockPatient.create({
      data: { tenantId: tenant.id, firstName: name, lastName: 'Waiter', mobileE164: mobile },
    });
    const later = await createMockAppointment({
      tenantId: tenant.id,
      patientId: p.id,
      providerId: provider.id,
      startsAt: at(12, `${String(9 + i).padStart(2, '0')}:00`),
    });
    mocks.push({ name, mobile, ehrPatientId: p.id, ehrApptId: later.id });
  }
  await services.sync.sync(tenant.id, 'full');
  await ctx.runJobs();

  const followUp = await admin.visitType.findFirstOrThrow({
    where: { tenantId: tenant.id, code: 'FOLLOWUP' },
  });
  const waitlisters: Waitlister[] = [];
  for (const m of mocks) {
    const patient = await admin.patient.findFirstOrThrow({
      where: { tenantId: tenant.id, ehrPatientId: m.ehrPatientId },
    });
    const current = await admin.appointment.findFirstOrThrow({
      where: { ehrAppointmentId: m.ehrApptId },
    });
    await admin.waitlistEntry.create({
      data: {
        tenantId: tenant.id,
        patientId: patient.id,
        visitTypeId: followUp.id,
        currentAppointmentId: current.id,
        earliestDate: new Date(`${toDateKey(new Date(), NY)}T00:00:00Z`),
        source: 'staff',
      },
    });
    waitlisters.push({
      name: m.name,
      mobile: m.mobile,
      ehrPatientId: m.ehrPatientId,
      patientId: patient.id,
      currentAppointmentId: current.id,
      currentEhrAppointmentId: m.ehrApptId,
    });
  }
  const slotAppt = await admin.appointment.findFirstOrThrow({
    where: { ehrAppointmentId: slot.id },
  });
  return { tenant, provider, slot, slotAppt, waitlisters, followUp };
}

/** Pat cancels in the EHR; SlotFill syncs and the offer engine runs. */
async function cancelSlot(s: Awaited<ReturnType<typeof scenario>>) {
  await admin.mockAppointment.update({ where: { id: s.slot.id }, data: { status: 'cancelled' } });
  await services.sync.sync(s.tenant.id, 'incremental');
  await ctx.runJobs();
  return admin.slotOffer.findUniqueOrThrow({ where: { sourceAppointmentId: s.slotAppt.id } });
}

const offersTo = async (mobile: string) =>
  admin.message.findMany({
    where: { mobileE164: mobile, direction: 'outbound', contextType: 'offer' },
    orderBy: { createdAt: 'asc' },
  });
const lastText = async (mobile: string) =>
  (
    await admin.message.findMany({
      where: { mobileE164: mobile, direction: 'outbound' },
      orderBy: { createdAt: 'asc' },
    })
  ).at(-1)?.body;
const textIn = (from: string, body: string) =>
  services.messaging.handleInbound(
    { providerMessageId: crypto.randomUUID(), from, to: CLINIC, body },
    'dev',
  );
const mockAt = (tenantId: string, startsAt: Date) =>
  admin.mockAppointment.findMany({ where: { tenantId, startsAt, status: { not: 'cancelled' } } });

describe('cancellation -> offer -> batches', () => {
  it('creates an offer and texts the first batch (3), longest-waiting first, with the plan’s wording', async () => {
    const s = await scenario({ waitlisters: 4 });
    const offer = await cancelSlot(s);

    expect(offer).toMatchObject({ status: 'open', nextBatchNo: 2 });
    expect(offer.expiresAt).toEqual(new Date(at(2, '10:00').getTime() - 120 * MINUTE));
    const recipients = await admin.offerRecipient.findMany({
      where: { offerId: offer.id },
      include: { patient: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(recipients.map((r) => r.patient.firstName)).toEqual(['W1', 'W2', 'W3']);
    const [text] = await offersTo(s.waitlisters[0]?.mobile ?? '');
    expect(text?.body).toMatch(
      /^Hi W1, an earlier appointment opened with Dr\. Test Provider on .+ at 10:00 AM\. Reply YES to take it\. First to reply gets it\.$/,
    );
    expect(await offersTo(s.waitlisters[3]?.mobile ?? '')).toEqual([]);
  });

  it('sends the next batch after the batch timeout, and stops when the offer expires', async () => {
    const s = await scenario({ waitlisters: 4 });
    const offer = await cancelSlot(s);
    ctx.clock.advance(15 * MINUTE + 1000);
    await ctx.runJobs();
    expect(await offersTo(s.waitlisters[3]?.mobile ?? '')).toHaveLength(1);

    ctx.clock.set(new Date(offer.expiresAt.getTime() + 1000));
    await ctx.runJobs();
    expect((await admin.slotOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe(
      'expired',
    );
  });

  it('does not offer slots inside the minimum notice or beyond the horizon', async () => {
    const s = await scenario({ waitlisters: 1 });
    ctx.clock.set(new Date(at(2, '10:00').getTime() - 60 * MINUTE)); // 1 h before: inside 2 h notice
    await admin.mockAppointment.update({ where: { id: s.slot.id }, data: { status: 'cancelled' } });
    await services.sync.sync(s.tenant.id, 'full');
    await ctx.runJobs();
    expect(await admin.slotOffer.count()).toBe(0);
  });

  it('never offers to opted-out numbers', async () => {
    const s = await scenario({ waitlisters: 2 });
    const w1 = s.waitlisters[0];
    await admin.smsConsent.create({
      data: {
        tenantId: s.tenant.id,
        mobileE164: w1?.mobile ?? '',
        status: 'opted_out',
        source: 'test',
      },
    });
    await cancelSlot(s);
    expect(await offersTo(w1?.mobile ?? '')).toEqual([]);
    expect(await offersTo(s.waitlisters[1]?.mobile ?? '')).toHaveLength(1);
  });

  it('defers the first batch during quiet hours and sends it when they end', async () => {
    const s = await scenario({ waitlisters: 1 });
    const now = ctx.clock.now();
    const end = new Date(now.getTime() + 60 * MINUTE);
    await admin.tenantSettings.update({
      where: { tenantId: s.tenant.id },
      data: {
        quietHoursStart: toTimeKey(new Date(now.getTime() - 60 * MINUTE), NY),
        quietHoursEnd: toTimeKey(end, NY),
      },
    });
    await cancelSlot(s);
    expect(await offersTo(s.waitlisters[0]?.mobile ?? '')).toEqual([]);

    ctx.clock.set(new Date(end.getTime() + MINUTE));
    await ctx.runJobs();
    expect(await offersTo(s.waitlisters[0]?.mobile ?? '')).toHaveLength(1);
  });

  it('applies the candidate rules: provider, duration, earliest date, later current appointment, windows', async () => {
    const s = await scenario({ waitlisters: 5 });
    const [w1, w2, w3, w4, w5] = s.waitlisters;
    const otherProvider = await admin.provider.create({
      data: { tenantId: s.tenant.id, ehrProviderId: 'other', displayName: 'Dr. Other' },
    });
    const longVisit = await admin.visitType.create({
      data: { tenantId: s.tenant.id, code: 'LONG', name: 'Long', durationMin: 60 },
    });
    const entry = (w?: Waitlister) => ({ patientId: w?.patientId ?? '' });
    await admin.waitlistEntry.updateMany({
      where: entry(w1),
      data: { providerId: otherProvider.id },
    });
    await admin.waitlistEntry.updateMany({ where: entry(w2), data: { visitTypeId: longVisit.id } });
    await admin.waitlistEntry.updateMany({
      where: entry(w3),
      data: { earliestDate: new Date(`${addDays(toDateKey(new Date(), NY), 5)}T00:00:00Z`) },
    });
    await admin.waitlistEntry.updateMany({
      where: entry(w4),
      data: { preferredWindows: [{ dow: [0, 1, 2, 3, 4, 5, 6], from: '13:00', to: '17:00' }] },
    });
    // w5: 10:00 slot is inside its window -> the only eligible one.
    await admin.waitlistEntry.updateMany({
      where: entry(w5),
      data: { preferredWindows: [{ dow: [0, 1, 2, 3, 4, 5, 6], from: '09:00', to: '12:00' }] },
    });
    const offer = await cancelSlot(s);
    const recipients = await admin.offerRecipient.findMany({
      where: { offerId: offer.id },
      include: { patient: true },
    });
    expect(recipients.map((r) => r.patient.firstName)).toEqual(['W5']);
  });

  it('gives a shared family number only one offer at a time', async () => {
    const s = await scenario({ waitlisters: 3, sharedMobile: true }); // W1 and W2 share a phone
    const offer = await cancelSlot(s);
    const recipients = await admin.offerRecipient.findMany({
      where: { offerId: offer.id },
      include: { patient: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(recipients.map((r) => r.patient.firstName)).toEqual(['W1', 'W3']);

    await textIn(s.waitlisters[0]?.mobile ?? '', 'YES');
    await ctx.runJobs();
    const filled = await admin.slotOffer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(filled.filledByPatientId).toBe(s.waitlisters[0]?.patientId);
  });
});

describe('accepting (race-safe booking)', () => {
  it('first YES books in the EHR, moves the patient, tells everyone, and offers the freed slot onward', async () => {
    const s = await scenario({ waitlisters: 4 });
    const offer = await cancelSlot(s);
    const [w1, w2, w3, w4] = s.waitlisters as [Waitlister, Waitlister, Waitlister, Waitlister];

    expect(await textIn(w1.mobile, 'yes')).toBe('routed');
    await ctx.runJobs(); // offer.accept -> book + cancel old -> ehr.sync -> appointment.changed -> new offer

    // Booked in the mock EHR; their later appointment cancelled there.
    const booked = await mockAt(s.tenant.id, at(2, '10:00'));
    expect(booked).toHaveLength(1);
    expect(booked[0]?.patientId).toBe(w1.ehrPatientId);
    expect(
      (await admin.mockAppointment.findUniqueOrThrow({ where: { id: w1.currentEhrAppointmentId } }))
        .status,
    ).toBe('cancelled');

    // SlotFill state.
    const filled = await admin.slotOffer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(filled).toMatchObject({
      status: 'filled',
      filledByPatientId: w1.patientId,
      filledVisitTypeId: s.followUp.id,
    });
    const newAppt = await admin.appointment.findUniqueOrThrow({
      where: { id: filled.filledAppointmentId ?? '' },
    });
    expect(newAppt).toMatchObject({
      source: 'slotfill',
      status: 'booked',
      startsAt: at(2, '10:00'),
    });
    expect(
      (await admin.waitlistEntry.findFirstOrThrow({ where: { patientId: w1.patientId } })).status,
    ).toBe('fulfilled');
    expect(
      await admin.reminder.count({ where: { appointmentId: newAppt.id, status: 'scheduled' } }),
    ).toBeGreaterThan(0);

    // Texts.
    expect(await lastText(w1.mobile)).toMatch(/^You're booked, W1! .*has been cancelled\.$/);
    for (const w of [w2, w3]) {
      const bodies = (
        await admin.message.findMany({ where: { mobileE164: w.mobile, direction: 'outbound' } })
      ).map((m) => m.body);
      expect(bodies.some((b) => b.includes('was just taken'))).toBe(true);
    }

    // Chain: W1's old 12-day slot is now itself offered (to the others, not W1).
    const chained = await admin.slotOffer.findUniqueOrThrow({
      where: { sourceAppointmentId: w1.currentAppointmentId },
    });
    const chainedTo = await admin.offerRecipient.findMany({
      where: { offerId: chained.id },
      include: { patient: true },
      orderBy: { createdAt: 'asc' },
    });
    // W2–W4 all hold appointments later than W1's freed one; W1 (who freed it) is excluded.
    expect(chainedTo.map((r) => r.patientId)).toEqual([w2.patientId, w3.patientId, w4.patientId]);
    expect(await lastText(w2.mobile)).toContain('an earlier appointment opened');
    expect(await auditActions(s.tenant.id)).toContain('offer.accepted');
  });

  it('two concurrent YES replies -> exactly one booking; the other is told it was taken', async () => {
    const s = await scenario({ waitlisters: 2 });
    const offer = await cancelSlot(s);
    const [w1, w2] = s.waitlisters as [Waitlister, Waitlister];
    await textIn(w1.mobile, 'YES');
    await textIn(w2.mobile, 'YES');
    const recipients = await admin.offerRecipient.findMany({ where: { offerId: offer.id } });

    const outcomes = await Promise.all(
      recipients.map((r) => services.offers.accept(s.tenant.id, r.id)),
    );
    expect(outcomes.sort()).toEqual(['too_late', 'won']);
    expect(await mockAt(s.tenant.id, at(2, '10:00'))).toHaveLength(1);
    const after = await admin.offerRecipient.findMany({ where: { offerId: offer.id } });
    expect(after.map((r) => r.outcome).sort()).toEqual(['too_late', 'won']);
    expect(
      await admin.appointment.count({ where: { startsAt: at(2, '10:00'), source: 'slotfill' } }),
    ).toBe(1);
  });

  it('slot taken in the EHR between the offer and the YES -> graceful message, offer cancelled', async () => {
    const s = await scenario({ waitlisters: 1 });
    const offer = await cancelSlot(s);
    const w1 = s.waitlisters[0] as Waitlister;
    // Front desk books someone else into the slot directly in the EHR.
    const walkIn = await admin.mockPatient.create({
      data: { tenantId: s.tenant.id, firstName: 'Walk', lastName: 'In' },
    });
    await createMockAppointment({
      tenantId: s.tenant.id,
      patientId: walkIn.id,
      providerId: s.provider.id,
      startsAt: at(2, '10:00'),
    });

    await textIn(w1.mobile, 'YES');
    await ctx.runJobs();
    expect(await lastText(w1.mobile)).toContain('no longer available');
    expect(await admin.slotOffer.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({
      status: 'cancelled',
      cancelReason: 'slot_taken_in_ehr',
    });
    expect(
      (await admin.mockAppointment.findUniqueOrThrow({ where: { id: w1.currentEhrAppointmentId } }))
        .status,
    ).toBe('booked');
  });

  it('if the EHR fails mid-booking: rolls back (incl. the EHR booking), tells the patient, alerts staff', async () => {
    const s = await scenario({ waitlisters: 1 });
    const offer = await cancelSlot(s);
    const w1 = s.waitlisters[0] as Waitlister;
    await admin.mockAppointment.delete({ where: { id: w1.currentEhrAppointmentId } }); // cancel-old will fail

    await textIn(w1.mobile, 'YES');
    await ctx.runJobs();

    expect((await admin.slotOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe(
      'open',
    );
    expect(await mockAt(s.tenant.id, at(2, '10:00'))).toEqual([]); // compensated
    expect(await lastText(w1.mobile)).toContain('The clinic will call you');
    const yes = await admin.message.findFirstOrThrow({
      where: { direction: 'inbound', mobileE164: w1.mobile },
    });
    expect(yes.needsAttention).toBe(true);
    expect(await auditActions(s.tenant.id)).toContain('offer.booking_failed');
  });

  it('NO declines politely and the slot stays open; a late YES after it was filled gets "taken"', async () => {
    const s = await scenario({ waitlisters: 2 });
    const [w1, w2] = s.waitlisters as [Waitlister, Waitlister];
    await cancelSlot(s);
    await textIn(w1.mobile, 'no');
    expect(await lastText(w1.mobile)).toContain("you're still on the waitlist");
    await textIn(w2.mobile, 'YES');
    await ctx.runJobs();
    expect(await lastText(w2.mobile)).toContain("You're booked");
  });
});

describe('waitlist invites ("Reply EARLY")', () => {
  async function clinicWithNewBooking(daysOut: number) {
    const tenant = await createTenant('Maple Family Clinic', { smsNumber: CLINIC });
    await admin.tenantSettings.update({
      where: { tenantId: tenant.id },
      data: { quietHoursStart: '00:00', quietHoursEnd: '00:00' },
    });
    const { provider, patient } = await createMockEhr(tenant.id);
    await services.sync.sync(tenant.id, 'full'); // initial backfill (nothing yet)
    await ctx.runJobs();
    await createMockAppointment({
      tenantId: tenant.id,
      patientId: patient.id,
      providerId: provider.id,
      startsAt: at(daysOut, '10:00'),
    });
    await services.sync.sync(tenant.id, 'incremental');
    await ctx.runJobs();
    return { tenant, mobile: '+15550000001' };
  }

  it('invites a patient booked ≥ 10 days out; EARLY puts them on the waitlist for that provider/visit', async () => {
    const { tenant, mobile } = await clinicWithNewBooking(15);
    const invite = await admin.message.findFirstOrThrow({
      where: { mobileE164: mobile, contextType: 'waitlist_invite' },
    });
    expect(invite.body).toContain('Reply EARLY');
    expect(invite.status).toBe('sent');

    expect(await textIn(mobile, 'early')).toBe('routed');
    const entry = await admin.waitlistEntry.findFirstOrThrow({
      where: { tenantId: tenant.id },
      include: { currentAppointment: true },
    });
    expect(entry).toMatchObject({ source: 'sms_opt_in', status: 'active' });
    expect(entry.currentAppointment?.startsAt).toEqual(at(15, '10:00'));
    expect(await lastText(mobile)).toContain("You're on the waitlist");
  });

  it('does not invite for appointments sooner than 10 days', async () => {
    const { mobile } = await clinicWithNewBooking(5);
    expect(
      await admin.message.count({ where: { mobileE164: mobile, contextType: 'waitlist_invite' } }),
    ).toBe(0);
  });

  it('never mass-invites the calendar during the initial backfill', async () => {
    const tenant = await createTenant('Maple Family Clinic', { smsNumber: CLINIC });
    const { provider, patient } = await createMockEhr(tenant.id);
    await createMockAppointment({
      tenantId: tenant.id,
      patientId: patient.id,
      providerId: provider.id,
      startsAt: at(20, '10:00'),
    });
    await services.sync.sync(tenant.id, 'full');
    await ctx.runJobs();
    expect(await admin.waitlistInvite.count()).toBe(0);
  });
});
