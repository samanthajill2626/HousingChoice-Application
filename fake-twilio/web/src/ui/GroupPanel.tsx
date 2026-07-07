// GroupPanel — the right pane for a selected relay GROUP (sibling of the
// PhonePanel in App.tsx, sharing its panel shell styles). Shows the group's
// unified transcript as inferred by the engine:
//   - `inbound` entries are a MEMBER texting the pool → the phones' side
//     (right, brand surface), labeled with the sender's persona label.
//   - `outbound` entries are the APP fanning a message out to the members
//     (left, neutral surface). Bodies arrive with the app's own "Name: …"
//     sender prefix and are displayed VERBATIM (no name parsing). Each fan-out
//     leg keeps its own SID + delivery state, rendered as one StatusChip per
//     recipient slot (the same status-callback flow that drives 1:1 chips).
// Below the transcript, a "Reply as" member picker + the shared Composer send
// `{ from: <picked member>, to: <pool> }` through the parent — the interactive
// path that triggers the app's real relay fan-out. The delivery-profile
// radiogroup arms the PICKED member's next app→member outbound, mirroring the
// 1:1 panel's per-party semantics (one-shot: the radio snaps back to Normal
// when a fanned leg reaches the picked member, or when the pick changes).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Composer, type ComposerSendInput } from './Composer.js';
import { StatusChip } from './StatusChip.js';
import { cannedLabelFor, isImageAsset } from '../assets/canned/index.js';
import { formatPhoneDisplay } from '../lib/phone.js';
import type { DeliveryProfile, GroupEntry, GroupSnapshot } from '../api/types.js';
import shell from './App.module.css';
import styles from './GroupPanel.module.css';

export interface GroupPanelProps {
  group: GroupSnapshot;
  /** Send the composed message TO the pool AS the picked member. */
  onSend: (input: { from: string; body: string; mediaUrls: string[] }) => void | Promise<void>;
  /** Arm the picked member's next app→member delivery outcome (one-shot). */
  onSetDeliveryProfile: (memberNumber: string, profile: DeliveryProfile) => void;
  sendError?: string;
}

/** Same presentation as MessageBubble's private helper. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function Media({ urls }: { urls: string[] }): React.JSX.Element {
  return (
    <div className={styles.media}>
      {urls.map((url) =>
        isImageAsset(url) ? (
          <img key={url} className={styles.thumb} src={url} alt={cannedLabelFor(url)} loading="lazy" />
        ) : (
          <a key={url} className={styles.thumb} href={url} target="_blank" rel="noopener noreferrer">
            📄 {cannedLabelFor(url)}
          </a>
        ),
      )}
    </div>
  );
}

export function GroupPanel({
  group,
  onSend,
  onSetDeliveryProfile,
  sendError,
}: GroupPanelProps): React.JSX.Element {
  // The picked "reply as" member. Roster is SET-semantic and can change under
  // us — derive the effective pick so a removed member falls back to the first.
  const [pickedNumber, setPickedNumber] = useState<string | undefined>(group.members[0]?.number);
  const picked = group.members.find((m) => m.number === pickedNumber) ?? group.members[0];

  const labelFor = (number: string): string =>
    group.members.find((m) => m.number === number)?.label ?? formatPhoneDisplay(number);

  // The armed delivery profile is one-shot in the engine, consumed by the next
  // app→picked-member OUTBOUND — in group terms, a fan-out leg whose recipient
  // is the picked member. Bump the Composer's reset signal when such a leg
  // lands, and when the pick changes (the armed profile belongs to a number).
  const legsToPicked = useMemo(
    () =>
      group.entries.reduce(
        (n, e) =>
          e.kind === 'outbound'
            ? n + e.recipients.filter((r) => r.number === picked?.number).length
            : n,
        0,
      ),
    [group.entries, picked?.number],
  );
  const [deliveryResetSignal, setDeliveryResetSignal] = useState(0);
  const prevRef = useRef({ pickedNumber: picked?.number, legsToPicked });
  useEffect(() => {
    const prev = prevRef.current;
    if (prev.pickedNumber !== picked?.number || legsToPicked > prev.legsToPicked) {
      setDeliveryResetSignal((n) => n + 1);
    }
    prevRef.current = { pickedNumber: picked?.number, legsToPicked };
  }, [picked?.number, legsToPicked]);

  const handleSend = (input: ComposerSendInput): void | Promise<void> => {
    if (!picked) return;
    return onSend({ from: picked.number, body: input.body, mediaUrls: input.mediaUrls });
  };

  const handleSetDeliveryProfile = (profile: DeliveryProfile): void => {
    if (!picked) return;
    onSetDeliveryProfile(picked.number, profile);
  };

  const renderEntry = (entry: GroupEntry): React.JSX.Element => {
    const isApp = entry.kind === 'outbound';
    return (
      <div
        key={entry.id}
        className={`${styles.entry} ${isApp ? styles.app : styles.member}`}
        data-testid="group-entry"
        data-kind={entry.kind}
      >
        <div className={styles.bubble}>
          {entry.kind === 'inbound' && <span className={styles.sender}>{entry.fromLabel}</span>}
          {entry.mediaUrls && entry.mediaUrls.length > 0 && <Media urls={entry.mediaUrls} />}
          {entry.body !== undefined && entry.body !== '' && (
            <p className={styles.body}>{entry.body}</p>
          )}
          <div className={styles.meta}>
            <time className={styles.time} dateTime={entry.at}>
              {formatTime(entry.at)}
            </time>
          </div>
          {entry.kind === 'outbound' && (
            <ul className={styles.recipients} aria-label="Delivery">
              {entry.recipients.map((r) => (
                <li key={r.sid} className={styles.recipient}>
                  <span className={styles.recipientLabel}>{labelFor(r.number)}</span>
                  <StatusChip state={r.state} errorCode={r.errorCode} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className={shell.panel} aria-label="Group conversation">
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={shell.panelLabel}>{formatPhoneDisplay(group.poolNumber)}</span>
          <span className={shell.panelNumber}>{group.poolNumber}</span>
        </div>
        <ul className={styles.roster} aria-label="Members">
          {group.members.map((m) => (
            <li key={m.number} className={styles.memberChip}>
              {m.label}
            </li>
          ))}
        </ul>
      </header>

      <div className={shell.log} role="log" aria-label="Group conversation" aria-live="polite">
        {group.entries.length === 0 ? (
          <p className={shell.threadEmpty}>
            No messages yet — group traffic appears here as it flows.
          </p>
        ) : (
          group.entries.map(renderEntry)
        )}
      </div>

      {sendError !== undefined && sendError !== '' && (
        <p role="alert" className={shell.sendError}>
          {sendError}
        </p>
      )}

      <div className={styles.replyBar}>
        <label className={styles.replyAs}>
          <span className={styles.replyAsLabel}>Reply as</span>
          <select
            className={styles.replyAsSelect}
            value={picked?.number ?? ''}
            onChange={(e) => setPickedNumber(e.target.value)}
          >
            {group.members.map((m) => (
              <option key={m.number} value={m.number}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <Composer
        onSend={handleSend}
        onSetDeliveryProfile={handleSetDeliveryProfile}
        resetSignal={deliveryResetSignal}
        disabled={picked === undefined}
      />
    </section>
  );
}
