import type { AppointmentStatus } from '../../generated/prisma/client';

// The EHR's view of the world, keyed by the EHR's own ids. Adapters translate their EHR's API into
// these shapes; nothing outside providers/ehr knows which EHR is behind them.

export interface EhrProvider {
  ehrProviderId: string;
  displayName: string;
}

export interface EhrVisitType {
  code: string;
  name: string;
  durationMin: number;
}

export interface EhrPatient {
  ehrPatientId: string;
  firstName: string;
  lastName: string;
  /** E.164, or null if the EHR has no usable mobile number. */
  mobileE164: string | null;
}

export interface EhrAppointment {
  ehrAppointmentId: string;
  ehrPatientId: string;
  ehrProviderId: string;
  visitTypeCode: string;
  startsAt: Date;
  durationMin: number;
  status: AppointmentStatus;
  /** The EHR's last-modified time; used to ignore stale updates. */
  updatedAt: Date;
}

export class EhrSlotUnavailableError extends Error {
  constructor() {
    super('The requested slot is not available in the EHR');
    this.name = 'EhrSlotUnavailableError';
  }
}

/** One instance is bound to one tenant's EHR connection. */
export interface EhrAdapter {
  listAppointments(range: { from: Date; to: Date }): Promise<EhrAppointment[]>;
  listChangedAppointments(since: Date): Promise<EhrAppointment[]>;
  getPatient(ehrPatientId: string): Promise<EhrPatient | null>;
  listProviders(): Promise<EhrProvider[]>;
  /** Not in the original plan's interface; backfill needs visit types (code, name, duration). */
  listVisitTypes(): Promise<EhrVisitType[]>;
  isSlotOpen(input: {
    ehrProviderId: string;
    startsAt: Date;
    durationMin: number;
  }): Promise<boolean>;
  /** Throws EhrSlotUnavailableError if the slot was taken in the meantime. */
  bookAppointment(input: {
    ehrPatientId: string;
    ehrProviderId: string;
    startsAt: Date;
    durationMin: number;
    visitType: string;
  }): Promise<{ ehrAppointmentId: string }>;
  cancelAppointment(ehrAppointmentId: string, reason: string): Promise<void>;
}
