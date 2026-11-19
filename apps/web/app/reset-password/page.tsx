'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type SubmitEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, apiPostNoContent } from '@/lib/api';

export default function ResetPasswordPage() {
  return (
    <main className="auth-card">
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <ResetForm />
      </Suspense>
    </main>
  );
}

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  // Invites reuse the reset flow: same single-use link, friendlier wording.
  const isInvite = params.get('invite') === '1';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const reset = useMutation({
    mutationFn: () => apiPostNoContent('/auth/password/reset', { token, password }),
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password === confirm) reset.mutate();
  }

  if (reset.isSuccess) {
    return isInvite ? (
      <>
        <h1>Welcome to SlotFill</h1>
        <p>
          Your password is set. <Link href="/login">Sign in</Link>, then scan the QR code with an
          authenticator app (Google Authenticator, Microsoft Authenticator, Authy…) to finish.
        </p>
      </>
    ) : (
      <>
        <h1>Choose a new password</h1>
        <p>
          Password changed. You&apos;ve been signed out everywhere.{' '}
          <Link href="/login">Sign in</Link> with the new password (you&apos;ll still need your
          authenticator code).
        </p>
      </>
    );
  }
  return (
    <form onSubmit={onSubmit}>
      <h1>{isInvite ? 'Welcome to SlotFill: choose your password' : 'Choose a new password'}</h1>
      <label>
        New password (at least 12 characters)
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
      </label>
      <label>
        Repeat it
        <input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
          }}
        />
      </label>
      {confirm && password !== confirm && <p className="error">The passwords don&apos;t match.</p>}
      {reset.isError && (
        <p className="error">
          {reset.error instanceof ApiError && reset.error.code === 'invalid_reset_token'
            ? isInvite
              ? 'This invite link is invalid or has expired. Ask your clinic owner to resend it.'
              : 'This link is invalid or has expired. Request a new one.'
            : 'Could not change the password.'}
        </p>
      )}
      <button type="submit" disabled={reset.isPending || !token || password !== confirm}>
        Set password
      </button>
      <p className="muted">
        <Link href="/forgot-password">Request a new link</Link>
      </p>
    </form>
  );
}
