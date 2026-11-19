'use client';

import { formatDateInZone, formatTimeInZone, type AdminClinicSummary } from '@slotfill/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useAdminClinics, useCreateClinic } from '@/hooks/useAdmin';
import { ApiError } from '@/lib/api';
import { US_TIME_ZONES } from './time-zones';

export default function AdminClinicsPage() {
  const clinics = useAdminClinics();
  return (
    <>
      <h1>Clinics</h1>
      <CreateClinicForm />
      {clinics.isPending && <p className="muted">Loading…</p>}
      {clinics.isError && <p className="error">Could not load clinics.</p>}
      {clinics.data && clinics.data.clinics.length === 0 && (
        <p className="muted">No clinics yet. Add the first one above.</p>
      )}
      {clinics.data && clinics.data.clinics.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Clinic</th>
              <th>Texting number</th>
              <th>Users</th>
              <th>EHR</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {clinics.data.clinics.map((clinic) => (
              <tr key={clinic.id}>
                <td>
                  <Link href={`/admin/clinics/${clinic.id}`}>{clinic.name}</Link>
                  <div className="muted">{clinic.timezone}</div>
                </td>
                <td>{clinic.smsNumber ?? <span className="muted">Not assigned</span>}</td>
                <td>
                  {clinic.activeUsers} active
                  {clinic.invitedUsers > 0 && (
                    <span className="muted"> · {clinic.invitedUsers} invited</span>
                  )}
                </td>
                <td>
                  <EhrSummary clinic={clinic} />
                </td>
                <td>{formatDateInZone(new Date(clinic.createdAt), clinic.timezone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function EhrSummary({ clinic }: { clinic: AdminClinicSummary }) {
  if (!clinic.ehr) return <span className="muted">Not connected</span>;
  const synced = clinic.ehr.lastSyncedAt ? new Date(clinic.ehr.lastSyncedAt) : null;
  return (
    <>
      {clinic.ehr.type} · {clinic.ehr.status}
      {synced && (
        <div className="muted">
          synced {formatDateInZone(synced, clinic.timezone)}{' '}
          {formatTimeInZone(synced, clinic.timezone)}
        </div>
      )}
    </>
  );
}

function CreateClinicForm() {
  const router = useRouter();
  const create = useCreateClinic();
  const [form, setForm] = useState({
    name: '',
    timezone: 'America/New_York',
    contactPhone: '',
    smsNumber: '',
    ownerEmail: '',
  });
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
    },
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate(
      {
        name: form.name,
        timezone: form.timezone,
        contactPhone: form.contactPhone,
        smsNumber: form.smsNumber.trim() || null,
        ownerEmail: form.ownerEmail,
      },
      {
        onSuccess: ({ clinicId }) => {
          router.push(`/admin/clinics/${clinicId}`);
        },
      },
    );
  }

  return (
    <form className="panel form-grid" onSubmit={onSubmit}>
      <strong>Add a clinic</strong>
      <p className="muted">
        Sign the clinic&apos;s Business Associate Agreement first. The owner gets an email invite to
        choose a password and set up two-factor; they then connect their EHR from Settings.
      </p>
      <label>
        Clinic name
        <input required maxLength={120} {...field('name')} />
      </label>
      <label>
        Time zone
        <select {...field('timezone')}>
          {US_TIME_ZONES.map((zone) => (
            <option key={zone.value} value={zone.value}>
              {zone.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Owner&apos;s email
        <input type="email" required {...field('ownerEmail')} />
      </label>
      <label>
        Clinic phone (shown in HELP replies, optional)
        <input maxLength={30} placeholder="(555) 010-0001" {...field('contactPhone')} />
      </label>
      <label>
        Texting number (optional; add it once carrier registration is done)
        <input placeholder="+15550100001" {...field('smsNumber')} />
      </label>
      <div>
        <button type="submit" disabled={create.isPending}>
          Create clinic and invite owner
        </button>
      </div>
      {create.isError && <p className="error">{createErrorText(create.error)}</p>}
    </form>
  );
}

function createErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'email_taken') return 'That owner email already has a SlotFill account.';
    if (error.code === 'sms_number_taken') return 'That texting number belongs to another clinic.';
    if (error.code === 'validation_error') {
      return 'Check the fields: texting numbers look like +15550100001.';
    }
    return error.message;
  }
  return 'Could not create the clinic.';
}
