import type { UserStatus } from '@slotfill/shared';

const LABEL: Record<UserStatus, string> = {
  active: 'Active',
  invited: 'Invited',
  invite_expired: 'Invite expired',
  disabled: 'Deactivated',
};

/** Reuses the appointment badge colors: green active, blue invited, red expired/deactivated. */
const CLASS: Record<UserStatus, string> = {
  active: 'badge-confirmed',
  invited: 'badge-booked',
  invite_expired: 'badge-cancelled',
  disabled: 'badge-cancelled',
};

export function TeamStatusBadge({ status }: { status: UserStatus }) {
  return <span className={`badge ${CLASS[status]}`}>{LABEL[status]}</span>;
}
