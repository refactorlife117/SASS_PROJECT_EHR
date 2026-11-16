'use client';

import {
  formatDateInZone,
  formatTimeInZone,
  toDateKey,
  toTimeKey,
  type DevEhrState,
} from '@slotfill/shared';
import { useState, type SubmitEvent } from 'react';
import { StatusBadge } from '@/components/StatusBadge';
import {
  useDevEhrCancel,
  useDevEhrCreate,
  useDevEhrMove,
  useDevEhrState,
  useDevEhrSyncNow,
} from '@/hooks/useDevEhr';
import { ApiError } from '@/lib/api';

const errorText = (error: unknown): string =>
  error instanceof ApiError && error.code === 'slot_unavailable'
    ? 'That time overlaps another appointment for this provider.'
    : 'Request failed.';

export function DevEhrPanel() {
  const state = useDevEhrState();
  const syncNow = useDevEhrSyncNow();

  if (state.isPending) return <p className="muted">Loading mock EHR…</p>;
  if (state.isError) return <p className="error">Could not load the mock EHR.</p>;
  const data = state.data;

  return (
    <>
      <h1>Mock EHR</h1>
      <p className="muted">
        Dev only. This is the clinic&apos;s fake EHR. Changes here are picked up by SlotFill&apos;s
        sync (instantly via a simulated webhook, or by the 2-minute sync job).
      </p>
      <div className="toolbar">
        <span>
          Last synced:{' '}
          <strong>
            {data.connection?.lastSyncedAt
              ? `${formatDateInZone(new Date(data.connection.lastSyncedAt), data.timezone)} ${formatTimeInZone(new Date(data.connection.lastSyncedAt), data.timezone)}`
              : 'never'}
          </strong>
          {data.connection?.lastError && (
            <span className="error"> · last error: {data.connection.lastError}</span>
          )}
        </span>
        <button
          type="button"
          className="secondary"
          disabled={syncNow.isPending}
          onClick={() => {
            syncNow.mutate();
          }}
        >
          Sync now
        </button>
      </div>
      <CreateForm data={data} />
      <ScheduleTable data={data} />
    </>
  );
}

function CreateForm({ data }: { data: DevEhrState }) {
  const create = useDevEhrCreate();
  const tomorrow = toDateKey(new Date(Date.now() + 86_400_000), data.timezone);
  const [form, setForm] = useState({
    patientId: data.patients[0]?.id ?? '',
    providerId: data.providers[0]?.id ?? '',
    visitTypeCode: data.visitTypes[0]?.code ?? '',
    date: tomorrow,
    time: '12:30',
  });
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
  };

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate(form);
  }

  return (
    <form className="inline-form" onSubmit={onSubmit}>
      <strong>New appointment</strong>
      <select value={form.patientId} onChange={set('patientId')} aria-label="Patient">
        {data.patients.map((p) => (
          <option key={p.id} value={p.id}>
            {p.lastName}, {p.firstName}
          </option>
        ))}
      </select>
      <select value={form.providerId} onChange={set('providerId')} aria-label="Provider">
        {data.providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
      </select>
      <select value={form.visitTypeCode} onChange={set('visitTypeCode')} aria-label="Visit type">
        {data.visitTypes.map((v) => (
          <option key={v.code} value={v.code}>
            {v.name} ({v.durationMin} min)
          </option>
        ))}
      </select>
      <input type="date" value={form.date} onChange={set('date')} aria-label="Date" />
      <input type="time" step={300} value={form.time} onChange={set('time')} aria-label="Time" />
      <button type="submit" disabled={create.isPending}>
        Create
      </button>
      {create.isError && <span className="error">{errorText(create.error)}</span>}
    </form>
  );
}

function ScheduleTable({ data }: { data: DevEhrState }) {
  const cancel = useDevEhrCancel();
  const move = useDevEhrMove();
  const [moving, setMoving] = useState<{ id: string; date: string; time: string } | null>(null);
  const providerNames = new Map(data.providers.map((p) => [p.id, p.displayName]));

  return (
    <>
      {move.isError && <p className="error">{errorText(move.error)}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Patient</th>
            <th>Provider</th>
            <th>Visit</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.appointments.map((appt) => {
            const startsAt = new Date(appt.startsAt);
            return (
              <tr key={appt.id} className={appt.status === 'cancelled' ? 'row-muted' : undefined}>
                <td>
                  {formatDateInZone(startsAt, data.timezone)}{' '}
                  {formatTimeInZone(startsAt, data.timezone)}
                </td>
                <td>{appt.patientName}</td>
                <td>{providerNames.get(appt.providerId)}</td>
                <td>
                  {appt.visitTypeCode} <span className="muted">· {appt.durationMin} min</span>
                </td>
                <td>
                  <StatusBadge status={appt.status} />
                </td>
                <td className="actions">
                  {moving?.id === appt.id ? (
                    <>
                      <input
                        type="date"
                        value={moving.date}
                        onChange={(e) => {
                          setMoving({ ...moving, date: e.target.value });
                        }}
                        aria-label="New date"
                      />
                      <input
                        type="time"
                        step={300}
                        value={moving.time}
                        onChange={(e) => {
                          setMoving({ ...moving, time: e.target.value });
                        }}
                        aria-label="New time"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          move.mutate(moving, {
                            onSuccess: () => {
                              setMoving(null);
                            },
                          });
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setMoving(null);
                        }}
                      >
                        ×
                      </button>
                    </>
                  ) : (
                    appt.status !== 'cancelled' &&
                    appt.status !== 'completed' && (
                      <>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            move.reset();
                            setMoving({
                              id: appt.id,
                              date: toDateKey(startsAt, data.timezone),
                              time: toTimeKey(startsAt, data.timezone),
                            });
                          }}
                        >
                          Move
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={cancel.isPending}
                          onClick={() => {
                            cancel.mutate(appt.id);
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    )
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
