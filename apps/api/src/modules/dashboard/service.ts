import type { DashboardSummary } from '@slotfill/shared';
import type { Tx } from '../../db/client';

/**
 * Metrics (plan §7.8). Runs inside the caller's tenant transaction, so RLS scopes every query.
 * Range-bound numbers count offers *created* in [from, to) and reminders *sent* in [from, to).
 */
export async function dashboardSummary(tx: Tx, from: Date, to: Date): Promise<DashboardSummary> {
  const [byStatus, revenue, median, reminders, openOffers, needsAttention, activeWaitlist] =
    await Promise.all([
      tx.slotOffer.groupBy({
        by: ['status'],
        where: { createdAt: { gte: from, lt: to } },
        _count: { _all: true },
      }),
      tx.$queryRaw<{ cents: bigint | null }[]>`
      SELECT COALESCE(SUM(v.estimated_value_cents), 0)::bigint AS cents
      FROM slot_offers o
      JOIN visit_types v ON v.id = o.filled_visit_type_id
      WHERE o.status = 'filled' AND o.created_at >= ${from} AND o.created_at < ${to}`,
      tx.$queryRaw<{ seconds: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (filled_at - created_at)))::float8 AS seconds
      FROM slot_offers
      WHERE status = 'filled' AND filled_at IS NOT NULL AND created_at >= ${from} AND created_at < ${to}`,
      tx.$queryRaw<{ reminded: bigint; confirmed: bigint }[]>`
      WITH reminded AS (
        SELECT DISTINCT appointment_id FROM reminders
        WHERE status = 'sent' AND sent_at >= ${from} AND sent_at < ${to}
      )
      SELECT
        (SELECT count(*) FROM reminded) AS reminded,
        (SELECT count(DISTINCT a.entity_id) FROM audit_log a
           JOIN reminded r ON a.entity_id = r.appointment_id::text
          WHERE a.action = 'appointment.confirmed_by_sms') AS confirmed`,
      tx.slotOffer.count({ where: { status: 'open' } }),
      tx.message.count({ where: { needsAttention: true } }),
      tx.waitlistEntry.count({ where: { status: 'active' } }),
    ]);

  const count = (status: string) => byStatus.find((g) => g.status === status)?._count._all ?? 0;
  const filled = count('filled');
  const expired = count('expired');
  const remindedAppointments = Number(reminders[0]?.reminded ?? 0);
  const confirmedBySms = Number(reminders[0]?.confirmed ?? 0);

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    offers: {
      created: byStatus.reduce((sum, g) => sum + g._count._all, 0),
      filled,
      expired,
      cancelled: count('cancelled'),
      open: count('open'),
    },
    slotsRecovered: filled,
    revenueRecoveredCents: Number(revenue[0]?.cents ?? 0),
    fillRate: filled + expired > 0 ? filled / (filled + expired) : null,
    medianTimeToFillSeconds: median[0]?.seconds ?? null,
    reminders: {
      remindedAppointments,
      confirmedBySms,
      confirmationRate: remindedAppointments > 0 ? confirmedBySms / remindedAppointments : null,
    },
    now: { openOffers, needsAttention, activeWaitlist },
  };
}
