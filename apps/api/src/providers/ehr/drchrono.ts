// DrChrono EHR adapter (API v4, https://app.drchrono.com/api-docs/). Built from the official docs;
// see docs/decisions.md for the items marked as needing confirmation against a real sandbox.
//
// DrChrono specifics handled here:
// - OAuth2 bearer tokens (48 h) refreshed with the refresh token, persisted encrypted.
// - Cursor pagination: follow `next`; the list key is documented as both `results` and `data`.
// - `scheduled_time` is clinic-local without an offset -> converted with the tenant time zone.
// - Cancelling = PATCH status "Cancelled"; deleted appointments (deleted_flag) count as cancelled.
// - Breaks (no patient) are never synced as appointments, but they do block slots.
import { toDateKey, toTimeKey, zonedTimeToUtc } from '@slotfill/shared';
import { z } from 'zod';
import type { AppointmentStatus } from '../../generated/prisma/client';
import {
  EhrSlotUnavailableError,
  type EhrAdapter,
  type EhrAppointment,
  type EhrPatient,
  type EhrProvider,
  type EhrVisitType,
} from './types';

export interface DrChronoConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export const drChronoCredentialsSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.iso.datetime(),
  /** Defaults for new bookings (DrChrono requires office + exam room). */
  officeId: z.number().int(),
  examRoom: z.number().int(),
});
export type DrChronoCredentials = z.infer<typeof drChronoCredentialsSchema>;

export interface CredentialStore {
  load(): Promise<DrChronoCredentials>;
  save(credentials: DrChronoCredentials): Promise<void>;
}

export class DrChronoApiError extends Error {
  constructor(readonly status: number) {
    super(`DrChrono API error ${String(status)}`); // never include response bodies (PHI)
    this.name = 'DrChronoApiError';
  }
}

/** Visit type used for appointments without a DrChrono appointment profile. */
export const NO_PROFILE_CODE = 'none';
const DEFAULT_DURATION_MIN = 30;

const STATUS_MAP: Record<string, AppointmentStatus> = {
  Cancelled: 'cancelled',
  'No Show': 'no_show',
  Complete: 'completed',
  Confirmed: 'confirmed',
};

const appointmentSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  doctor: z.number(),
  patient: z.number().nullable().optional(),
  office: z.number().optional(),
  exam_room: z.number().optional(),
  profile: z.number().nullable().optional(),
  scheduled_time: z.string(),
  duration: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
  updated_at: z.string().optional(),
  deleted_flag: z.boolean().optional(),
  appt_is_break: z.boolean().optional(),
});
type DrChronoAppointment = z.infer<typeof appointmentSchema>;

