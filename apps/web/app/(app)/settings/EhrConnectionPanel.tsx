'use client';

import {
  ehrAuthorizeResponseSchema,
  ehrConnectionResponseSchema,
  formatDateInZone,
  formatTimeInZone,
} from '@slotfill/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { apiGet, apiPost } from '@/lib/api';

const EHR_NAMES: Record<string, string> = { mock: 'Mock EHR (demo)', drchrono: 'DrChrono' };

/** Shows the clinic's EHR connection; owners can connect DrChrono (OAuth). */
export function EhrConnectionPanel({ timezone }: { timezone: string }) {
  const outcome = useSearchParams().get('ehr');
  const status = useQuery({
    queryKey: ['ehr-connection'],
    queryFn: () => apiGet('/ehr/connection', ehrConnectionResponseSchema),
    refetchInterval: 15_000,
  });
  const connect = useMutation({
    mutationFn: () => apiPost('/ehr/drchrono/authorize', ehrAuthorizeResponseSchema),
    onSuccess: ({ authorizeUrl }) => {
      window.location.assign(authorizeUrl);
    },
  });
  const data = status.data;
  const connection = data?.connection;

  return (
    <section className="panel">
      <strong>EHR connection</strong>
      {outcome === 'connected' && (
        <p className="muted">Connected. The first full sync is running.</p>
      )}
      {outcome === 'error' && (
        <p className="error">The EHR connection didn&apos;t complete. Please try again.</p>
      )}
      {connection ? (
        <p>
          {EHR_NAMES[connection.ehrType] ?? connection.ehrType} · {connection.status}
          {' · last synced '}
          {connection.lastSyncedAt
            ? `${formatDateInZone(new Date(connection.lastSyncedAt), timezone)} ${formatTimeInZone(new Date(connection.lastSyncedAt), timezone)}`
            : 'never'}
          {connection.lastError && (
            <span className="error"> · last error: {connection.lastError}</span>
          )}
        </p>
      ) : (
        <p className="muted">No EHR connected yet.</p>
      )}
      {data?.canEdit && data.available.includes('drchrono') && (
        <div>
          <button
            type="button"
            disabled={connect.isPending}
            onClick={() => {
              connect.mutate();
            }}
          >
            {connection?.ehrType === 'drchrono' ? 'Reconnect DrChrono' : 'Connect DrChrono'}
          </button>
          <p className="muted">
            You&apos;ll sign in to DrChrono and approve access. SlotFill then copies doctors,
            appointment profiles, patients and the next 60 days of appointments, and keeps them in
            sync.
          </p>
        </div>
      )}
      {data && data.available.length === 0 && (
        <p className="muted">
          No real EHR integration is configured on this server (see docs/USAGE.md, Phase 8).
        </p>
      )}
    </section>
  );
}
