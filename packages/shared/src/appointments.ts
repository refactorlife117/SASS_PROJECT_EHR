import { z } from 'zod';

export const appointmentStatusSchema = z.enum([
  'booked',
  'confirmed',
  'cancelled',
  'no_show',
  'completed',
]);
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>;

export const appointmentSourceSchema = z.enum(['ehr', 'slotfill']);

/** Max span of one appointments query. */
export const APPOINTMENT_QUERY_MAX_DAYS = 62;

export const appointmentListQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    providerId: z.uuid().optional(),
    status: appointmentStatusSchema.optional(),
  })
  .refine((q) => new Date(q.from) < new Date(q.to), { message: '`from` must be before `to`' })
  .refine(
    (q) =>
      new Date(q.to).getTime() - new Date(q.from).getTime() <=
      APPOINTMENT_QUERY_MAX_DAYS * 86_400_000,
    { message: `Range must be at most ${String(APPOINTMENT_QUERY_MAX_DAYS)} days` },
  );
export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;

export const appointmentSchema = z.object({
  id: z.uuid(),
  startsAt: z.iso.datetime(),
  durationMin: z.number().int(),
  status: appointmentStatusSchema,
  source: appointmentSourceSchema,
  patient: z.object({ id: z.uuid(), firstName: z.string(), lastName: z.string() }),
  provider: z.object({ id: z.uuid(), displayName: z.string() }),
  visitType: z.object({ id: z.uuid(), name: z.string() }),
});
export type AppointmentDto = z.infer<typeof appointmentSchema>;

export const appointmentListResponseSchema = z.object({
  appointments: z.array(appointmentSchema),
});
export type AppointmentListResponse = z.infer<typeof appointmentListResponseSchema>;

export const providerListResponseSchema = z.object({
  providers: z.array(z.object({ id: z.uuid(), displayName: z.string() })),
});
export type ProviderListResponse = z.infer<typeof providerListResponseSchema>;
