'use client';

import { settingsUpdateSchema, type SettingsResponse, type SettingsUpdate } from '@slotfill/shared';

const smsProviderSchema = settingsUpdateSchema.shape.smsProvider;
import { Suspense, useState, type SubmitEvent } from 'react';
import { useMe } from '@/hooks/useAuth';
import { useSettings, useUpdateSettings, useUpdateVisitTypeValue } from '@/hooks/useDashboard';
import { useVisitTypes } from '@/hooks/useWaitlist';
import { EhrConnectionPanel } from './EhrConnectionPanel';

export default function SettingsPage() {
  const settings = useSettings();
  const timezone = useMe().data?.tenant.timezone ?? 'UTC';
  if (settings.isPending) return <p className="muted">Loading…</p>;
  if (settings.isError) return <p className="error">Could not load settings.</p>;
  return (
    <>
      <h1>Settings</h1>
      {!settings.data.canEdit && <p className="muted">Only clinic owners can change settings.</p>}
      <Suspense fallback={null}>
        <EhrConnectionPanel timezone={timezone} />
      </Suspense>
      <SettingsForm data={settings.data} />
      <VisitTypeValues canEdit={settings.data.canEdit} />
    </>
  );
}

function SettingsForm({ data }: { data: SettingsResponse }) {
  const update = useUpdateSettings();
  const s = data.settings;
  const [form, setForm] = useState({
    contactPhone: data.clinic.contactPhone ?? '',
    smsProvider: data.clinic.smsProvider ?? '',
    reminderHoursBefore: s.reminderHoursBefore.join(', '),
    offerBatchSize: String(s.offerBatchSize),
    offerBatchTimeoutMin: String(s.offerBatchTimeoutMin),
    minNoticeMin: String(s.minNoticeMin),
    backfillHorizonDays: String(s.backfillHorizonDays),
    quietHoursStart: s.quietHoursStart,
    quietHoursEnd: s.quietHoursEnd,
    autoWaitlistInvite: s.autoWaitlistInvite,
    autoWaitlistMinDaysOut: String(s.autoWaitlistMinDaysOut),
  });
  const disabled = !data.canEdit;
  const field = (key: Exclude<keyof typeof form, 'autoWaitlistInvite'>) => ({
    value: form[key],
    disabled,
    onChange: (e: { target: { value: string } }) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
    },
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const body: SettingsUpdate = {
      contactPhone: form.contactPhone.trim() || null,
      ...(data.clinic.availableSmsProviders.length > 1
        ? { smsProvider: smsProviderSchema.parse(form.smsProvider || null) }
        : {}),
      reminderHoursBefore: form.reminderHoursBefore
        .split(',')
        .map((h) => Number(h.trim()))
        .filter((h) => h > 0),
      offerBatchSize: Number(form.offerBatchSize),
      offerBatchTimeoutMin: Number(form.offerBatchTimeoutMin),
      minNoticeMin: Number(form.minNoticeMin),
      backfillHorizonDays: Number(form.backfillHorizonDays),
      quietHoursStart: form.quietHoursStart,
      quietHoursEnd: form.quietHoursEnd,
      autoWaitlistInvite: form.autoWaitlistInvite,
      autoWaitlistMinDaysOut: Number(form.autoWaitlistMinDaysOut),
    };
    update.mutate(body);
  }

  return (
    <form className="panel form-grid" onSubmit={onSubmit}>
      <strong>
        {data.clinic.name}{' '}
        <span className="muted">
          · {data.clinic.timezone} · texts from {data.clinic.smsNumber ?? '(no number)'}
        </span>
      </strong>
      <label>
        Clinic phone (shown in HELP replies)
        <input {...field('contactPhone')} placeholder="(555) 010-0001" />
      </label>
      {data.clinic.availableSmsProviders.length > 1 && (
        <label>
          SMS provider (each must be covered by a signed BAA)
          <select {...field('smsProvider')}>
            <option value="">Default ({data.clinic.defaultSmsProvider})</option>
            {data.clinic.availableSmsProviders.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset>
        <legend>Reminders</legend>
        <label>
          Send reminders this many hours before (comma-separated, up to 4)
          <input {...field('reminderHoursBefore')} />
        </label>
      </fieldset>
      <fieldset>
        <legend>Filling cancelled slots</legend>
        <label>
          Patients texted per batch
          <input type="number" min={1} max={20} {...field('offerBatchSize')} />
        </label>
        <label>
          Minutes before texting the next batch
          <input type="number" min={1} max={240} {...field('offerBatchTimeoutMin')} />
        </label>
        <label>
          Don&apos;t offer slots starting sooner than (minutes)
          <input type="number" min={0} max={2880} {...field('minNoticeMin')} />
        </label>
        <label>
          Don&apos;t offer slots further out than (days)
          <input type="number" min={1} max={60} {...field('backfillHorizonDays')} />
        </label>
      </fieldset>
      <fieldset>
        <legend>Quiet hours (clinic time, no texts)</legend>
        <label className="inline">
          From <input type="time" {...field('quietHoursStart')} />
        </label>
        <label className="inline">
          until <input type="time" {...field('quietHoursEnd')} />
        </label>
        <span className="muted"> Same start and end = no quiet hours.</span>
      </fieldset>
      <fieldset>
        <legend>Waitlist invites</legend>
        <label className="inline">
          <input
            type="checkbox"
            checked={form.autoWaitlistInvite}
            disabled={disabled}
            onChange={(e) => {
              setForm((f) => ({ ...f, autoWaitlistInvite: e.target.checked }));
            }}
          />
          Text &quot;Reply EARLY&quot; invites
        </label>
        <label>
          …for appointments booked at least this many days ahead
          <input type="number" min={1} max={90} {...field('autoWaitlistMinDaysOut')} />
        </label>
      </fieldset>
      {data.canEdit && (
        <div>
          <button type="submit" disabled={update.isPending}>
            Save settings
          </button>{' '}
          {update.isSuccess && <span className="muted">Saved.</span>}
          {update.isError && <span className="error">Could not save. Check the values.</span>}
        </div>
      )}
    </form>
  );
}

function VisitTypeValues({ canEdit }: { canEdit: boolean }) {
  const visitTypes = useVisitTypes();
  const update = useUpdateVisitTypeValue();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  return (
    <section className="panel">
      <strong>Visit values</strong>
      <p className="muted">
        What each visit type is worth; used for &quot;revenue recovered&quot;.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Visit type</th>
            <th>Length</th>
            <th>Value (USD)</th>
          </tr>
        </thead>
        <tbody>
          {visitTypes.data?.visitTypes.map((v) => (
            <tr key={v.id}>
              <td>{v.name}</td>
              <td>{v.durationMin} min</td>
              <td className="actions">
                <input
                  type="number"
                  min={0}
                  step="1"
                  disabled={!canEdit}
                  value={drafts[v.id] ?? String(v.estimatedValueCents / 100)}
                  onChange={(e) => {
                    setDrafts((d) => ({ ...d, [v.id]: e.target.value }));
                  }}
                />
                {canEdit && drafts[v.id] !== undefined && (
                  <button
                    type="button"
                    disabled={update.isPending}
                    onClick={() => {
                      update.mutate(
                        { id: v.id, estimatedValueCents: Math.round(Number(drafts[v.id]) * 100) },
                        {
                          onSuccess: () => {
                            setDrafts(({ [v.id]: _done, ...rest }) => rest);
                          },
                        },
                      );
                    }}
                  >
                    Save
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
