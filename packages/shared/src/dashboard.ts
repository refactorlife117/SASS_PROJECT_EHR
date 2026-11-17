import { z } from 'zod';

export const dashboardQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .refine((q) => new Date(q.from) < new Date(q.to), { message: '`from` must be before `to`' })
  .refine((q) => new Date(q.to).getTime() - new Date(q.from).getTime() <= 366 * 86_400_000, {
    message: 'Range must be at most a year',
  });

export const dashboardSummarySchema = z.object({
  range: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  /** Offers created in the range. */
  offers: z.object({
    created: z.number().int(),
    filled: z.number().int(),
    expired: z.number().int(),
    cancelled: z.number().int(),
    open: z.number().int(),
  }),
  slotsRecovered: z.number().int(),
  revenueRecoveredCents: z.number().int(),
  /** filled / (filled + expired); null when there is nothing to divide. */
  fillRate: z.number().nullable(),
  medianTimeToFillSeconds: z.number().nullable(),
  reminders: z.object({
    /** Distinct appointments reminded in the range. */
    remindedAppointments: z.number().int(),
    confirmedBySms: z.number().int(),
    /** confirmedBySms / remindedAppointments; null when none were reminded. */
    confirmationRate: z.number().nullable(),
  }),
  /** Point-in-time counts (not range-bound). */
  now: z.object({
    openOffers: z.number().int(),
    needsAttention: z.number().int(),
    activeWaitlist: z.number().int(),
  }),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
