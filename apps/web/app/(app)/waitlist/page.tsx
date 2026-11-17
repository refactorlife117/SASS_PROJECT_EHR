'use client';

import {
  formatDateInZone,
  formatTimeInZone,
  toDateKey,
  type PreferredWindow,
  type WaitlistEntryDto,
  type WaitlistStatus,
} from '@slotfill/shared';
import { useState, type SubmitEvent } from 'react';
import { useProviders } from '@/hooks/useAppointments';
import { useMe } from '@/hooks/useAuth';
import {
  useAddToWaitlist,
  usePatientSearch,
  useRemoveFromWaitlist,
  useUpdateWaitlist,
  useVisitTypes,
  useWaitlist,
} from '@/hooks/useWaitlist';
import { ApiError } from '@/lib/api';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUSES: WaitlistStatus[] = ['active', 'fulfilled', 'removed'];

const windowsLabel = (windows: PreferredWindow[] | null): string =>
  windows?.map((w) => `${w.dow.map((d) => DAYS[d]).join('/')} ${w.from}–${w.to}`).join('; ') ??
  'Any time';

export default function WaitlistPage() {
  const me = useMe();
  const timezone = me.data?.tenant.timezone ?? 'UTC';
  const [status, setStatus] = useState<WaitlistStatus>('active');
  const [adding, setAdding] = useState(false);
  const waitlist = useWaitlist(status);

  return (
    <>
      <h1>Waitlist</h1>
      <p className="muted">
        Patients here are texted (in batches, longest-waiting first) when a matching earlier slot
        opens. Patients can also join by replying EARLY to an invite.
      </p>
      <div className="toolbar">
        <div className="tabs">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={s === status ? '' : 'secondary'}
              onClick={() => {
                setStatus(s);
              }}
            >
              {s[0]?.toUpperCase()}
              {s.slice(1)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setAdding((a) => !a);
          }}
        >
          {adding ? 'Close' : 'Add patient'}
        </button>
      </div>

      {adding && (
        <AddPatient
          timezone={timezone}
          onDone={() => {
            setAdding(false);
          }}
        />
      )}

      {waitlist.isError && <p className="error">Could not load the waitlist.</p>}
      {waitlist.data?.entries.length === 0 && <p className="muted">No {status} entries.</p>}
      {waitlist.data && waitlist.data.entries.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Provider</th>
              <th>Visit</th>
              <th>Current appointment</th>
              <th>Earliest</th>
              <th>Preferred times</th>
              <th>Since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {waitlist.data.entries.map((e) => (
              <EntryRow key={e.id} entry={e} timezone={timezone} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function EntryRow({ entry: e, timezone }: { entry: WaitlistEntryDto; timezone: string }) {
  const providers = useProviders();
  const update = useUpdateWaitlist();
  const remove = useRemoveFromWaitlist();
  const [editing, setEditing] = useState(false);
  const [providerId, setProviderId] = useState(e.provider?.id ?? '');
  const [earliestDate, setEarliestDate] = useState(e.earliestDate);
  const current = e.currentAppointment ? new Date(e.currentAppointment.startsAt) : null;

  return (
    <tr>
      <td>
        {e.patient.firstName} {e.patient.lastName}
        {!e.patient.hasMobile && <span className="badge badge-cancelled">no mobile</span>}
        {e.source === 'sms_opt_in' && <span className="badge badge-slotfill">via SMS</span>}
      </td>
      <td>
        {editing ? (
          <select
            value={providerId}
            onChange={(ev) => {
              setProviderId(ev.target.value);
            }}
          >
            <option value="">Any provider</option>
            {providers.data?.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        ) : (
          (e.provider?.displayName ?? 'Any provider')
        )}
      </td>
      <td>{e.visitType.name}</td>
      <td>
        {current
          ? `${formatDateInZone(current, timezone)} ${formatTimeInZone(current, timezone)}`
          : '—'}
      </td>
      <td>
        {editing ? (
          <input
            type="date"
            value={earliestDate}
            onChange={(ev) => {
              setEarliestDate(ev.target.value);
            }}
          />
        ) : (
          e.earliestDate
        )}
      </td>
      <td>{windowsLabel(e.preferredWindows)}</td>
      <td>{formatDateInZone(new Date(e.createdAt), timezone)}</td>
      <td className="actions">
        {e.status === 'active' &&
          (editing ? (
            <>
              <button
                type="button"
                disabled={update.isPending}
                onClick={() => {
                  update.mutate(
                    { id: e.id, providerId: providerId || null, earliestDate },
                    {
                      onSuccess: () => {
                        setEditing(false);
                      },
                    },
                  );
                }}
              >
                Save
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing(false);
                }}
              >
                ×
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing(true);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="danger"
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate(e.id);
                }}
              >
                Remove
              </button>
            </>
          ))}
      </td>
    </tr>
  );
}

function AddPatient({ timezone, onDone }: { timezone: string; onDone: () => void }) {
  const [search, setSearch] = useState('');
  const [patientId, setPatientId] = useState<string | null>(null);
  const [appointmentId, setAppointmentId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [visitTypeId, setVisitTypeId] = useState('');
  const [earliestDate, setEarliestDate] = useState(() => toDateKey(new Date(), timezone));
  const [days, setDays] = useState<number[]>([]);
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('17:00');
  const results = usePatientSearch(search);
  const providers = useProviders();
  const visitTypes = useVisitTypes();
  const add = useAddToWaitlist();
  const patient = results.data?.patients.find((p) => p.id === patientId) ?? null;

  function pickAppointment(id: string) {
    setAppointmentId(id);
    const appt = patient?.upcomingAppointments.find((a) => a.id === id);
    if (appt) {
      setProviderId(appt.providerId);
      setVisitTypeId(appt.visitTypeId);
    }
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!patientId || !visitTypeId) return;
    add.mutate(
      {
        patientId,
        providerId: providerId || null,
        visitTypeId,
        currentAppointmentId: appointmentId || null,
        earliestDate,
        preferredWindows: days.length > 0 ? [{ dow: days, from, to }] : null,
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form className="panel" onSubmit={onSubmit}>
      <strong>Add a patient to the waitlist</strong>
      <label>
        Find patient
        <input
          placeholder="Type a name…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPatientId(null);
          }}
        />
      </label>
      {!patient && results.data && (
        <ul className="pick-list">
          {results.data.patients.length === 0 && <li className="muted">No matches.</li>}
          {results.data.patients.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setPatientId(p.id);
                  setSearch(`${p.firstName} ${p.lastName}`);
                }}
              >
                {p.lastName}, {p.firstName}
                <span className="muted">
                  {p.mobileLast4 ? ` · mobile …${p.mobileLast4}` : ' · no mobile'}
                  {` · ${String(p.upcomingAppointments.length)} upcoming`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {patient && (
        <div className="form-grid">
          <label>
            Their current appointment (moved if they take an earlier slot)
            <select
              value={appointmentId}
              onChange={(e) => {
                pickAppointment(e.target.value);
              }}
            >
              <option value="">None</option>
              {patient.upcomingAppointments.map((a) => (
                <option key={a.id} value={a.id}>
                  {formatDateInZone(new Date(a.startsAt), timezone)}{' '}
                  {formatTimeInZone(new Date(a.startsAt), timezone)} · {a.providerName} ·{' '}
                  {a.visitTypeName}
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
              <option value="">Any provider</option>
              {providers.data?.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Visit type
            <select
              required
              value={visitTypeId}
              onChange={(e) => {
                setVisitTypeId(e.target.value);
              }}
            >
              <option value="">Choose…</option>
              {visitTypes.data?.visitTypes.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.durationMin} min)
                </option>
              ))}
            </select>
          </label>
          <label>
            Earliest date
            <input
              type="date"
              value={earliestDate}
              onChange={(e) => {
                setEarliestDate(e.target.value);
              }}
            />
          </label>
          <fieldset>
            <legend>Preferred days (optional)</legend>
            {DAYS.map((d, i) => (
              <label key={d} className="inline">
                <input
                  type="checkbox"
                  checked={days.includes(i)}
                  onChange={(e) => {
                    setDays((prev) =>
                      e.target.checked ? [...prev, i].sort() : prev.filter((x) => x !== i),
                    );
                  }}
                />
                {d}
              </label>
            ))}
            {days.length > 0 && (
              <span>
                {' '}
                between{' '}
                <input
                  type="time"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                  }}
                />{' '}
                and{' '}
                <input
                  type="time"
                  value={to}
                  onChange={(e) => {
                    setTo(e.target.value);
                  }}
                />
              </span>
            )}
          </fieldset>
          <div>
            <button type="submit" disabled={add.isPending || !visitTypeId}>
              Add to waitlist
            </button>
          </div>
          {add.isError && (
            <p className="error">
              {add.error instanceof ApiError && add.error.code === 'already_waitlisted'
                ? 'This patient is already on the waitlist for that visit type.'
                : 'Could not add the patient.'}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
