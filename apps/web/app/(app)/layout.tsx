'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useLogout, useMe } from '@/hooks/useAuth';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/appointments', label: 'Appointments' },
];
const DEV_NAV = [{ href: '/dev/ehr', label: 'Mock EHR' }];
const isDev = process.env.NODE_ENV === 'development';

/** Signed-in shell: redirects to /login without a full (MFA-verified) session. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const logout = useLogout();

  useEffect(() => {
    if (me.data === null) router.replace('/login');
  }, [me.data, router]);

  if (me.isPending || me.data === null) return <p className="app-main muted">Loading…</p>;
  if (me.isError) return <p className="app-main error">Could not reach the server.</p>;

  const links = isDev ? [...NAV, ...DEV_NAV] : NAV;
  return (
    <>
      <header className="app-header">
        <nav className="app-nav">
          <strong>{me.data.tenant.name}</strong>
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={pathname === link.href ? 'active' : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <span>
          <span className="muted">
            {me.data.user.email} · {me.data.user.role}
          </span>{' '}
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
