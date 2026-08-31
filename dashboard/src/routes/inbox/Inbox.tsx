// Inbox — the entity-centric communications hub (§2026-06-17-inbox-design). One
// row per contact (or untriaged unknown number), newest-activity-first, with All
// (default) / Unread / Unknown filters. Opening a row navigates to the contact
// page AND marks its comms read (optimistic). Degrades to an honest pending state
// until the C8 backend lands. New design language (tokens + CSS Modules);
// state-sync handled in useInbox.
import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { InboxFilter } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { INBOX_FILTERS, emptyClearedCopy, emptyCopy, emptyMoreCopy } from './inboxFilters.js';
import { InboxRow } from './InboxRow.js';
import { rowKey, useInbox } from './useInbox.js';
import styles from './Inbox.module.css';

/** The filter query param is the SOURCE OF TRUTH for the active tab, so
 *  `/inbox?filter=groups` is a real, shareable deep link (the truncation
 *  affordance below links to exactly that) and the back button steps through
 *  filters. An unrecognized value degrades to All rather than crashing or
 *  400ing the server on a hand-typed URL. */
function filterFromParam(raw: string | null): InboxFilter {
  return INBOX_FILTERS.some((t) => t.filter === raw) ? (raw as InboxFilter) : 'all';
}

export function Inbox(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const filter = filterFromParam(params.get('filter'));
  const inbox = useInbox(filter);
  // THE EMPTY COPY DEPENDS ON WHETHER THE SERVER PAGE CAME BACK EMPTY WITH MORE
  // BEHIND IT, not on the filter alone. Such a page has not proved the list is
  // empty - it stopped early - so it gets the "nothing on this page yet" copy
  // that sits sensibly next to the live Load more below. See emptyMoreCopy.
  //
  // BOTH HALVES ARE SERVER STATEMENTS, and the first one is load-bearing (fix
  // wave 2, F2 - found independently by both round-2 reviewers). Gated on
  // `hasMore` ALONE this said "This search stopped early to stay fast" at the
  // end of an ORDINARY unread triage session: the server filled a page of 30
  // and minted a cursor BECAUSE it filled, the operator marked all 30 read, and
  // `useInbox` narrows read rows out of `rows` (that narrowing is the whole
  // point of the tab). The list went empty for a CLIENT reason and selected a
  // SERVER-flavoured sentence that was false on both halves. `serverRowCount`
  // is the same server quantity the truncation notice and the failure banner
  // below are gated on, for the same reason - see those two comments.
  //
  // THE CLIENT-EMPTIED-WITH-MORE-BEHIND STATE GETS ITS OWN COPY (2026-08-26,
  // phase-6 review). It used to fall through to `emptyCopy`, which put "You're
  // all caught up" next to a live Load more - two sentences that contradict
  // each other, on the tab an operator lives in all day. The previous round
  // swapped one false sentence for another; this splits the state out instead
  // of choosing between two claims that are each wrong somewhere.
  //
  // THREE STATES, EACH GATED ON A SERVER QUANTITY - the doctrine every other
  // gate in this file follows (`serverRowCount`, never `rows`, for anything
  // that speaks about the server page):
  //   serverRowCount === 0 && hasMore  the SERVER page was empty and stopped
  //                                    early -> emptyMoreCopy()
  //   serverRowCount  > 0 && hasMore   the server filled it and the OPERATOR
  //                                    cleared it -> emptyClearedCopy()
  //   otherwise                        the filter's own copy
  // `rows.length === 0` is not in any of them because the block that renders
  // `empty` is already inside it. No filter gate either: off Unread, `rows` is
  // `base` unnarrowed, so `serverRowCount > 0` with an empty list cannot arise -
  // and `emptyClearedCopy` is worded to stay true if it ever does.
  const empty = inbox.hasMore
    ? (inbox.serverRowCount === 0 ? emptyMoreCopy() : emptyClearedCopy())
    : emptyCopy(filter);
  // A26: the count comes from the hook's server-page tally, NOT from a filter
  // over `inbox.rows`. `rows` is the DISPLAYED list - already narrowed by the
  // Unread filter and already patched by the optimistic mark-read - so counting
  // it made the notice tick 4, 3, 2 while the truncation claim stood.
  const groupRowCount = inbox.groupRowsShown;
  const groupNoun = groupRowCount === 1 ? 'group text' : 'group texts';
  // THE early-end condition, named once so the failure surface and the
  // empty-state below stay exact complements: the SERVER handed down no rows AND
  // said the unread feed ended early. Both halves are server statements - see
  // `InboxState.serverRowCount`. When it is false and the list is nonetheless
  // empty (every row marked read on a truncated page), "all caught up" is the
  // truth and the block below says so.
  const serverEndedEarlyEmpty = inbox.serverRowCount === 0 && inbox.truncated;

  const selectFilter = useCallback(
    (next: InboxFilter) => {
      // 'all' is the default, so it stays OUT of the URL - a bare /inbox is the
      // canonical link. useInbox drops the cursor on every filter change (its
      // fetch callback is keyed on the filter), so no stale cursor can cross
      // partitions.
      setParams(next === 'all' ? {} : { filter: next }, { replace: false });
    },
    [setParams],
  );

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Inbox</h1>
      <p className={styles.sub}>Triage texts and calls — every row opens its contact.</p>

      <div className={styles.tabs} role="tablist" aria-label="Inbox filters">
        {INBOX_FILTERS.map((tab) => (
          <button
            key={tab.filter}
            type="button"
            role="tab"
            aria-selected={filter === tab.filter}
            className={`${styles.tab} ${filter === tab.filter ? styles.tabActive : ''}`}
            onClick={() => selectFilter(tab.filter)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {inbox.groupsTruncated ? (
        // Honest, and no invented TOTAL: the group partition cannot produce one
        // without walking it. The number is what the server actually handed
        // down for this filter, and the link goes to the filter that pages the
        // whole list.
        //
        // C12 RULING - the Unread case. This notice can render on the Unread
        // tab, where the rows counted are unread group texts, but the only
        // group-paging view we have is `?filter=groups`, which pages ALL group
        // texts. There is no server-side unread-groups filter today: the groups
        // partition is walked newest-first with its own budget, and an
        // unread-scoped variant would be a new query shape and a new cursor tag,
        // which this feature does not add. So the affordance is LABELLED for
        // where it really goes rather than implying a view that does not exist -
        // the cheap correct option, and reachable only past ~2000 group threads
        // against a real-world 132.
        <p className={styles.notice}>
          {/* Adversarial 30. On Unread the operator can clear every group row on
           *  screen while the server's truncation flag stands, so this count
           *  reaches ZERO with the notice still rendering - and "Showing the
           *  latest 0 group texts" is a claim about a list that has none. The
           *  affordance is still exactly what is wanted at that moment, so the
           *  notice keeps the link and drops the count. */}
          {groupRowCount === 0 ? (
            'Not all group texts are shown here.'
          ) : (
            <>
              Showing the latest {groupRowCount} {filter === 'unread' ? 'unread ' : ''}
              {groupNoun}.
            </>
          )}
          {filter !== 'groups' ? (
            <>
              {' '}
              <Link to="/inbox?filter=groups">
                {filter === 'unread'
                  ? 'Browse all group texts (read and unread)'
                  : 'See all group texts'}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      {/* S8. A truncated NON-EMPTY unread page used to end SILENTLY: on the
          CAPPED exits no cursor is minted, so no "Load more" renders, and the
          banner below is gated on the page having come back EMPTY - so a capped
          list looked exactly like the end of the feed. A cap is acceptable only
          if the list says it is capped.

          `hasMore` IS DELIBERATELY NOT IN THE GATE, and the plan's claim that it
          could be ("hasMore is false so no Load more renders") is FALSE: the
          server's budget exit mints a cursor AND sets `truncated`, so
          `truncated && hasMore` is genuinely reachable and this notice can
          appear above a working "Load more". That is the ACCEPTED trade.
          `truncated` carries TWO meanings on one wire flag - the pageable budget
          exit, and `unresolvedDrops > 0`, which is set after the whole cursor
          chain and names rows NO page in this session can reach. No CLIENT-side
          gate can separate them, so gating on `!hasMore` would silence the
          notice in the LEAST recoverable state, which is the state the rule "a
          cap is acceptable only if the list says it is capped" exists to cover.
          An imprecise notice beats silence. Splitting the signal on the wire is
          the real fix: docs/issues/inbox-truncated-flag-two-meanings.md.

          Gated on `serverRowCount`, NOT `rows.length`, for the same reason that
          banner is: both `truncated` and this count describe the SERVER page,
          while `rows` is the client-filtered list the Unread tab EMPTIES as the
          operator marks rows read. Keyed on `rows` the notice would vanish
          mid-triage, exactly when the operator most needs to know older unread
          threads are still out there. The condition is the exact complement of
          `serverEndedEarlyEmpty`, so this notice and that banner can never
          render together.

          NO COUNT in the copy, for the reason the group notice above dropped
          its own: the operator clears rows while the server's flag stands, so
          any number reaches zero with the notice still up. */}
      {/* GATED ON THE FILTER, and not only because the copy is unread-specific.
          The server sets `truncated` in the filter=unread branch alone today, so
          the flag is "correct" here by a dependency nothing in this file
          encodes. Worse, `useInbox` clears `truncated` in an EFFECT, so on an
          Unread -> All switch there is one committed render where the filter is
          already `all` while `truncated` and `serverRowCount` still describe the
          unread page - and this notice would render its unread copy on the All
          tab for that commit. Same one-commit shape the error banner above
          already defends against. */}
      {filter === 'unread' &&
      inbox.status === 'ready' &&
      inbox.truncated &&
      inbox.serverRowCount > 0 ? (
        <p className={styles.notice}>
          Showing the most recent unread. There are older unread threads not shown here.
        </p>
      ) : null}

      {inbox.status === 'loading' ? <Spinner center /> : null}

      {/* An empty page that the server TRUNCATED is not "all caught up" - the
          feed ended early, so we reuse the SHIPPED failure surface verbatim
          rather than inventing copy (spec 4.5 step 3). Retry refetches the same
          prefix with a fresh budget; it may fail again, and not lying is the
          point. The empty-state block below carries the matching `!truncated`
          so the two can never render together.

          Gated on `serverRowCount`, NOT `rows.length` (adversarial 4): both
          `truncated` and this count describe the SERVER page, while `rows` is
          the client-filtered list that the Unread tab empties as the operator
          marks rows read. Keyed on `rows` this banner appeared at the END of a
          successful triage session on any truncated page. */}
      {inbox.status === 'error' || (inbox.status === 'ready' && serverEndedEarlyEmpty) ? (
        <div className={styles.error} role="alert">
          <p>We couldn&apos;t load your inbox.</p>
          <button type="button" className={styles.retry} onClick={() => inbox.retry()}>
            Retry
          </button>
        </div>
      ) : null}

      {inbox.status === 'pending' ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>The inbox turns on with its backend</p>
          <p className={styles.emptyBody}>This view is wired and will fill in once the feed ships.</p>
        </div>
      ) : null}

      {inbox.status === 'ready' && inbox.rows.length === 0 && !serverEndedEarlyEmpty ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{empty.title}</p>
          <p className={styles.emptyBody}>{empty.body}</p>
        </div>
      ) : null}

      {inbox.status === 'ready' && inbox.rows.length > 0 ? (
        <ul className={styles.rows} aria-label="Conversations">
          {inbox.rows.map((row) => (
            <InboxRow
              key={rowKey(row)}
              row={row}
              onOpen={inbox.markRead}
              onMarkRead={inbox.markRead}
              onMarkUnread={inbox.markUnread}
            />
          ))}
        </ul>
      ) : null}

      {/* LOAD MORE IS GATED ON `hasMore` ALONE, NOT ON THE PAGE HAVING ROWS
          (M1, rework blast-radius finding 2). It used to be nested inside the
          `rows.length > 0` block above, which made the server's deliberate
          empty-page-with-a-cursor a DEAD END: `filter=unknown` returns
          `{ rows: [], nextCursor }` when its per-request scan budget expires on
          a wall of soft-deleted residue or threadless stubs (and now also when
          a thread read fails mid-page), and the operator got the empty state
          with nothing to click. Every row behind that position was unreachable
          from the UI - which is the exact defect the paged rework was chartered
          to remove, reintroduced one layer up. The app-side pin assumed this
          affordance existed; nothing on the client proved it, so it shipped
          green.

          It can now render ALONGSIDE the empty state (see `empty` above, which
          switches its copy for exactly that pairing).

          IT CANNOT RENDER ALONGSIDE THE EARLY-END FAILURE BANNER, and the
          earlier claim here that it could was wrong (fix wave 2, round-2
          blast-radius N3). That banner needs `serverRowCount === 0 &&
          truncated`, and the server nulls the unread cursor on a zero-row page
          (app/src/routes/inbox.ts, the unread branch's empty-page invariant), so
          `hasMore` is false wherever the banner is true. The pairing is
          server-unreachable TODAY, by one line - not by anything on this
          client - and that line now says so. If it ever changes, this element
          and that banner render together; a cursor and a truncation are
          independent server statements, and offering the continuation would not
          make the banner less true. */}
      {inbox.status === 'ready' && inbox.hasMore ? (
        <button
          type="button"
          className={styles.loadMore}
          onClick={() => inbox.loadMore()}
          disabled={inbox.loadingMore}
        >
          {inbox.loadingMore ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}
