import { z } from 'zod';

export const userRoleSchema = z.enum(['owner', 'staff']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const loginRequestSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.input<typeof loginRequestSchema>;

/** After a correct password the session still needs MFA: either verify a code or enroll first. */
export const loginResponseSchema = z.object({
  next: z.enum(['mfa_verify', 'mfa_setup']),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const mfaSetupResponseSchema = z.object({
  otpauthUrl: z.string(),
  secret: z.string(),
});
export type MfaSetupResponse = z.infer<typeof mfaSetupResponseSchema>;

export const mfaVerifyRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'must be a 6-digit code'),
});
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;

export const meResponseSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), role: userRoleSchema }),
  tenant: z.object({ id: z.uuid(), name: z.string(), timezone: z.string() }),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
