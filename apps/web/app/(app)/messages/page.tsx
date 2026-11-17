'use client';

import type { MessageDto } from '@slotfill/shared';
import { useMemo, useState } from 'react';
import { MessageBubble } from '@/components/MessageBubble';
import { useMe } from '@/hooks/useAuth';
import { useMessages, useNeedsAttention, useResolveMessage } from '@/hooks/useMessages';

const CONTEXT_LABELS: Record<string, string> = {
  reminder: 'Reminder',
  offer: 'Offer',
  waitlist_invite: 'Waitlist invite',
  system: 'System',
};

const patientLabel = (m: Pick<MessageDto, 'patients' | 'mobileE164'>): string =>
  m.patients.length > 0
    ? m.patients.map((p) => `${p.firstName} ${p.lastName}`).join(', ')
    : 'Unknown number';

export default function MessagesPage() {
  const me = useMe();
  const timezone = me.data?.tenant.timezone ?? 'UTC';
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const all = useMessages();
  const attention = useNeedsAttention();
  const resolve = useResolveMessage();

  // One row per number, newest conversation first.
  const conversations = useMemo(() => {
    const source = filter === 'all' ? all.data?.messages : attention.data?.messages;
    const latest = new Map<string, MessageDto & { flagged: number }>();
    for (const m of source ?? []) {
      const existing = latest.get(m.mobileE164);
      if (existing) existing.flagged += m.needsAttention ? 1 : 0;
      else latest.set(m.mobileE164, { ...m, flagged: m.needsAttention ? 1 : 0 });
    }
    return [...latest.values()];
  }, [filter, all.data, attention.data]);

  const active = selected ?? conversations[0]?.mobileE164 ?? null;

  return (
    <>
      <h1>Messages</h1>
      <div className="toolbar">
        <div className="tabs">
          <button
            type="button"
            className={filter === 'all' ? '' : 'secondary'}
            onClick={() => {
              setFilter('all');
            }}
          >
            All conversations
          </button>
          <button
            type="button"
            className={filter === 'attention' ? '' : 'secondary'}
            onClick={() => {
              setFilter('attention');
              setSelected(null);
            }}
          >
            Needs attention ({attention.data?.messages.length ?? 0})
          </button>
        </div>
      </div>

      {(all.isError || attention.isError) && <p className="error">Could not load messages.</p>}

      <div className="split">
        <ul className="conversation-list">
          {conversations.length === 0 && <li className="muted">No conversations.</li>}
          {conversations.map((c) => (
            <li key={c.mobileE164}>
              <button
                type="button"
                className={`conversation ${c.mobileE164 === active ? 'active' : ''}`}
                onClick={() => {
                  setSelected(c.mobileE164);
                }}
              >
                <strong>{patientLabel(c)}</strong>
                {c.flagged > 0 && (
                  <span className="badge badge-cancelled">{c.flagged} to review</span>
                )}
                <span className="muted snippet">{c.body}</span>
              </button>
            </li>
          ))}
        </ul>
        {active && (
          <Thread
            mobile={active}
            timezone={timezone}
            onResolve={(id) => {
              resolve.mutate(id);
            }}
          />
        )}
      </div>
    </>
  );
}

function Thread(props: { mobile: string; timezone: string; onResolve: (id: string) => void }) {
  const thread = useMessages({ mobile: props.mobile });
  const messages = [...(thread.data?.messages ?? [])].reverse();
  const first = messages[0];

  return (
    <section className="thread">
      <header className="thread-header">
        <strong>{first ? patientLabel(first) : '…'}</strong>
        {first && first.patients.length > 1 && (
          <span className="muted"> · shared number ({first.patients.length} patients)</span>
        )}
      </header>
      <div className="thread-body">
        {messages.map((m) => (
          <div key={m.id}>
            <MessageBubble
              body={m.body}
              createdAt={m.createdAt}
              timezone={props.timezone}
              side={m.direction === 'outbound' ? 'mine' : 'theirs'}
              status={m.status}
              note={[m.contextType ? CONTEXT_LABELS[m.contextType] : null, m.failureReason]
                .filter(Boolean)
                .join(' · ')}
            />
            {m.needsAttention && (
              <div className="attention-row">
                <span className="badge badge-cancelled">Needs attention</span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    props.onResolve(m.id);
                  }}
                >
                  Mark handled
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
