'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useLogin } from '@/hooks/useAuth';
import { ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    login.mutate(
      { email, password },
      {
        onSuccess: (result) => {
          router.push(result.next === 'mfa_setup' ? '/mfa?step=setup' : '/mfa');
        },
      },
    );
  }

  const errorMessage =
    login.error instanceof ApiError && login.error.status === 429
      ? 'Too many attempts. Try again in a few minutes.'
      : login.error
        ? 'Invalid email or password.'
        : null;

  return (
    <main className="auth-card">
      <h1>SlotFill</h1>
      <p className="muted">Sign in to your clinic account.</p>
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
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </label>
        {errorMessage && <p className="error">{errorMessage}</p>}
        <button type="submit" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
