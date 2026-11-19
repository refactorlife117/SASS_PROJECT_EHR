'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useLogout, useMe } from '@/hooks/useAuth';
import { devToolsEnabled } from '@/lib/dev-tools';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/appointments', label: 'Appointments' },
  { href: '/waitlist', label: 'Waitlist' },
  { href: '/offers', label: 'Offers' },
  { href: '/messages', label: 'Messages' },
  { href: '/settings', label: 'Settings' },
];
const OWNER_NAV = [{ href: '/team', label: 'Team' }];
const DEV_NAV = [
  { href: '/dev/ehr', label: 'Mock EHR' },
  { href: '/dev/phone', label: 'Phone sim' },
];

/** Signed-in shell: redirects to /login without a full (MFA-verified) session. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const logout = useLogout();

  const role = me.data?.user.role;
  useEffect(() => {
    if (me.data === null) router.replace('/login');
    // SlotFill's own operators have no clinic: their home is the admin console.
    else if (role === 'platform_admin') router.replace('/admin');
  }, [me.data, role, router]);

  if (me.isPending || me.data === null || role === 'platform_admin') {
    return <p className="app-main muted">Loading…</p>;
  }
  if (me.isError) return <p className="app-main error">Could not reach the server.</p>;

  const links = [
    ...NAV,
    ...(role === 'owner' ? OWNER_NAV : []),
    ...(devToolsEnabled ? DEV_NAV : []),
  ];
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
