'use client';

import { formatDateInZone, formatTimeInZone, type OfferStatus } from '@slotfill/shared';
import { useState } from 'react';
import { useMe } from '@/hooks/useAuth';
import { useCancelOffer, useOffer, useOffers } from '@/hooks/useOffers';

const FILTERS: (OfferStatus | 'all')[] = ['open', 'filled', 'expired', 'cancelled', 'all'];
const STATUS_BADGE: Record<OfferStatus, string> = {
  open: 'badge-booked',
  filled: 'badge-confirmed',
  expired: 'badge-completed',
  cancelled: 'badge-cancelled',
};

export default function OffersPage() {
  const me = useMe();
  const timezone = me.data?.tenant.timezone ?? 'UTC';
  const [filter, setFilter] = useState<OfferStatus | 'all'>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const offers = useOffers(filter === 'all' ? undefined : filter);
  const when = (iso: string) => {
    const d = new Date(iso);
    return `${formatDateInZone(d, timezone)} ${formatTimeInZone(d, timezone)}`;
  };

  return (
    <>
      <h1>Offers</h1>
      <p className="muted">
        A cancelled slot becomes an offer that is texted to waitlisted patients in batches. The
        first YES gets it; their later appointment is freed and offered onward.
      </p>
      <div className="toolbar tabs">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={f === filter ? '' : 'secondary'}
            onClick={() => {
              setFilter(f);
              setSelected(null);
            }}
          >
            {f[0]?.toUpperCase()}
            {f.slice(1)}
          </button>
        ))}
      </div>
      {offers.isError && <p className="error">Could not load offers.</p>}
      {offers.data?.offers.length === 0 && (
        <p className="muted">No offers yet. Cancel an appointment on Mock EHR to create one.</p>
      )}
      <div className="split wide-right">
        {offers.data && offers.data.offers.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Texted</th>
              </tr>
            </thead>
            <tbody>
              {offers.data.offers.map((o) => (
                <tr
                  key={o.id}
                  className={o.id === selected ? 'row-selected clickable' : 'clickable'}
                  onClick={() => {
                    setSelected(o.id);
                  }}
                >
                  <td>
                    {when(o.startsAt)} <span className="muted">· {o.durationMin} min</span>
                  </td>
                  <td>{o.provider.displayName}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[o.status]}`}>{o.status}</span>
                    {o.filledBy && (
                      <span className="muted">
                        {' '}
                        {o.filledBy.firstName} {o.filledBy.lastName}
                      </span>
                    )}
                  </td>
                  <td>{o.recipientCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {selected && <OfferDetail id={selected} when={when} />}
      </div>
    </>
  );
}

function OfferDetail({ id, when }: { id: string; when: (iso: string) => string }) {
  const offer = useOffer(id);
  const cancel = useCancelOffer();
  if (!offer.data) return <section className="thread muted">Loading…</section>;
  const o = offer.data;

  return (
    <section className="thread">
      <header className="thread-header">
        <strong>
          {when(o.startsAt)} · {o.provider.displayName}
        </strong>
        <div className="muted">
          Original visit: {o.visitType.name} · created {when(o.createdAt)} · expires{' '}
          {when(o.expiresAt)}
          {o.cancelReason && ` · cancelled (${o.cancelReason.replaceAll('_', ' ')})`}
        </div>
        {o.status === 'open' && (
          <button
            type="button"
            className="danger"
            disabled={cancel.isPending}
            onClick={() => {
              cancel.mutate(o.id);
            }}
          >
            Cancel offer
          </button>
        )}
      </header>
      {o.recipients.length === 0 ? (
        <p className="muted">
          Nobody has been texted yet (no eligible waitlisted patients, or quiet hours).
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Batch</th>
              <th>Patient</th>
              <th>Texted</th>
              <th>Reply</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {o.recipients.map((r) => (
              <tr key={r.id}>
                <td>{r.batchNo}</td>
                <td>
                  {r.patient.firstName} {r.patient.lastName}
                </td>
                <td>{r.sentAt ? when(r.sentAt) : '—'}</td>
                <td>
                  {r.reply ?? <span className="muted">no reply</span>}
                  {r.repliedAt && <span className="muted"> · {when(r.repliedAt)}</span>}
                </td>
                <td>
                  {r.outcome === 'won' && <span className="badge badge-confirmed">booked</span>}
                  {r.outcome === 'too_late' && (
                    <span className="badge badge-completed">too late</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
