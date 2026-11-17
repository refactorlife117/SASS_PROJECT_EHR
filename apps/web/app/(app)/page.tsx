'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useDashboard } from '@/hooks/useDashboard';
import { useNeedsAttention } from '@/hooks/useMessages';

const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);
const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);
const duration = (seconds: number | null) => {
  if (seconds === null) return '—';
  if (seconds < 3600) return `${String(Math.max(1, Math.round(seconds / 60)))} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
};

export default function DashboardPage() {
  const [days, setDays] = useState(30);
  const range = useMemo(() => {
    const to = new Date();
    to.setMinutes(0, 0, 0);
    to.setHours(to.getHours() + 1);
    return { from: new Date(to.getTime() - days * 86_400_000), to };
  }, [days]);
  const summary = useDashboard(range);
  const attention = useNeedsAttention();
  const s = summary.data;

  return (
    <>
      <h1>Dashboard</h1>
      <div className="toolbar tabs">
        {RANGES.map((r) => (
          <button
            key={r.days}
            type="button"
            className={r.days === days ? '' : 'secondary'}
            onClick={() => {
              setDays(r.days);
            }}
          >
            {r.label}
          </button>
        ))}
      </div>
      {summary.isError && <p className="error">Could not load metrics.</p>}
      {s && (
        <>
          <div className="tiles">
            <Tile label="Slots recovered" value={String(s.slotsRecovered)} />
            <Tile
              label="Revenue recovered"
              value={money(s.revenueRecoveredCents)}
              hint="Set visit values in Settings"
            />
            <Tile
              label="Fill rate"
              value={percent(s.fillRate)}
              hint={`${String(s.offers.filled)} filled / ${String(s.offers.filled + s.offers.expired)} closed`}
            />
            <Tile label="Median time to fill" value={duration(s.medianTimeToFillSeconds)} />
            <Tile
              label="Reminder confirmations"
              value={percent(s.reminders.confirmationRate)}
              hint={`${String(s.reminders.confirmedBySms)} of ${String(s.reminders.remindedAppointments)} reminded`}
            />
          </div>
          <div className="tiles">
            <Tile label="Open offers" value={String(s.now.openOffers)} href="/offers" />
            <Tile label="Active waitlist" value={String(s.now.activeWaitlist)} href="/waitlist" />
            <Tile
              label="Needs attention"
              value={String(s.now.needsAttention)}
              href="/messages"
              warn={s.now.needsAttention > 0}
            />
          </div>
        </>
      )}

      <h2>Needs attention</h2>
      {attention.data?.messages.length === 0 && <p className="muted">Nothing to review.</p>}
      {attention.data && attention.data.messages.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>From</th>
              <th>Message</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {attention.data.messages.slice(0, 10).map((m) => (
              <tr key={m.id}>
                <td>
                  {m.patients.length > 0
                    ? m.patients.map((p) => `${p.firstName} ${p.lastName}`).join(', ')
                    : 'Unknown number'}
                </td>
                <td>{m.body}</td>
                <td>{new Date(m.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {attention.data && attention.data.messages.length > 10 && (
        <p>
          <Link href="/messages">See all in Messages →</Link>
        </p>
      )}
    </>
  );
}

function Tile(props: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
  warn?: boolean;
}) {
  const body = (
    <>
      <div className="tile-label">{props.label}</div>
      <div className={`tile-value ${props.warn ? 'warn' : ''}`}>{props.value}</div>
      {props.hint && <div className="muted tile-hint">{props.hint}</div>}
    </>
  );
  return props.href ? (
    <Link href={props.href} className="tile">
      {body}
    </Link>
  ) : (
    <div className="tile">{body}</div>
  );
}
