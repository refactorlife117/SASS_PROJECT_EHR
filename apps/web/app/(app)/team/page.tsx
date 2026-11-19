'use client';

import { clinicRoleSchema, type ClinicRole, type TeamMember } from '@slotfill/shared';
import { useState, type SubmitEvent } from 'react';
import { useMe } from '@/hooks/useAuth';
import {
  useChangeRole,
  useInviteUser,
  useTeam,
  useTeamAction,
  type TeamAction,
} from '@/hooks/useTeam';
import { ApiError } from '@/lib/api';
import { TeamStatusBadge } from '@/components/TeamStatusBadge';

export default function TeamPage() {
  const me = useMe();
  if (me.data?.user.role !== 'owner') {
    return <p className="muted">Only clinic owners can manage the team.</p>;
  }
  return (
    <>
      <h1>Team</h1>
      <p className="muted">
        Owners manage settings and the team. Staff run the waitlist, offers and messages. Everyone
        signs in with a password and an authenticator app.
      </p>
      <InviteForm />
      <TeamTable />
    </>
  );
}

function InviteForm() {
  const invite = useInviteUser();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ClinicRole>('staff');

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
    <form className="panel inline-form" onSubmit={onSubmit}>
      <strong>Invite someone</strong>
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
        <option value="staff">Staff</option>
        <option value="owner">Owner</option>
      </select>
      <button type="submit" disabled={invite.isPending}>
        Send invite
      </button>
      {invite.isSuccess && <span className="muted">Invite emailed (link valid 7 days).</span>}
      {invite.isError && <span className="error">{errorText(invite.error)}</span>}
    </form>
  );
}

function TeamTable() {
  const team = useTeam();
  const changeRole = useChangeRole();
  const action = useTeamAction();
  if (team.isPending) return <p className="muted">Loading…</p>;
  if (team.isError) return <p className="error">Could not load the team.</p>;

  const run = (user: TeamMember, kind: TeamAction, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    action.mutate({ id: user.id, action: kind });
  };

  return (
    <>
      {(action.isError || changeRole.isError) && (
        <p className="error">{errorText(action.error ?? changeRole.error)}</p>
      )}
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
          {team.data.users.map((user) => (
            <tr key={user.id} className={user.status === 'disabled' ? 'row-muted' : undefined}>
              <td>
                {user.email}
                {user.isYou && <span className="muted"> (you)</span>}
              </td>
              <td>
                {user.isYou ? (
                  user.role
                ) : (
                  <select
                    value={user.role}
                    disabled={changeRole.isPending}
                    onChange={(e) => {
                      changeRole.mutate({
                        id: user.id,
                        role: clinicRoleSchema.parse(e.target.value),
                      });
                    }}
                  >
                    <option value="staff">staff</option>
                    <option value="owner">owner</option>
                  </select>
                )}
              </td>
              <td>
                <TeamStatusBadge status={user.status} />
              </td>
              <td>{user.mfaEnabled ? 'Set up' : 'Not yet'}</td>
              <td>
                {!user.isYou && (
                  <span className="toolbar">
                    {(user.status === 'invited' || user.status === 'invite_expired') && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          run(user, 'resend-invite');
                        }}
                      >
                        Resend invite
                      </button>
                    )}
                    {user.status === 'active' && user.mfaEnabled && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          run(
                            user,
                            'reset-mfa',
                            `Reset two-factor for ${user.email}? They will be signed out and must scan a new QR code at their next sign-in.`,
                          );
                        }}
                      >
                        Reset two-factor
                      </button>
                    )}
                    {user.status === 'disabled' ? (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          run(user, 'reactivate');
                        }}
                      >
                        Reactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          run(
                            user,
                            'deactivate',
                            `Deactivate ${user.email}? They will be signed out and can no longer sign in.`,
                          );
                        }}
                      >
                        Deactivate
                      </button>
                    )}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'email_taken') return 'That email address already has a SlotFill account.';
    if (error.code === 'validation_error') return 'Check the email address.';
    return error.message;
  }
  return 'Something went wrong.';
}
