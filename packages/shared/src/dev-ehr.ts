// Schemas for the dev-only mock EHR controls (/dev/ehr). Never used in production.
import { z } from 'zod';
import { appointmentStatusSchema } from './appointments';

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const timeKey = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

export const devEhrStateResponseSchema = z.object({
  timezone: z.string(),
  connection: z
    .object({
      status: z.string(),
      lastSyncedAt: z.iso.datetime().nullable(),
      lastError: z.string().nullable(),
    })
    .nullable(),
  providers: z.array(z.object({ id: z.uuid(), displayName: z.string() })),
  visitTypes: z.array(z.object({ code: z.string(), name: z.string(), durationMin: z.number() })),
  patients: z.array(z.object({ id: z.uuid(), firstName: z.string(), lastName: z.string() })),
  appointments: z.array(
    z.object({
      id: z.uuid(),
      startsAt: z.iso.datetime(),
      durationMin: z.number(),
      status: appointmentStatusSchema,
      patientName: z.string(),
      providerId: z.uuid(),
      visitTypeCode: z.string(),
      updatedAt: z.iso.datetime(),
    }),
  ),
});
export type DevEhrState = z.infer<typeof devEhrStateResponseSchema>;

export const devEhrCreateAppointmentSchema = z.object({
  patientId: z.uuid(),
  providerId: z.uuid(),
  visitTypeCode: z.string().min(1),
  date: dateKey,
  time: timeKey,
});
export type DevEhrCreateAppointment = z.infer<typeof devEhrCreateAppointmentSchema>;

export const devEhrMoveAppointmentSchema = z.object({ date: dateKey, time: timeKey });
export type DevEhrMoveAppointment = z.infer<typeof devEhrMoveAppointmentSchema>;
