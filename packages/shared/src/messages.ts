import { z } from 'zod';

export const e164Schema = z.string().regex(/^\+[1-9]\d{6,14}$/, 'must be an E.164 phone number');

export const messageDirectionSchema = z.enum(['outbound', 'inbound']);
export const messageContextTypeSchema = z.enum(['reminder', 'offer', 'waitlist_invite', 'system']);
export type MessageContextType = z.infer<typeof messageContextTypeSchema>;
export const messageStatusSchema = z.enum(['queued', 'sent', 'delivered', 'failed', 'received']);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const messageListQuerySchema = z.object({
  mobile: e164Schema.optional(),
  context: messageContextTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const messageSchema = z.object({
  id: z.uuid(),
  direction: messageDirectionSchema,
  mobileE164: z.string(),
  body: z.string(),
  contextType: messageContextTypeSchema.nullable(),
  contextId: z.uuid().nullable(),
  status: messageStatusSchema,
  needsAttention: z.boolean(),
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** Patients with this mobile number (several are possible, e.g. a parent and children). */
  patients: z.array(z.object({ id: z.uuid(), firstName: z.string(), lastName: z.string() })),
});
export type MessageDto = z.infer<typeof messageSchema>;

export const messageListResponseSchema = z.object({ messages: z.array(messageSchema) });
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;

// ---- Dev phone simulator ----

export const devSmsConversationsResponseSchema = z.object({
  clinicNumber: z.string().nullable(),
  phones: z.array(
    z.object({
      mobileE164: z.string(),
      patientNames: z.array(z.string()),
      optedOut: z.boolean(),
      messages: z.array(
        z.object({
          id: z.uuid(),
          direction: messageDirectionSchema,
          body: z.string(),
          status: messageStatusSchema,
          createdAt: z.iso.datetime(),
        }),
      ),
    }),
  ),
});
export type DevSmsConversations = z.infer<typeof devSmsConversationsResponseSchema>;

export const devSmsInboundRequestSchema = z.object({
  from: e164Schema,
  body: z.string().min(1).max(1600),
});
export const devSmsInboundResponseSchema = z.object({ outcome: z.string() });
export const devSmsSendTestRequestSchema = z.object({ to: e164Schema });
