'use client';

import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiPostNoContent } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const request = useMutation({
    mutationFn: () => apiPostNoContent('/auth/password/forgot', { email }),
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    request.mutate();
  }

  return (
    <main className="auth-card">
      <h1>Reset password</h1>
      {request.isSuccess ? (
        <p>
          If that email has a SlotFill account, a reset link is on its way. It works once and
          expires in 30 minutes.
        </p>
      ) : (
        <form onSubmit={onSubmit}>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
          </label>
          {request.isError && (
            <p className="error">Something went wrong. Try again in a few minutes.</p>
          )}
          <button type="submit" disabled={request.isPending}>
            Email me a reset link
          </button>
        </form>
      )}
      <p className="muted">
        <Link href="/login">Back to sign in</Link>
      </p>
    </main>
  );
}
