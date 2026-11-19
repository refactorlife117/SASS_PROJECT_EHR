import { z } from 'zod';
import { e164Schema } from './messages';
import { teamMemberSchema } from './users';

/** Any IANA time zone the runtime knows, e.g. America/New_York. */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'must be a valid time zone, e.g. America/New_York');

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable();

export const adminClinicSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  timezone: z.string(),
  smsNumber: z.string().nullable(),
  createdAt: z.iso.datetime(),
  activeUsers: z.number().int(),
  invitedUsers: z.number().int(),
  ehr: z
    .object({
      type: z.string(),
      status: z.string(),
      lastSyncedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
});
export type AdminClinicSummary = z.infer<typeof adminClinicSummarySchema>;

export const adminClinicListResponseSchema = z.object({
  clinics: z.array(adminClinicSummarySchema),
});
export type AdminClinicListResponse = z.infer<typeof adminClinicListResponseSchema>;

export const adminCreateClinicSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: timeZoneSchema,
  contactPhone: optionalText(30).optional(),
  smsNumber: e164Schema.nullable().optional(),
  ownerEmail: z
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
});
export type AdminCreateClinicRequest = z.input<typeof adminCreateClinicSchema>;

export const adminCreateClinicResponseSchema = z.object({ clinicId: z.uuid() });

export const adminUpdateClinicSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    timezone: timeZoneSchema,
    contactPhone: optionalText(30),
    smsNumber: e164Schema.nullable(),
    smsProvider: z.enum(['dev', 'aws', 'twilio']).nullable(),
  })
  .partial();
export type AdminUpdateClinicRequest = z.input<typeof adminUpdateClinicSchema>;

export const adminClinicDetailSchema = z.object({
  clinic: z.object({
    id: z.uuid(),
    name: z.string(),
    timezone: z.string(),
    smsNumber: z.string().nullable(),
    contactPhone: z.string().nullable(),
    /** null = the deployment default. */
    smsProvider: z.string().nullable(),
    createdAt: z.iso.datetime(),
  }),
  ehr: adminClinicSummarySchema.shape.ehr,
  users: z.array(teamMemberSchema),
  defaultSmsProvider: z.string(),
  availableSmsProviders: z.array(z.string()),
});
export type AdminClinicDetail = z.infer<typeof adminClinicDetailSchema>;
