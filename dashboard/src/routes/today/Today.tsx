// Today — the home action queue (§B1). Renders the prioritized, entity-anchored
// queue from useToday() as grouped sections of white row cards (who - why - an
// optional red urgency chip - a "Placement - Touring"-style tag - an amber attention
// dot), each row a link to its placement/contact/conversation. A distinct
// "Relay groups to close" section (relay-number-lifecycle D5) leads the ready
// content: each still-open relay group whose 28-day close-nag is due, with Close /
// Keep-open actions. A "Past tours needing an outcome" section (Sam's item 18)
// sits after "Follow-ups due": the Tours page's Past rows as they are -
// no-shows included, since a no-show now closes on its own two weeks after its
// last mark (spec 9.4) - up to five, with a link to the Past tab
// (useTodayPastTours). Empty groups are skipped; loading shows a Spinner, error
// an inline message, all-empty (no items, no nags, no past tours) a friendly
// "all caught up" state. Matches the locked mockup structure in the new design
// language (tokens + CSS Modules).
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  closeConversation,
  deferCloseNag,
  undatedTourLabel,
  type RelayCloseNag,
  type TodayGroup,
  type TodayItem,
} from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { formatPhoneDisplay } from '../../lib/phone.js';
import { whenLabel } from '../tours/tourTime.js';
import { pastState } from '../tours/useTours.js';
import { useToday } from './useToday.js';
import {
  useTodayPastTours,
  type TodayPastTourRow,
  type TodayPastToursState,
} from './useTodayPastTours.js';
import styles from './Today.module.css';

/** Human heading per group, in canonical display order. */
const GROUP_META: { group: TodayGroup; label: string }[] = [
  { group: 'needs_you_now', label: 'Needs you now' },
  { group: 'tours_today', label: 'Tours today' },
  { group: 'unreplied', label: 'Unreplied' },
  { group: 'follow_ups', label: 'Follow-ups due' },
  { group: 'ai_suggestions', label: 'AI suggestions to review' },
];

/** The past-tours section follows this group (Cameron 2026-09-30: after
 *  "Follow-ups due", before "AI suggestions to review"). */
const PAST_TOURS_AFTER: TodayGroup = 'follow_ups';

const PAST_TOURS_LABEL = 'Past tours needing an outcome';

/** Router state the past-tours rows carry so the tour page's back arrow
 *  returns to Today. */
const BACK_TO_TODAY = { back: '/' } as const;

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
        // A tour opened from Today (a "Tours today" row) returns to Today, the
        // same as the past-tours rows below.
        state={item.refType === 'tour' ? BACK_TO_TODAY : undefined}
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

/** One "close this still-open relay group?" row (D5). The pool number is display
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
              ? `Relay group for ${who} is still open - close it?`
              : 'Relay group is still open - close it?'}
          </span>
        </span>
        <span className={styles.nagActions}>
          <Link
            className={styles.nagOpen}
            to={nagOpenHref(nag)}
            // A tour opened from Today returns to Today (as the queue rows do).
            state={nag.ownerType === 'tour' && nag.ownerId ? BACK_TO_TODAY : undefined}
          >
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

/** One past tour (Sam's item 18): tenant - property - when - the Past tab's
 *  state chip. A "Needs outcome" row opens the tour page with the Record
 *  outcome dialog up (the Past tab's ?outcome=1 deep link); the others open the
 *  plain tour page, where their next step lives (Mark toured, Start placement,
 *  or a no-show's Reschedule / no-show check-in). Its accessible name mirrors a
 *  Past row's: identity, date, then the state. */
function PastTourRow({ row }: { row: TodayPastTourRow }): React.JSX.Element {
  const { tour, tenant, property } = row;
  const when = whenLabel(tour.scheduledAt);
  const state = pastState(tour);
  const needsOutcome = tour.status === 'toured' && tour.outcome === undefined;
  const who = when.length > 0 ? `${tenant} at ${property} on ${when}` : `${tenant} at ${property}, undated`;
  return (
    <li className={styles.rowItem}>
      <Link
        to={needsOutcome ? `/tours/${tour.tourId}?outcome=1` : `/tours/${tour.tourId}`}
        state={BACK_TO_TODAY}
        className={`${styles.row} ${styles.pastRow}`}
        aria-label={`Tour for ${who}, ${state}`}
      >
        <span className={styles.main}>
          <span className={styles.who}>{tenant}</span>
          <span className={styles.why}>{property}</span>
        </span>
        <span className={styles.meta}>
          <span className={styles.when}>{when.length > 0 ? when : undatedTourLabel(tour)}</span>
          <span className={styles.tag}>{state}</span>
        </span>
      </Link>
    </li>
  );
}

