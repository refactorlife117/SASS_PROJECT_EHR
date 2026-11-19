'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useLogout, useMe } from '@/hooks/useAuth';

/** SlotFill operator console. Platform admins only; clinic users are sent to their dashboard. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const me = useMe();
  const logout = useLogout();
  const role = me.data?.user.role;

  useEffect(() => {
    if (me.data === null) router.replace('/login');
    else if (role && role !== 'platform_admin') router.replace('/');
  }, [me.data, role, router]);

  if (me.isError) return <p className="app-main error">Could not reach the server.</p>;
  if (me.isPending || me.data === null || role !== 'platform_admin') {
    return <p className="app-main muted">Loading…</p>;
  }

  return (
    <>
      <header className="app-header">
        <nav className="app-nav">
          <strong>SlotFill admin</strong>
          <Link href="/admin">Clinics</Link>
        </nav>
        <span>
          <span className="muted">{me.data.user.email}</span>{' '}
          <button
            type="button"
            className="secondary"
            disabled={logout.isPending}
            onClick={() => {
              logout.mutate(undefined, {
                onSettled: () => {
                  router.replace('/login');
                },
              });
            }}
          >
            Sign out
          </button>
        </span>
      </header>
      <main className="app-main">{children}</main>
    </>
  );
}
