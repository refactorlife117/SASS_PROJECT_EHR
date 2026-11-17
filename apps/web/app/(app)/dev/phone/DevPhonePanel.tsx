'use client';

import { useMemo, useState, type SubmitEvent } from 'react';
import { MessageBubble } from '@/components/MessageBubble';
import { useMe } from '@/hooks/useAuth';
import { useDevConversations, useDevSendReply, useDevSendTest } from '@/hooks/useDevPhone';

const QUICK_REPLIES = ['1', '2', 'YES', 'EARLY', 'STOP', 'START', 'HELP'];

export function DevPhonePanel() {
  const me = useMe();
  const timezone = me.data?.tenant.timezone ?? 'UTC';
  const conversations = useDevConversations();
  const sendReply = useDevSendReply();
  const sendTest = useDevSendTest();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');

  const phones = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (conversations.data?.phones ?? []).filter(
      (p) =>
        !term ||
        p.mobileE164.includes(term) ||
        p.patientNames.some((n) => n.toLowerCase().includes(term)),
    );
  }, [conversations.data, search]);
  const active =
    conversations.data?.phones.find((p) => p.mobileE164 === selected) ?? phones[0] ?? null;

  function send(body: string) {
    if (!active || !body.trim()) return;
    sendReply.mutate({ from: active.mobileE164, body });
    setDraft('');
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    send(draft);
  }

  if (conversations.isPending) return <p className="muted">Loading phones…</p>;
  if (conversations.isError) return <p className="error">Could not load conversations.</p>;

  return (
    <>
      <h1>Phone simulator</h1>
      <p className="muted">
        Dev only. Each entry is a simulated patient phone texting the clinic number{' '}
        <strong>{conversations.data.clinicNumber ?? '(none set)'}</strong>. Outbound texts also land
        in Mailpit (http://localhost:8025). Replies go through the real inbound pipeline.
      </p>
      <div className="split">
        <div>
          <input
            className="search"
            placeholder="Search name or number"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
            }}
          />
          <ul className="conversation-list">
            {phones.map((p) => (
              <li key={p.mobileE164}>
                <button
                  type="button"
                  className={`conversation ${p.mobileE164 === active?.mobileE164 ? 'active' : ''}`}
                  onClick={() => {
                    setSelected(p.mobileE164);
                  }}
                >
                  <strong>{p.patientNames.join(', ') || 'Unknown'}</strong>
                  {p.optedOut && <span className="badge badge-cancelled">opted out</span>}
                  <span className="muted snippet">
                    {p.mobileE164}
                    {p.messages.length > 0 && ` · ${String(p.messages.length)} msgs`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {active && (
          <section className="thread phone">
            <header className="thread-header">
              <strong>{active.patientNames.join(', ') || active.mobileE164}</strong>{' '}
              <span className="muted">{active.mobileE164}</span>{' '}
              <button
                type="button"
                className="secondary"
                disabled={sendTest.isPending}
                onClick={() => {
                  sendTest.mutate(active.mobileE164);
                }}
              >
                Send test text to this phone
              </button>
            </header>
            <div className="thread-body">
              {active.messages.length === 0 && <p className="muted">No messages yet.</p>}
              {active.messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  body={m.body}
                  createdAt={m.createdAt}
                  timezone={timezone}
                  side={m.direction === 'inbound' ? 'mine' : 'theirs'}
                  status={m.status}
                />
              ))}
            </div>
            <div className="quick-replies">
              {QUICK_REPLIES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className="secondary"
                  disabled={sendReply.isPending}
                  onClick={() => {
                    send(r);
                  }}
                >
                  {r}
                </button>
              ))}
            </div>
            <form className="composer" onSubmit={onSubmit}>
              <input
                placeholder="Type a reply as this patient…"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                }}
              />
              <button type="submit" disabled={sendReply.isPending || !draft.trim()}>
                Send
              </button>
            </form>
            {sendReply.data && (
              <p className="muted">Inbound handled as: {sendReply.data.outcome}</p>
            )}
            {sendReply.isError && <p className="error">Could not send.</p>}
          </section>
        )}
      </div>
    </>
  );
}
