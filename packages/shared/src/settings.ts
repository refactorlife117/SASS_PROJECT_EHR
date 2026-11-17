import { z } from 'zod';

const timeKey = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

export const tenantSettingsSchema = z.object({
  reminderHoursBefore: z.array(z.number().int()),
  offerBatchSize: z.number().int(),
  offerBatchTimeoutMin: z.number().int(),
  minNoticeMin: z.number().int(),
  backfillHorizonDays: z.number().int(),
  quietHoursStart: timeKey,
  quietHoursEnd: timeKey,
  autoWaitlistInvite: z.boolean(),
  autoWaitlistMinDaysOut: z.number().int(),
});

export const settingsResponseSchema = z.object({
  clinic: z.object({
    name: z.string(),
    timezone: z.string(),
    smsNumber: z.string().nullable(),
    contactPhone: z.string().nullable(),
    /** This clinic's SMS provider; null = the deployment default. */
    smsProvider: z.string().nullable(),
    defaultSmsProvider: z.string(),
    /** Providers configured on this deployment that the clinic can choose. */
    availableSmsProviders: z.array(z.string()),
  }),
  settings: tenantSettingsSchema,
  /** Whether the signed-in user may change them (owners only). */
  canEdit: z.boolean(),
});
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

export const settingsUpdateSchema = z
  .object({
    contactPhone: z.string().trim().max(30).nullable(),
    smsProvider: z.enum(['dev', 'aws', 'twilio']).nullable(),
    reminderHoursBefore: z
      .array(z.number().int().min(1).max(168))
      .max(4)
      .refine((hours) => new Set(hours).size === hours.length, {
        message: 'Offsets must be unique',
      }),
    offerBatchSize: z.number().int().min(1).max(20),
    offerBatchTimeoutMin: z.number().int().min(1).max(240),
    minNoticeMin: z.number().int().min(0).max(2880),
    backfillHorizonDays: z.number().int().min(1).max(60),
    quietHoursStart: timeKey,
    quietHoursEnd: timeKey,
    autoWaitlistInvite: z.boolean(),
    autoWaitlistMinDaysOut: z.number().int().min(1).max(90),
  })
  .partial();
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export const ehrConnectionResponseSchema = z.object({
  connection: z
    .object({
      ehrType: z.string(),
      status: z.string(),
      lastSyncedAt: z.iso.datetime().nullable(),
      lastError: z.string().nullable(),
    })
    .nullable(),
  /** Real EHRs this deployment can connect to (configured client credentials). */
  available: z.array(z.enum(['drchrono'])),
  canEdit: z.boolean(),
});
export type EhrConnectionResponse = z.infer<typeof ehrConnectionResponseSchema>;

export const ehrAuthorizeResponseSchema = z.object({ authorizeUrl: z.url() });
