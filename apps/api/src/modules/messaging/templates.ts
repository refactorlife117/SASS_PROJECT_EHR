// Every SMS text SlotFill sends. Minimum necessary PHI: first name, clinic, provider, date/time
// only. Never diagnoses or visit reasons (so never the visit type).
import { formatDateInZone, formatTimeInZone } from '@slotfill/shared';

const helpLine = (phone: string | null): string => (phone ? `call ${phone}` : 'call the clinic');

/** The facts a patient-facing appointment text may contain. */
export interface SlotFacts {
  firstName: string;
  clinic: string;
  clinicPhone: string | null;
  provider: string;
  startsAt: Date;
  timezone: string;
}

const when = (f: SlotFacts) =>
  `${formatDateInZone(f.startsAt, f.timezone)} at ${formatTimeInZone(f.startsAt, f.timezone)}`;

export const templates = {
  optedOut: (clinic: string) =>
    `${clinic}: You're unsubscribed and won't get more texts. Reply START to resubscribe.`,
  optedIn: (clinic: string) =>
    `${clinic}: You're resubscribed to appointment texts. Reply STOP to opt out.`,
  help: (clinic: string, phone: string | null) =>
    `${clinic}: Appointment reminders and openings. For help ${helpLine(phone)}. Msg & data rates may apply. Reply STOP to opt out.`,
  unrecognized: (clinic: string, phone: string | null) =>
    `${clinic}: Sorry, we couldn't understand that reply. For help ${helpLine(phone)}. Reply HELP for info, STOP to opt out.`,
  devTest: (clinic: string) => `${clinic}: This is a test message from the SlotFill dev simulator.`,

  // ---- Reminders (Phase 4) ----
  reminder: (f: SlotFacts) =>
    `Hi ${f.firstName}, reminder: ${f.clinic} with ${f.provider} on ${when(f)}. Reply 1 to confirm, 2 to cancel. Reply STOP to opt out.`,
  reminderConfirmed: (f: SlotFacts) =>
    `Thanks ${f.firstName}, you're confirmed with ${f.provider} on ${when(f)}. See you then!`,
  reminderCancelled: (f: SlotFacts) =>
    `${f.clinic}: Your appointment with ${f.provider} on ${when(f)} is cancelled. To rebook, ${helpLine(f.clinicPhone)}.`,
  reminderTooLate: (f: SlotFacts) =>
    `${f.clinic}: That appointment can't be changed by text anymore. Please ${helpLine(f.clinicPhone)}.`,
  reminderCancelFailed: (f: SlotFacts) =>
    `${f.clinic}: We couldn't cancel your appointment automatically. The clinic will contact you, or ${helpLine(f.clinicPhone)}.`,

  // ---- Offers (Phase 5) ----
  offer: (f: SlotFacts) =>
    `Hi ${f.firstName}, an earlier appointment opened with ${f.provider} on ${when(f)}. Reply YES to take it. First to reply gets it.`,
  offerBooked: (f: SlotFacts, previous: Date | null) =>
    `You're booked, ${f.firstName}! ${f.clinic} with ${f.provider} on ${when(f)}.` +
    (previous
      ? ` Your appointment on ${when({ ...f, startsAt: previous })} has been cancelled.`
      : ''),
  offerTaken: (f: SlotFacts) =>
    `Sorry ${f.firstName}, the opening with ${f.provider} on ${when(f)} was just taken. You're still on the waitlist.`,
  offerGone: (f: SlotFacts) =>
    `Sorry ${f.firstName}, the opening with ${f.provider} on ${when(f)} is no longer available. You're still on the waitlist.`,
  offerDeclined: (f: SlotFacts) =>
    `OK ${f.firstName}, you're still on the waitlist for the next opening.`,
  offerBookingFailed: (f: SlotFacts) =>
    `${f.clinic}: We couldn't complete that booking automatically. The clinic will call you shortly, or ${helpLine(f.clinicPhone)}.`,

  // ---- Waitlist invites (Phase 5) ----
  waitlistInvite: (f: SlotFacts) =>
    `Hi ${f.firstName}, ${f.clinic}: would you like an earlier appointment with ${f.provider} if one opens up? Reply EARLY and we'll text you.`,
  waitlistJoined: (f: SlotFacts) =>
    `You're on the waitlist, ${f.firstName}. We'll text you if an earlier time opens with ${f.provider}. Reply STOP to opt out.`,
} as const;
