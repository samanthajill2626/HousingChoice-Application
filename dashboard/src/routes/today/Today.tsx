// Today - the daily checklist (spec 2026-10-23-today-checklist-design,
// tracker #31): Sam and the VA work it top to bottom at the start and the end
// of the day. The checklist, in order: Needs you now, Identify these contacts,
// Past tours needing an outcome, Tours to book, Quiet shares (QuietShares.tsx,
// option C), Relay groups to close, Placements. Then a dashed divider and "At
// a glance" - Tours today as compact rows, the AI suggestions as one collapsed
// line - which never counts toward "done".
//
// Every section is a TodaySection: a bare heading (no count - spec r8 2.1,
// plan PR102; the "Show all N" button names the count), an optional help
// line for the VA, and a list named by the heading text that shows its first 5
// rows with "Show all N". Rows are white cards (who - why - an optional red
// urgency chip - a "Placement - Touring"-style tag - an amber attention
// stripe), each a link to its placement/contact/conversation/tour. An empty
// section is not rendered. A section the server could not compute shows "We
// couldn't load <section>." in its place; the client fallback (buildToday,
// only on a 404) shows one line instead. "All caught up" shows only when every
// checklist section is empty and settled, none failed to load and the load is
// not the fallback; At a glance still renders below it. Tokens + CSS Modules;
// full width (no page-level max-width).
import { useId, useState } from 'react';
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
import { timeLabel, whenLabel } from '../tours/tourTime.js';
import { pastState } from '../tours/useTours.js';
import { QuietSharesSection } from './QuietShares.js';
import { LimitedList, TodaySection } from './TodaySection.js';
import { useToday, type QuietSharesState } from './useToday.js';
import {
  useTodayPastTours,
  type TodayPastTourRow,
  type TodayPastToursState,
} from './useTodayPastTours.js';
import styles from './Today.module.css';

/** Section headings (spec 2). Each list's accessible name is its heading text
 *  without the count. Quiet shares' own lives in QuietShares.tsx. */
const NEEDS_LABEL = 'Needs you now';
const IDENTIFY_LABEL = 'Identify these contacts';
const PAST_TOURS_LABEL = 'Past tours needing an outcome';
const TOURS_TO_BOOK_LABEL = 'Tours to book';
const RELAY_LABEL = 'Relay groups to close';
const PLACEMENTS_LABEL = 'Placements';
const GLANCE_LABEL = 'At a glance';
const TOURS_TODAY_LABEL = 'Tours today';
const AI_LABEL = 'AI suggestions';

/** The VA help lines (spec 2.2), exact. Needs you now, Past tours, Relay
 *  groups to close and Placements have none: their rows already say why. */
const IDENTIFY_HELP =
  "We don't know yet who these are. Call each one; after about a week with no contact, mark them Inactive.";
const TOURS_TO_BOOK_HELP = 'Said yes to a property; the tour has no date yet. Oldest first.';

/** Router state the tour links carry so the tour page's back arrow returns
 *  to Today. */
const BACK_TO_TODAY = { back: '/' } as const;

/** useToday always sets quietShares; this default only keeps a partial test
 *  mock rendering (as the relayCloseNags default does). */
const NO_QUIET_SHARES: QuietSharesState = { status: 'ok', properties: [], truncated: false };

/** The deep-link target for a row, driven by its refType. The contact and
 *  conversation routes are placeholders for now (B2+) - that's expected. */
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

function rowKey(item: TodayItem): string {
  return `${item.refType}:${item.refId}`;
}

function Row({ item }: { item: TodayItem }): React.JSX.Element {
  const hasMeta = Boolean(item.urgency) || Boolean(item.tag);
  // A Tours to book row's urgency is its age ("Requested 3 days ago"): plain
  // text, as in the approved mockup - not the red time chip.
  const urgencyClass = item.group === 'tours_to_book' ? styles.when : styles.urg;
  return (
    <li className={styles.rowItem}>
      <Link
        to={hrefFor(item)}
        // A tour opened from Today (Tours to book, Tours today) returns to
        // Today, the same as the past-tours rows.
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
            {item.urgency ? <span className={urgencyClass}>{item.urgency}</span> : null}
            {item.tag ? <span className={styles.tag}>{item.tag}</span> : null}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/** A checklist section of queue rows; not rendered when empty (spec 2.1). */
function ItemsSection({
  label,
  help,
  rows,
}: {
  label: string;
  help?: string;
  rows: TodayItem[];
}): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <TodaySection label={label} help={help}>
      <LimitedList label={label} items={rows} itemKey={rowKey} renderItem={(item) => <Row item={item} />} />
    </TodaySection>
  );
}