/** The past-tours section. Hidden until its rows (names included) are ready
 *  and whenever there are none; a failed load says so here and leaves the
 *  rest of Today alone. The Past tab link carries the Past tab's own row count
 *  whenever that tab holds more than this section lists (rows past the cap, a
 *  deleted tenant's tours). */
function PastToursSection({ past }: { past: TodayPastToursState }): React.JSX.Element | null {
  if (past.status === 'idle') return null;
  if (past.status === 'error') {
    return (
      <section className={styles.group}>
        <h2 className={styles.groupHeading}>{PAST_TOURS_LABEL}</h2>
        <p className={styles.sectionError} role="alert">
          We couldn&apos;t load past tours.{' '}
          <Link className={styles.moreLink} to="/tours/past">
            Open the Past tab
          </Link>
        </p>
      </section>
    );
  }
  if (past.rows.length === 0) return null;
  const more = past.total > past.rows.length;
  return (
    <section className={styles.group}>
      <h2 className={styles.groupHeading}>{PAST_TOURS_LABEL}</h2>
      <ul className={styles.rows} aria-label={PAST_TOURS_LABEL}>
        {past.rows.map((row) => (
          <PastTourRow key={row.tour.tourId} row={row} />
        ))}
      </ul>
      {past.reloadFailed ? (
        <p className={styles.sectionError} role="alert">
          Could not refresh past tours. Reload the page to see the latest.
        </p>
      ) : null}
      <Link className={styles.moreLink} to="/tours/past">
        {more ? `See all ${past.total} on the Past tab` : 'Open the Past tab'}
      </Link>
    </section>
  );
}

export function Today(): React.JSX.Element {
  const { status, items, relayCloseNags = [], dismissNag = () => {} } = useToday();
  const past = useTodayPastTours();
  const hasNags = relayCloseNags.length > 0;
  // "All caught up" waits for the past-tours section to settle, so it never
  // flashes above rows that are about to appear; meanwhile an otherwise empty
  // page keeps its spinner rather than going blank.
  const noPastTours = past.status === 'ready' && past.rows.length === 0;
  const settling = status === 'ready' && items.length === 0 && !hasNags && past.status === 'idle';

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Today</h1>
      <p className={styles.sub}>What needs you, across every placement and contact.</p>

      {status === 'loading' || settling ? <Spinner center /> : null}

      {status === 'error' ? (
        <p className={styles.error} role="alert">
          We couldn&apos;t load your queue. Please try again.
        </p>
      ) : null}

      {status === 'ready' && items.length === 0 && !hasNags && noPastTours ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>All caught up</p>
          <p className={styles.emptyBody}>Nothing needs you right now.</p>
        </div>
      ) : null}

      {status === 'ready' && hasNags ? (
        <section className={styles.group}>
          <h2 className={styles.groupHeading}>Relay groups to close</h2>
          <ul className={styles.rows} aria-label="Relay groups to close">
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

      {status === 'ready'
        ? GROUP_META.map(({ group, label }) => {
            const rows = items.filter((i) => i.group === group);
            // The groups below the past-tours section are NOT held until it
            // settles (tried and reverted, review round 4): holding them made
            // core queue content wait on best-effort name lookups. The section
            // may land a moment after the queue; it labels in one round trip.
            return (
              <Fragment key={group}>
                {rows.length > 0 ? (
                  <section className={styles.group}>
                    <h2 className={styles.groupHeading}>{label}</h2>
                    <ul className={styles.rows} aria-label={label}>
                      {rows.map((item) => (
                        <Row key={`${item.refType}:${item.refId}`} item={item} />
                      ))}
                    </ul>
                  </section>
                ) : null}
                {group === PAST_TOURS_AFTER ? <PastToursSection past={past} /> : null}
              </Fragment>
            );
          })
        : null}
    </div>
  );
}
