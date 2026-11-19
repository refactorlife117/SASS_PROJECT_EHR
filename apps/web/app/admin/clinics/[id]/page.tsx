'use client';

import {
  adminUpdateClinicSchema,
  clinicRoleSchema,
  formatDateInZone,
  formatTimeInZone,
  type AdminClinicDetail,
  type ClinicRole,
} from '@slotfill/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { TeamStatusBadge } from '@/components/TeamStatusBadge';
import {
  useAdminClinic,
  useAdminInviteUser,
  useAdminResendInvite,
  useUpdateClinic,
} from '@/hooks/useAdmin';
import { ApiError } from '@/lib/api';
import { US_TIME_ZONES } from '../../time-zones';

const smsProviderSchema = adminUpdateClinicSchema.shape.smsProvider;

export default function AdminClinicPage() {
  const { id } = useParams<{ id: string }>();
  const clinic = useAdminClinic(id);
  if (clinic.isPending) return <p className="muted">Loading…</p>;
  if (clinic.isError) {
    return (
      <p className="error">
        {clinic.error instanceof ApiError && clinic.error.status === 404
          ? 'Clinic not found.'
          : 'Could not load the clinic.'}{' '}
        <Link href="/admin">Back to clinics</Link>
      </p>
    );
  }
  const { data } = clinic;
  return (
    <>
      <p>
        <Link href="/admin">← Clinics</Link>
      </p>
      <h1>{data.clinic.name}</h1>
      <p className="muted">
        Added {formatDateInZone(new Date(data.clinic.createdAt), data.clinic.timezone)} ·{' '}
        <EhrLine data={data} />
      </p>
      <ClinicForm data={data} />
      <Users data={data} />
    </>
  );
}

function EhrLine({ data }: { data: AdminClinicDetail }) {
  if (!data.ehr) return <>EHR not connected yet (the owner connects it from Settings)</>;
  const synced = data.ehr.lastSyncedAt ? new Date(data.ehr.lastSyncedAt) : null;
  const zone = data.clinic.timezone;
  return (
    <>
      EHR {data.ehr.type} ({data.ehr.status})
      {synced &&
        `, last synced ${formatDateInZone(synced, zone)} ${formatTimeInZone(synced, zone)}`}
    </>
  );
}

function ClinicForm({ data }: { data: AdminClinicDetail }) {
  const update = useUpdateClinic(data.clinic.id);
  const [form, setForm] = useState({
    name: data.clinic.name,
    timezone: data.clinic.timezone,
    contactPhone: data.clinic.contactPhone ?? '',
    smsNumber: data.clinic.smsNumber ?? '',
    smsProvider: data.clinic.smsProvider ?? '',
  });
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
    },
  });
  const zones = US_TIME_ZONES.some((z) => z.value === form.timezone)
    ? US_TIME_ZONES
    : [...US_TIME_ZONES, { value: form.timezone, label: form.timezone }];

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    update.mutate({
      name: form.name,
      timezone: form.timezone,
      contactPhone: form.contactPhone,
      smsNumber: form.smsNumber.trim() || null,
      ...(data.availableSmsProviders.length > 1
        ? { smsProvider: smsProviderSchema.parse(form.smsProvider || null) }
        : {}),
    });
  }

  return (
    <form className="panel form-grid" onSubmit={onSubmit}>
      <strong>Clinic details</strong>
      <label>
        Clinic name
        <input required maxLength={120} {...field('name')} />
      </label>
      <label>
        Time zone
        <select {...field('timezone')}>
          {zones.map((zone) => (
            <option key={zone.value} value={zone.value}>
              {zone.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Clinic phone (shown in HELP replies)
        <input maxLength={30} {...field('contactPhone')} />
      </label>
      <label>
        Texting number (E.164, e.g. +15550100001; leave empty until registered)
        <input {...field('smsNumber')} />
      </label>
      {data.availableSmsProviders.length > 1 && (
        <label>
          SMS provider (each must be covered by a signed BAA)
          <select {...field('smsProvider')}>
            <option value="">Default ({data.defaultSmsProvider})</option>
            {data.availableSmsProviders.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )}
      <div>
        <button type="submit" disabled={update.isPending}>
          Save
        </button>{' '}
        {update.isSuccess && <span className="muted">Saved.</span>}
      </div>
      {update.isError && (
        <p className="error">
          {update.error instanceof ApiError && update.error.code === 'sms_number_taken'
            ? 'That texting number belongs to another clinic.'
            : update.error instanceof ApiError && update.error.code === 'validation_error'
              ? 'Check the fields: texting numbers look like +15550100001.'
              : 'Could not save.'}
        </p>
      )}
    </form>
  );
}

function Users({ data }: { data: AdminClinicDetail }) {
  const invite = useAdminInviteUser(data.clinic.id);
  const resend = useAdminResendInvite(data.clinic.id);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ClinicRole>('owner');

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    invite.mutate(
      { email, role },
      {
        onSuccess: () => {
          setEmail('');
        },
      },
    );
  }

  return (
    <>
      <h2>Users</h2>
      <p className="muted">
        The clinic&apos;s owners manage their own team from the Team page. Use this to add a
        replacement owner, or to resend an invite.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Two-factor</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.users.map((user) => (
            <tr key={user.id} className={user.status === 'disabled' ? 'row-muted' : undefined}>
              <td>{user.email}</td>
              <td>{user.role}</td>
              <td>
                <TeamStatusBadge status={user.status} />
              </td>
              <td>{user.mfaEnabled ? 'Set up' : 'Not yet'}</td>
              <td>
                {(user.status === 'invited' || user.status === 'invite_expired') && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={resend.isPending}
                    onClick={() => {
                      resend.mutate(user.id);
                    }}
                  >
                    Resend invite
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="panel inline-form" onSubmit={onSubmit}>
        <strong>Invite a user</strong>
        <input
          type="email"
          required
          placeholder="name@clinic.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
        />
        <select
          value={role}
          onChange={(e) => {
            setRole(clinicRoleSchema.parse(e.target.value));
          }}
        >
          <option value="owner">Owner</option>
          <option value="staff">Staff</option>
        </select>
        <button type="submit" disabled={invite.isPending}>
          Send invite
        </button>
        {invite.isSuccess && <span className="muted">Invite emailed.</span>}
        {invite.isError && (
          <span className="error">
            {invite.error instanceof ApiError && invite.error.code === 'email_taken'
              ? 'That email address already has a SlotFill account.'
              : 'Could not send the invite.'}
          </span>
        )}
        {resend.isSuccess && <span className="muted">Invite resent.</span>}
      </form>
    </>
  );
}