/** Normalize a US phone number to E.164, or null if it isn't one. */
export function toUsE164(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Clinic-local naive "YYYY-MM-DDTHH:MM[:SS]" (or an ISO string with offset) -> UTC instant. */
export function parseDrChronoTime(value: string, timezone: string): Date {
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return new Date(value);
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/.exec(value);
  if (!m?.[1] || !m[2]) throw new Error('Unrecognized DrChrono time');
  return new Date(zonedTimeToUtc(m[1], m[2], timezone).getTime() + Number(m[3] ?? 0) * 1000);
}

const toDrChronoTime = (instant: Date, timezone: string) =>
  `${toDateKey(instant, timezone)}T${toTimeKey(instant, timezone)}:00`;

/** HTTP client: bearer auth with refresh, cursor pagination. */
export class DrChronoClient {
  private credentials: DrChronoCredentials | null = null;

  constructor(
    private readonly config: DrChronoConfig,
    private readonly store: CredentialStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async token(forceRefresh = false): Promise<string> {
    this.credentials ??= await this.store.load();
    const expiringSoon = new Date(this.credentials.expiresAt).getTime() - 60_000 < Date.now();
    if (forceRefresh || expiringSoon) {
      const tokens = await exchangeToken(this.config, this.fetchImpl, {
        grant_type: 'refresh_token',
        refresh_token: this.credentials.refreshToken,
      });
      this.credentials = { ...this.credentials, ...tokens };
      await this.store.save(this.credentials);
    }
    return this.credentials.accessToken;
  }

  async request(method: string, pathOrUrl: string, body?: unknown): Promise<unknown> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.config.baseUrl}${pathOrUrl}`;
    const send = async (token: string) =>
      this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? null : JSON.stringify(body),
      });
    let res = await send(await this.token());
    if (res.status === 401) res = await send(await this.token(true));
    if (res.status === 409) throw new EhrSlotUnavailableError();
    if (!res.ok) throw new DrChronoApiError(res.status);
    if (res.status === 204) return null;
    const json: unknown = await res.json();
    return json;
  }

  /** GET every page of a list endpoint. */
  async list(path: string, query: Record<string, string>): Promise<unknown[]> {
    const items: unknown[] = [];
    let next: string | null = `${path}?${new URLSearchParams(query).toString()}`;
    for (let page = 0; next && page < 500; page++) {
      const body = z
        .object({
          next: z.string().nullable().optional(),
          results: z.array(z.unknown()).optional(),
          data: z.array(z.unknown()).optional(),
        })
        .parse(await this.request('GET', next));
      items.push(...(body.results ?? body.data ?? []));
      next = body.next ?? null;
    }
    return items;
  }

  async defaults(): Promise<{ officeId: number; examRoom: number }> {
    this.credentials ??= await this.store.load();
    return { officeId: this.credentials.officeId, examRoom: this.credentials.examRoom };
  }
}

/** OAuth token endpoint (authorization_code and refresh_token grants). */
export async function exchangeToken(
  config: DrChronoConfig,
  fetchImpl: typeof fetch,
  grant: Record<string, string>,
): Promise<Pick<DrChronoCredentials, 'accessToken' | 'refreshToken' | 'expiresAt'>> {
  const res = await fetchImpl(`${config.baseUrl}/o/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...grant,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
  });
  if (!res.ok) throw new DrChronoApiError(res.status);
  const body = z
    .object({ access_token: z.string(), refresh_token: z.string(), expires_in: z.number() })
    .parse(await res.json());
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  };
}

export class DrChronoAdapter implements EhrAdapter {
  constructor(
    private readonly client: DrChronoClient,
    private readonly timezone: () => Promise<string>,
  ) {}

  private async map(raw: unknown): Promise<EhrAppointment | null> {
    const a: DrChronoAppointment = appointmentSchema.parse(raw);
    if (a.patient === null || a.patient === undefined || a.appt_is_break) return null; // breaks
    const tz = await this.timezone();
    return {
      ehrAppointmentId: a.id,
      ehrPatientId: String(a.patient),
      ehrProviderId: String(a.doctor),
      visitTypeCode:
        a.profile === null || a.profile === undefined ? NO_PROFILE_CODE : String(a.profile),
      startsAt: parseDrChronoTime(a.scheduled_time, tz),
      durationMin: a.duration ?? DEFAULT_DURATION_MIN,
      status: a.deleted_flag ? 'cancelled' : (STATUS_MAP[a.status ?? ''] ?? 'booked'),
      updatedAt: a.updated_at ? parseDrChronoTime(a.updated_at, tz) : new Date(0),
    };
  }

  private async mapAll(raws: unknown[]): Promise<EhrAppointment[]> {
    const mapped = await Promise.all(raws.map((r) => this.map(r)));
    return mapped.filter((a): a is EhrAppointment => a !== null);
  }

  async listAppointments(range: { from: Date; to: Date }): Promise<EhrAppointment[]> {
    const tz = await this.timezone();
    const raws = await this.client.list('/api/appointments', {
      date_range: `${toDateKey(range.from, tz)}/${toDateKey(range.to, tz)}`,
    });
    return (await this.mapAll(raws)).filter(
      (a) => a.startsAt >= range.from && a.startsAt < range.to,
    );
  }

