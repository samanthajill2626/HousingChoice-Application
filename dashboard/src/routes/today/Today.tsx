// Today — the home action queue (§B1). Renders the prioritized, entity-anchored
// queue from useToday() as grouped sections of white row cards (who - why - an
// optional red urgency chip - a "Placement - Touring"-style tag - an amber attention
// dot), each row a link to its placement/contact/conversation. A distinct
// "Group texts to close" section (relay-number-lifecycle D5) leads the ready
// content: each still-open relay group whose 28-day close-nag is due, with Close /
// Keep-open actions. Empty groups are skipped; loading shows a Spinner, error an
// inline message, all-empty (no items AND no nags) a friendly "all caught up"
// state. Matches the locked mockup structure in the new design language (tokens +
// CSS Modules).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  closeConversation,
  deferCloseNag,
  type RelayCloseNag,
  type TodayGroup,
  type TodayItem,
} from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { formatPhoneDisplay } from '../../lib/phone.js';
import { useToday } from './useToday.js';
import styles from './Today.module.css';

/** Human heading per group, in canonical display order. */
const GROUP_META: { group: TodayGroup; label: string }[] = [
  { group: 'needs_you_now', label: 'Needs you now' },
  { group: 'tours_today', label: 'Tours today' },
  { group: 'unreplied', label: 'Unreplied' },
  { group: 'follow_ups', label: 'Follow-ups due' },
  { group: 'ai_suggestions', label: 'AI suggestions to review' },
];

/** The deep-link target for a row, driven by its refType. The contact +
 *  conversation routes are placeholders for now (B2+) — that's expected. */
function hrefFor(item: TodayItem): string {
  switch (item.refType) {
    case 'placement':
      return `/placements/${item.refId}`;
    case 'contact':
      return `/contacts/${item.refId}`;
    case 'conversation':
      return `/conversations/${item.refId}`;
    case 'tour':
      return `/tours/${item.refId}`;
  }
}

function Row({ item }: { item: TodayItem }): React.JSX.Element {
  const hasMeta = Boolean(item.urgency) || Boolean(item.tag);
  return (
    <li className={styles.rowItem}>
      <Link
        to={hrefFor(item)}
        className={`${styles.row} ${item.attention ? styles.flagged : ''}`}
      >
        {/* Attention flag = an amber severity stripe down the card's left edge (CSS,
         *  ::before on .flagged). It's decorative, so announce it to screen readers
         *  with visually-hidden text here. */}
        {item.attention ? <span className={styles.srOnly}>Needs attention</span> : null}
        {/* Text block (who - why). On a tight content pane it stacks above the meta
         *  chips (container query in the CSS) so the "why" never gets crushed. */}
        <span className={styles.main}>
          <span className={styles.who}>{item.who}</span>
          <span className={styles.why}>{item.why}</span>
        </span>
        {hasMeta ? (
          <span className={styles.meta}>
            {item.urgency ? <span className={styles.urg}>{item.urgency}</span> : null}
            {item.tag ? <span className={styles.tag}>{item.tag}</span> : null}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/** The owner's detail target for a nag ("Open"), else the group conversation. */
function nagOpenHref(nag: RelayCloseNag): string {
  if (nag.ownerType === 'tour' && nag.ownerId) return `/tours/${nag.ownerId}`;
  if (nag.ownerType === 'placement' && nag.ownerId) return `/placements/${nag.ownerId}`;
  return `/conversations/${nag.conversationId}`;
}

/** One "close this still-open group text?" row (D5). The pool number is display
 *  DATA (precedent: the opted-out Today card shows a phone). Close -> the existing
 *  close endpoint (final message + keeps the number); Keep open -> the 28-day
 *  defer. Either success dismisses the row (the server also drops it next refetch). */
function RelayCloseNagRow({
  nag,
  onDone,
}: {
  nag: RelayCloseNag;
  onDone: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const who =
    nag.tag && nag.tag.length > 0
      ? nag.tag
      : nag.memberNames.length > 0
        ? nag.memberNames.join(' & ')
        : null;
  const number = formatPhoneDisplay(nag.poolNumber) || nag.poolNumber;

  const run = (action: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void action()
      .then(() => onDone())
      .catch(() => {
        setError('That did not go through - please try again.');
        setBusy(false);
      });
  };

  return (
    <li className={styles.rowItem}>
      <div className={styles.nagCard}>
        <span className={styles.main}>
          <span className={styles.who}>{number}</span>
          <span className={styles.why}>
            {who !== null
              ? `Group text for ${who} is still open - close it?`
              : 'Group text is still open - close it?'}
          </span>
        </span>
        <span className={styles.nagActions}>
          <Link className={styles.nagOpen} to={nagOpenHref(nag)}>
            Open
          </Link>
          <button
            type="button"
            className={styles.nagKeep}
            disabled={busy}
            onClick={() => run(() => deferCloseNag(nag.conversationId))}
          >
            Keep open
          </button>
          <button
            type="button"
            className={styles.nagClose}
            disabled={busy}
            onClick={() => run(() => closeConversation(nag.conversationId, true))}
          >
            Close
          </button>
        </span>
      </div>
      {error !== null ? (
        <p role="alert" className={styles.nagError}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function Today(): React.JSX.Element {
  const { status, items, relayCloseNags = [], dismissNag = () => {} } = useToday();
  const hasNags = relayCloseNags.length > 0;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Today</h1>
      <p className={styles.sub}>What needs you, across every placement and contact.</p>

      {status === 'loading' ? <Spinner center /> : null}

      {status === 'error' ? (
        <p className={styles.error} role="alert">
          We couldn&apos;t load your queue. Please try again.
        </p>
      ) : null}

      {status === 'ready' && items.length === 0 && !hasNags ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>All caught up</p>
          <p className={styles.emptyBody}>Nothing needs you right now.</p>
        </div>
      ) : null}

      {status === 'ready' && hasNags ? (
        <section className={styles.group}>
          <h2 className={styles.groupHeading}>
            Group texts to close
            <span className={styles.count}>{relayCloseNags.length}</span>
          </h2>
          <ul className={styles.rows} aria-label="Group texts to close">
            {relayCloseNags.map((nag) => (
              <RelayCloseNagRow
                key={nag.conversationId}
                nag={nag}
                onDone={() => dismissNag(nag.conversationId)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {status === 'ready' && items.length > 0
        ? GROUP_META.map(({ group, label }) => {
            const rows = items.filter((i) => i.group === group);
            if (rows.length === 0) return null;
            return (
              <section key={group} className={styles.group}>
                <h2 className={styles.groupHeading}>
                  {label}
                  <span className={styles.count}>{rows.length}</span>
                </h2>
                <ul className={styles.rows} aria-label={label}>
                  {rows.map((item) => (
                    <Row key={`${item.refType}:${item.refId}`} item={item} />
                  ))}
                </ul>
              </section>
            );
          })
        : null}
    </div>
  );
}