/** A section the server could not compute (spec 2.5): its bare heading and
 *  the failure in place - never an empty section. */
function UnavailableSection({ label, what }: { label: string; what: string }): React.JSX.Element {
  return (
    <TodaySection label={label}>
      <p className={styles.sectionError} role="alert">
        {`We couldn't load ${what}.`}
      </p>
    </TodaySection>
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
 *  and whenever there are none; a failed load says so here and leaves the rest
 *  of Today alone. Its count is the rows Today qualifies (spec 5.3); the Past
 *  tab link, beside the Show all button, carries the Past tab's own count
 *  whenever that tab holds more than Today qualifies (a deleted tenant's
 *  tours). */
function PastToursSection({ past }: { past: TodayPastToursState }): React.JSX.Element | null {
  if (past.status === 'idle') return null;
  if (past.status === 'error') {
    return (
      <TodaySection label={PAST_TOURS_LABEL}>
        <p className={styles.sectionError} role="alert">
          We couldn&apos;t load past tours.{' '}
          <Link className={styles.moreLink} to="/tours/past">
            Open the Past tab
          </Link>
        </p>
      </TodaySection>
    );
  }
  if (past.rows.length === 0) return null;
  const more = past.total > past.rows.length;
  return (
    <TodaySection label={PAST_TOURS_LABEL}>
      <LimitedList
        label={PAST_TOURS_LABEL}
        items={past.rows}
        itemKey={(row) => row.tour.tourId}
        renderItem={(row) => <PastTourRow row={row} />}
        footer={
          <Link className={styles.moreLink} to="/tours/past">
            {more ? `See all ${past.total} on the Past tab` : 'Open the Past tab'}
          </Link>
        }
      />
      {past.reloadFailed ? (
        <p className={styles.sectionError} role="alert">
          Could not refresh past tours. Reload the page to see the latest.
        </p>
      ) : null}
    </TodaySection>
  );
}

/** One Tours today row, compact (spec 2.4): the local time, the tenant, the
 *  property. A fallback row has neither `at` nor `unitLabel` and reads the
 *  name alone. */
function CompactTourRow({ item }: { item: TodayItem }): React.JSX.Element {
  const time = timeLabel(item.at);
  const place = item.unitLabel ?? '';
  const name = [place.length > 0 ? `Tour for ${item.who} at ${place}` : `Tour for ${item.who}`, time]
    .filter((s) => s.length > 0)
    .join(', ');
  return (
    <li className={styles.compactItem}>
      <Link
        to={hrefFor(item)}
        state={item.refType === 'tour' ? BACK_TO_TODAY : undefined}
        className={styles.compactRow}
        aria-label={name}
      >
        {time.length > 0 ? <span className={styles.compactTime}>{time}</span> : null}
        <span className={styles.who}>{item.who}</span>
        {place.length > 0 ? <span className={styles.why}>{place}</span> : null}
      </Link>
    </li>
  );
}

/** Below the dashed divider (spec 2.4): Tours today, then the AI suggestions
 *  as ONE collapsed line whose list is not in the accessibility tree until it
 *  is opened. Never part of the checklist; not rendered when both are empty. */
function AtAGlance({ toursToday, aiSuggestions }: { toursToday: TodayItem[]; aiSuggestions: TodayItem[] }): React.JSX.Element | null {
  const [aiOpen, setAiOpen] = useState(false);
  const aiBodyId = useId();
  if (toursToday.length === 0 && aiSuggestions.length === 0) return null;
  const aiLine = `AI suggestions for ${aiSuggestions.length} ${aiSuggestions.length === 1 ? 'contact' : 'contacts'}`;
  return (
    <section className={styles.glance}>
      <h2 className={styles.groupHeading}>{GLANCE_LABEL}</h2>
      {toursToday.length > 0 ? (
        <TodaySection label={TOURS_TODAY_LABEL} level={3}>
          <LimitedList
            label={TOURS_TODAY_LABEL}
            items={toursToday}
            itemKey={rowKey}
            renderItem={(item) => <CompactTourRow item={item} />}
          />
        </TodaySection>
      ) : null}
      {aiSuggestions.length > 0 ? (
        <div className={styles.group}>
          <button
            type="button"
            className={styles.aiToggle}
            aria-expanded={aiOpen}
            aria-controls={aiOpen ? aiBodyId : undefined}
            onClick={() => setAiOpen((open) => !open)}
          >
            <span>{aiLine}</span>
            <span className={styles.aiChevron} aria-hidden="true">
              {aiOpen ? 'Hide' : 'Show'}
            </span>
          </button>
          {aiOpen ? (
            <div id={aiBodyId} className={styles.aiBody}>
              <LimitedList
                label={AI_LABEL}
                items={aiSuggestions}
                itemKey={rowKey}
                renderItem={(item) => <Row item={item} />}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function Today(): React.JSX.Element {
  const {
    status,
    items,
    source,
    relayCloseNags = [],
    dismissNag = () => {},
    quietShares = NO_QUIET_SHARES,
    toursToBookStatus = 'ok',
    generatedAt = '',
  } = useToday();
  const past = useTodayPastTours();
  const rowsOf = (group: TodayGroup): TodayItem[] => items.filter((i) => i.group === group);
  const needs = rowsOf('needs_you_now');
  const identify = rowsOf('identify');
  const toursToBook = rowsOf('tours_to_book');
  const placements = rowsOf('follow_ups');
  const toursToday = rowsOf('tours_today');
  const aiSuggestions = rowsOf('ai_suggestions');
  const fallback = source === 'fallback';
  const quietProperties = quietShares.status === 'ok' ? quietShares.properties.length : 0;

  // The checklist sections the queue itself fills (past tours settle on their own).
  const queueEmpty =
    needs.length === 0 &&
    identify.length === 0 &&
    toursToBook.length === 0 &&
    quietProperties === 0 &&
    relayCloseNags.length === 0 &&
    placements.length === 0;
  // A section that failed to load is not empty (spec 2.3, 2.5); the fallback
  // computes neither Tours to book nor Quiet shares (spec 3.1).
  const anyUnavailable =
    fallback || quietShares.status === 'unavailable' || toursToBookStatus === 'unavailable' || past.status === 'error';
  const glanceEmpty = toursToday.length === 0 && aiSuggestions.length === 0;
  // "All caught up" waits for the past-tours section to settle, so it never
  // flashes above rows that are about to appear (spec 2.3). At a glance never
  // blocks it.
  const allCaughtUp = status === 'ready' && queueEmpty && !anyUnavailable && past.status === 'ready' && past.rows.length === 0;
  // Meanwhile a page with nothing else to show keeps its spinner rather than
  // going blank.
  const settling = status === 'ready' && queueEmpty && glanceEmpty && !anyUnavailable && past.status === 'idle';

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Today</h1>
      <p className={styles.sub}>
        Clear every section above the line and today&apos;s checklist is done. New messages are in the Inbox.
      </p>

      {status === 'loading' || settling ? <Spinner center /> : null}

      {status === 'error' ? (
        <p className={styles.error} role="alert">
          We couldn&apos;t load your queue. Please try again.
        </p>
      ) : null}

      {status === 'ready' ? (
        <>
          {fallback ? <p className={styles.notice}>Some sections can&apos;t load right now.</p> : null}

          {allCaughtUp ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>All caught up</p>
              <p className={styles.emptyBody}>Nothing needs you right now.</p>
            </div>
          ) : null}

          {/* The checklist (spec 2, sections 1-7). The sections after past
           *  tours are NOT held until it settles (tried and reverted, review
           *  round 4): core content must not wait on best-effort name lookups. */}
          <ItemsSection label={NEEDS_LABEL} rows={needs} />
          <ItemsSection label={IDENTIFY_LABEL} help={IDENTIFY_HELP} rows={identify} />
          <PastToursSection past={past} />
          {toursToBookStatus === 'unavailable' && !fallback ? (
            <UnavailableSection label={TOURS_TO_BOOK_LABEL} what="tours to book" />
          ) : (
            <ItemsSection label={TOURS_TO_BOOK_LABEL} help={TOURS_TO_BOOK_HELP} rows={toursToBook} />
          )}
          {fallback ? null : <QuietSharesSection quiet={quietShares} now={generatedAt} />}
          {relayCloseNags.length > 0 ? (
            <TodaySection label={RELAY_LABEL}>
              <LimitedList
                label={RELAY_LABEL}
                items={relayCloseNags}
                itemKey={(nag) => nag.conversationId}
                renderItem={(nag) => (
                  <RelayCloseNagRow nag={nag} onDone={() => dismissNag(nag.conversationId)} />
                )}
              />
            </TodaySection>
          ) : null}
          <ItemsSection label={PLACEMENTS_LABEL} rows={placements} />

          <AtAGlance toursToday={toursToday} aiSuggestions={aiSuggestions} />
        </>
      ) : null}
    </div>
  );
}
