import { z } from 'zod';

export const offerStatusSchema = z.enum(['open', 'filled', 'expired', 'cancelled']);
export type OfferStatus = z.infer<typeof offerStatusSchema>;

export const offerListQuerySchema = z.object({
  status: offerStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const offerSummarySchema = z.object({
  id: z.uuid(),
  status: offerStatusSchema,
  cancelReason: z.string().nullable(),
  startsAt: z.iso.datetime(),
  durationMin: z.number(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  filledAt: z.iso.datetime().nullable(),
  provider: z.object({ id: z.uuid(), displayName: z.string() }),
  visitType: z.object({ id: z.uuid(), name: z.string() }),
  recipientCount: z.number().int(),
  filledBy: z.object({ id: z.uuid(), firstName: z.string(), lastName: z.string() }).nullable(),
});
export type OfferSummary = z.infer<typeof offerSummarySchema>;

export const offerListResponseSchema = z.object({ offers: z.array(offerSummarySchema) });
export type OfferListResponse = z.infer<typeof offerListResponseSchema>;

export const offerRecipientSchema = z.object({
  id: z.uuid(),
  batchNo: z.number().int(),
  sentAt: z.iso.datetime().nullable(),
  reply: z.enum(['accepted', 'declined']).nullable(),
  repliedAt: z.iso.datetime().nullable(),
  outcome: z.enum(['won', 'too_late']).nullable(),
  patient: z.object({ id: z.uuid(), firstName: z.string(), lastName: z.string() }),
});

export const offerDetailResponseSchema = offerSummarySchema.extend({
  recipients: z.array(offerRecipientSchema),
});
export type OfferDetail = z.infer<typeof offerDetailResponseSchema>;
