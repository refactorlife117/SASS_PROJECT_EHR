import type { AppointmentStatus } from '@slotfill/shared';

const LABELS: Record<AppointmentStatus, string> = {
  booked: 'Booked',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  completed: 'Completed',
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  return <span className={`badge badge-${status}`}>{LABELS[status]}</span>;
}
