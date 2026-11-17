import { formatDateInZone, formatTimeInZone, type MessageStatus } from '@slotfill/shared';

/**
 * One SMS in a thread. `side` is from the viewer's point of view: in the staff log the clinic's
 * messages are "mine"; in the phone simulator the patient's are.
 */
export function MessageBubble(props: {
  body: string;
  createdAt: string;
  timezone: string;
  side: 'mine' | 'theirs';
  status?: MessageStatus;
  note?: string | null;
}) {
  const at = new Date(props.createdAt);
  return (
    <div className={`bubble-row ${props.side}`}>
      <div className={`bubble ${props.side}`}>
        <div>{props.body}</div>
        <div className="bubble-meta">
          {formatDateInZone(at, props.timezone)} {formatTimeInZone(at, props.timezone)}
          {props.status &&
            props.status !== 'sent' &&
            props.status !== 'received' &&
            ` · ${props.status}`}
          {props.note && ` · ${props.note}`}
        </div>
      </div>
    </div>
  );
}
