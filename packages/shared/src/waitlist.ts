import { z } from 'zod';

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const timeKey = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

/** A preferred time window in the clinic's local time. dow: 0 = Sunday … 6 = Saturday. */
export const preferredWindowSchema = z
  .object({
    dow: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    from: timeKey,
    to: timeKey,
  })
  .refine((w) => w.from < w.to, { message: '`from` must be before `to`' });
export type PreferredWindow = z.infer<typeof preferredWindowSchema>;

export const waitlistStatusSchema = z.enum(['active', 'fulfilled', 'removed']);
export type WaitlistStatus = z.infer<typeof waitlistStatusSchema>;

export const waitlistCreateSchema = z.object({
  patientId: z.uuid(),
  /** Omit or null for "any provider". */
  providerId: z.uuid().nullable().optional(),
  visitTypeId: z.uuid(),
  currentAppointmentId: z.uuid().nullable().optional(),
  earliestDate: dateKey,
  preferredWindows: z.array(preferredWindowSchema).max(14).nullable().optional(),
});
export type WaitlistCreate = z.infer<typeof waitlistCreateSchema>;

export const waitlistUpdateSchema = z.object({
  providerId: z.uuid().nullable().optional(),
  visitTypeId: z.uuid().optional(),
  earliestDate: dateKey.optional(),
  preferredWindows: z.array(preferredWindowSchema).max(14).nullable().optional(),
  status: z.enum(['active', 'removed']).optional(),
});
export type WaitlistUpdate = z.infer<typeof waitlistUpdateSchema>;

export const waitlistListQuerySchema = z.object({
  status: waitlistStatusSchema.default('active'),
});

export const waitlistEntrySchema = z.object({
  id: z.uuid(),
  status: waitlistStatusSchema,
  source: z.enum(['staff', 'sms_opt_in']),
  earliestDate: dateKey,
  preferredWindows: z.array(preferredWindowSchema).nullable(),
  createdAt: z.iso.datetime(),
  patient: z.object({
    id: z.uuid(),
    firstName: z.string(),
    lastName: z.string(),
    hasMobile: z.boolean(),
  }),
  provider: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  visitType: z.object({ id: z.uuid(), name: z.string(), durationMin: z.number() }),
  currentAppointment: z
    .object({ id: z.uuid(), startsAt: z.iso.datetime(), status: z.string() })
    .nullable(),
});
export type WaitlistEntryDto = z.infer<typeof waitlistEntrySchema>;

export const waitlistListResponseSchema = z.object({ entries: z.array(waitlistEntrySchema) });
export type WaitlistListResponse = z.infer<typeof waitlistListResponseSchema>;

// ---- Patients (search, for adding to the waitlist) ----

export const patientSearchQuerySchema = z.object({
  search: z.string().trim().min(1).max(100),
});

export const patientSearchResponseSchema = z.object({
  patients: z.array(
    z.object({
      id: z.uuid(),
      firstName: z.string(),
      lastName: z.string(),
      /** Last 4 digits only (minimum necessary). */
      mobileLast4: z.string().nullable(),
      upcomingAppointments: z.array(
        z.object({
          id: z.uuid(),
          startsAt: z.iso.datetime(),
          providerId: z.uuid(),
          providerName: z.string(),
          visitTypeId: z.uuid(),
          visitTypeName: z.string(),
        }),
      ),
    }),
  ),
});
export type PatientSearchResponse = z.infer<typeof patientSearchResponseSchema>;

// ---- Visit types ----

export const visitTypeSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  durationMin: z.number(),
  estimatedValueCents: z.number().int(),
});
export type VisitTypeDto = z.infer<typeof visitTypeSchema>;
export const visitTypeListResponseSchema = z.object({ visitTypes: z.array(visitTypeSchema) });
export const visitTypeUpdateSchema = z.object({
  estimatedValueCents: z.number().int().min(0).max(10_000_000),
});
