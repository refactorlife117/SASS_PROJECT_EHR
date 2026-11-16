'use client';

import {
  addDays,
  appointmentStatusSchema,
  formatDateInZone,
  formatTimeInZone,
  toDateKey,
  zonedTimeToUtc,
  type AppointmentDto,
  type AppointmentStatus,
} from '@slotfill/shared';
import { useMemo, useState } from 'react';
import { StatusBadge } from '@/components/StatusBadge';
import { useAppointments, useProviders } from '@/hooks/useAppointments';
import { useMe } from '@/hooks/useAuth';

const RANGE_OPTIONS = [1, 7, 14, 30];

export default function AppointmentsPage() {
  const me = useMe();
  // The (app) layout only renders children once `me` is loaded.
  const timezone = me.data?.tenant.timezone ?? 'UTC';
  return <AppointmentsView timezone={timezone} />;
}

function AppointmentsView({ timezone }: { timezone: string }) {
  const [startDate, setStartDate] = useState(() => toDateKey(new Date(), timezone));
  const [days, setDays] = useState(7);
  const [providerId, setProviderId] = useState('');
  const [status, setStatus] = useState<AppointmentStatus | ''>('');

  const range = useMemo(
    () => ({
      from: zonedTimeToUtc(startDate, '00:00', timezone),
      to: zonedTimeToUtc(addDays(startDate, days), '00:00', timezone),
    }),
    [startDate, days, timezone],
  );
  const providers = useProviders();
  const appointments = useAppointments({
    ...range,
    providerId: providerId || undefined,
    status: status || undefined,
  });

  const byDay = useMemo(() => {
    const groups = new Map<string, AppointmentDto[]>();
    for (const appt of appointments.data?.appointments ?? []) {
      const key = toDateKey(new Date(appt.startsAt), timezone);
      groups.set(key, [...(groups.get(key) ?? []), appt]);
    }
    return [...groups.entries()];
  }, [appointments.data, timezone]);

  return (
    <>
      <h1>Appointments</h1>
      <div className="toolbar">
        <label>
          From
          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              if (e.target.value) setStartDate(e.target.value);
            }}
          />
        </label>
        <label>
          Range
          <select
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
            }}
          >
            {RANGE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n === 1 ? '1 day' : `${String(n)} days`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider
          <select
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
            }}
          >
            <option value="">All providers</option>
            {providers.data?.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(e) => {
              const parsed = appointmentStatusSchema.safeParse(e.target.value);
              setStatus(parsed.success ? parsed.data : '');
            }}
          >
            <option value="">Any status</option>
            {appointmentStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', '-')}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {appointments.isFetching
            ? 'Refreshing…'
            : `${String(appointments.data?.appointments.length ?? 0)} appointments`}
        </span>
      </div>

      {appointments.isError && <p className="error">Could not load appointments.</p>}
      {appointments.data && byDay.length === 0 && (
        <p className="muted">No appointments in this range.</p>
      )}

      {byDay.map(([day, items]) => (
        <section key={day} className="day-group">
          <h2>{formatDateInZone(new Date(items[0]?.startsAt ?? day), timezone)}</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Patient</th>
                <th>Provider</th>
                <th>Visit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((appt) => (
                <tr key={appt.id} className={appt.status === 'cancelled' ? 'row-muted' : undefined}>
                  <td>
                    {formatTimeInZone(new Date(appt.startsAt), timezone)}{' '}
                    <span className="muted">· {appt.durationMin} min</span>
                  </td>
                  <td>
                    {appt.patient.firstName} {appt.patient.lastName}
                  </td>
                  <td>{appt.provider.displayName}</td>
                  <td>{appt.visitType.name}</td>
                  <td>
                    <StatusBadge status={appt.status} />
                    {appt.source === 'slotfill' && (
                      <span className="badge badge-slotfill">SlotFill</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
