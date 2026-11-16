'use client';

import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import QRCode from 'qrcode';
import { Suspense, useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useMfaSetup, useMfaVerify } from '@/hooks/useAuth';
import { ApiError } from '@/lib/api';

export default function MfaPage() {
  return (
    <main className="auth-card">
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <MfaStep />
      </Suspense>
    </main>
  );
}

function MfaStep() {
  const router = useRouter();
  const isSetup = useSearchParams().get('step') === 'setup';
  const setup = useMfaSetup();
  const verify = useMfaVerify();
  const [code, setCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const setupStarted = useRef(false);

  // Enrollment: fetch a fresh secret once and render it as a QR code.
  const { mutate: startSetup } = setup;
  useEffect(() => {
    if (!isSetup || setupStarted.current) return;
    setupStarted.current = true;
    startSetup(undefined, {
      onSuccess: (data) => {
        void QRCode.toDataURL(data.otpauthUrl, { width: 200, margin: 1 }).then(setQrDataUrl);
      },
    });
  }, [isSetup, startSetup]);

  const sessionGone =
    (setup.error instanceof ApiError && setup.error.status === 401) ||
    (verify.error instanceof ApiError && verify.error.code === 'unauthenticated');
  useEffect(() => {
    if (sessionGone) router.replace('/login');
  }, [sessionGone, router]);

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    verify.mutate(
      { code },
      {
        onSuccess: () => {
          router.replace('/');
        },
      },
    );
  }

  return (
    <>
      <h1>{isSetup ? 'Set up two-factor authentication' : 'Two-factor authentication'}</h1>
      {isSetup ? (
        <>
          <p className="muted">
            Scan this QR code with an authenticator app (Google Authenticator, 1Password, Authy…),
            then enter the 6-digit code it shows.
          </p>
          {qrDataUrl && (
            <Image src={qrDataUrl} alt="MFA QR code" width={200} height={200} unoptimized />
          )}
          {setup.data && (
            <p className="muted">
              Can’t scan? Enter this key manually:{' '}
              <span className="secret">{setup.data.secret}</span>
            </p>
          )}
          {setup.isError && !sessionGone && <p className="error">Could not start MFA setup.</p>}
        </>
      ) : (
        <p className="muted">Enter the 6-digit code from your authenticator app.</p>
      )}
      <form onSubmit={onSubmit}>
        <label>
          Code
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, ''));
            }}
          />
        </label>
        {verify.isError && !sessionGone && (
          <p className="error">
            {verify.error instanceof ApiError && verify.error.status === 429
              ? 'Too many attempts. Try again in a few minutes.'
              : 'That code didn’t work. Try the current code.'}
          </p>
        )}
        <button type="submit" disabled={verify.isPending || code.length !== 6}>
          {verify.isPending ? 'Verifying…' : 'Verify'}
        </button>
      </form>
    </>
  );
}