  async listChangedAppointments(since: Date): Promise<EhrAppointment[]> {
    // `since` filters by updated/created date; day granularity is fine (sync skips unchanged rows).
    const tz = await this.timezone();
    return this.mapAll(
      await this.client.list('/api/appointments', { since: toDateKey(since, tz) }),
    );
  }

  async getPatient(ehrPatientId: string): Promise<EhrPatient | null> {
    try {
      const p = z
        .object({
          id: z.number(),
          first_name: z.string(),
          last_name: z.string(),
          cell_phone: z.string().nullable().optional(),
        })
        .parse(
          await this.client.request('GET', `/api/patients/${encodeURIComponent(ehrPatientId)}`),
        );
      return {
        ehrPatientId: String(p.id),
        firstName: p.first_name,
        lastName: p.last_name,
        mobileE164: toUsE164(p.cell_phone),
      };
    } catch (err) {
      if (err instanceof DrChronoApiError && err.status === 404) return null;
      throw err;
    }
  }

  async listProviders(): Promise<EhrProvider[]> {
    const doctors = z
      .array(
        z.object({
          id: z.number(),
          first_name: z.string().optional(),
          last_name: z.string().optional(),
        }),
      )
      .parse(await this.client.list('/api/doctors', {}));
    return doctors.map((d) => ({
      ehrProviderId: String(d.id),
      displayName: `Dr. ${[d.first_name, d.last_name].filter(Boolean).join(' ')}`.trim(),
    }));
  }

  async listVisitTypes(): Promise<EhrVisitType[]> {
    const profiles = z
      .array(
        z.object({ id: z.number(), name: z.string(), duration: z.number().nullable().optional() }),
      )
      .parse(await this.client.list('/api/appointment_profiles', {}));
    return [
      ...profiles.map((p) => ({
        code: String(p.id),
        name: p.name,
        durationMin: p.duration ?? DEFAULT_DURATION_MIN,
      })),
      { code: NO_PROFILE_CODE, name: 'Appointment', durationMin: DEFAULT_DURATION_MIN },
    ];
  }

  async isSlotOpen(input: {
    ehrProviderId: string;
    startsAt: Date;
    durationMin: number;
  }): Promise<boolean> {
    const tz = await this.timezone();
    const day = await this.client.list('/api/appointments', {
      doctor: input.ehrProviderId,
      date: toDateKey(input.startsAt, tz),
    });
    const start = input.startsAt.getTime();
    const end = start + input.durationMin * 60_000;
    return !day.some((raw) => {
      const a = appointmentSchema.parse(raw);
      if (a.deleted_flag || a.status === 'Cancelled') return false;
      const s = parseDrChronoTime(a.scheduled_time, tz).getTime();
      const e = s + (a.duration ?? DEFAULT_DURATION_MIN) * 60_000;
      return s < end && e > start; // breaks block too
    });
  }

  async bookAppointment(input: {
    ehrPatientId: string;
    ehrProviderId: string;
    startsAt: Date;
    durationMin: number;
    visitType: string;
  }): Promise<{ ehrAppointmentId: string }> {
    const tz = await this.timezone();
    const { officeId, examRoom } = await this.client.defaults();
    const created = z.object({ id: z.union([z.string(), z.number()]).transform(String) }).parse(
      await this.client.request('POST', '/api/appointments', {
        doctor: Number(input.ehrProviderId),
        patient: Number(input.ehrPatientId),
        office: officeId,
        exam_room: examRoom,
        scheduled_time: toDrChronoTime(input.startsAt, tz),
        duration: input.durationMin,
        ...(input.visitType !== NO_PROFILE_CODE ? { profile: Number(input.visitType) } : {}),
      }),
    );
    return { ehrAppointmentId: created.id };
  }

  async cancelAppointment(ehrAppointmentId: string, _reason: string): Promise<void> {
    await this.client.request(
      'PATCH',
      `/api/appointments/${encodeURIComponent(ehrAppointmentId)}`,
      {
        status: 'Cancelled',
      },
    );
  }
}
