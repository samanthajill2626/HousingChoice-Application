import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow as InboxRowData } from '../../api/index.js';
import type { InboxState } from './useInbox.js';

let state: InboxState;
let seenFilter: string | undefined;
const markRead = vi.fn();
const markUnread = vi.fn();
const loadMore = vi.fn();
const retry = vi.fn();

function baseState(over: Partial<InboxState> = {}): InboxState {
  return {
    status: 'ready',
    rows: [],
    groupsTruncated: false,
    truncated: false,
    serverRowCount: 0,
    groupRowsShown: 0,
    hasMore: false,
    loadingMore: false,
    loadMore,
    retry,
    markRead,
    markUnread,
    ...over,
  };
}

vi.mock('./useInbox.js', async () => {
  const actual = await vi.importActual<typeof import('./useInbox.js')>('./useInbox.js');
  return {
    ...actual,
    useInbox: (filter: string) => {
      seenFilter = filter;
      return state;
    },
  };
});
import { Inbox } from './Inbox.js';

function mkRow(over: Partial<InboxRowData> = {}): InboxRowData {
  return {
    kind: 'contact',
    contactId: 'c1',
    name: 'Tasha Williams',
    unreadCount: 2,
    preview: 'Hi',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-17T10:00:00.000Z',
    needsTriage: false,
    ...over,
  };
}
function renderInbox(entry = '/inbox'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Inbox />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state = baseState();
  seenFilter = undefined;
  markRead.mockReset();
  loadMore.mockReset();
  retry.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('Inbox', () => {
  it('shows the Inbox heading and a spinner while loading', () => {
    state = baseState({ status: 'loading' });
    renderInbox();
    expect(screen.getByRole('heading', { level: 1, name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders the four filter tabs with All selected by default', () => {
    renderInbox();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Groups' })).toBeInTheDocument();
  });

  it('shows an honest pending state when the backend 404s', () => {
    state = baseState({ status: 'pending' });
    renderInbox();
    expect(screen.getByText(/backend|not.*available|turns on/i)).toBeInTheDocument();
  });

  it('shows an error message with a Retry button on error', () => {
    state = baseState({ status: 'error' });
    renderInbox();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows the All empty copy when ready with no rows', () => {
    state = baseState({ status: 'ready', rows: [] });
    renderInbox();
    expect(screen.getByText(/No conversations yet/i)).toBeInTheDocument();
  });

  // An empty page the server TRUNCATED is not "all caught up" - the unread feed
  // ended early. It reuses the SHIPPED failure copy (one error surface stays one
  // surface), and the two blocks must never render together.
  it('renders the failure copy - NOT all-caught-up - on an empty TRUNCATED unread page', () => {
    state = baseState({ status: 'ready', rows: [], truncated: true });
    renderInbox('/inbox?filter=unread');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/couldn.t load your inbox/i)).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keeps the all-caught-up copy on an empty unread page that was NOT truncated', () => {
    state = baseState({ status: 'ready', rows: [], truncated: false });
    renderInbox('/inbox?filter=unread');
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // ADVERSARIAL 4. `truncated` describes the SERVER page; `rows` is the
  // client-filtered list the Unread tab empties as the operator marks rows read.
  // Gated on `rows` this pairing turned a finished triage session into "We
  // couldn't load your inbox.", an error banner with no server statement behind
  // it. The gate is `serverRowCount` - a server claim judged against a server
  // quantity - so the two states stay exact complements.
  //
  // `hasMore: true` IS PART OF THE FIXTURE (fix wave 2, F2). It was left at
  // `baseState`'s default `false`, and that alone is why this pin stayed green
  // while fix wave 1 gated the empty COPY on `hasMore` - the state it is named
  // for carries a cursor (a page that FILLED mints one), so the pin could not
  // see the regression it exists to catch. A pin that cannot fail is worse than
  // no pin.
  it('a truncated page whose rows were all marked read is caught up, NOT an error', () => {
    state = baseState({
      status: 'ready',
      rows: [],
      truncated: true,
      serverRowCount: 3,
      hasMore: true,
    });
    renderInbox('/inbox?filter=unread');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load your inbox/i)).not.toBeInTheDocument();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
  });

  // F2, THE ORDINARY END OF A TRIAGE SESSION - and the state both round-2
  // reviewers found independently. The server filled a page of 30 unread and
  // minted a cursor because it FILLED, not because it stopped early. The
  // operator marks all 30 read, which is what the tab is for, and `useInbox`
  // narrows them out of `rows`. Gated on `hasMore` alone the empty copy became
  // "This search stopped early to stay fast" - false on both halves, and a
  // successful session ended by telling the operator the app had degraded.
  //
  // THE GATE IS A SERVER QUANTITY, `serverRowCount === 0 && hasMore`, which is
  // the same doctrine the truncation notice and the failure banner above
  // already carry: a claim about the SERVER page is never judged against
  // `rows`. The Load more STAYS - there really are more unread behind it.
  it('says all caught up - NOT "stopped early" - after the operator clears a full unread page', () => {
    state = baseState({
      status: 'ready',
      rows: [],
      truncated: false,
      serverRowCount: 30,
      hasMore: true,
    });
    renderInbox('/inbox?filter=unread');
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByText('Nothing on this page yet')).toBeNull();
    expect(screen.queryByText(/stopped early/i)).toBeNull();
    expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
  });

  it('renders rows and a Load more button when there is another page', () => {
    state = baseState({ rows: [mkRow()], hasMore: true });
    renderInbox();
    expect(screen.getByRole('link', { name: /Tasha Williams/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('switching to the Unread tab marks that tab selected', () => {
    renderInbox();
    fireEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(screen.getByRole('tab', { name: 'Unread' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opening a row calls markRead (opening marks read)', () => {
    state = baseState({ rows: [mkRow()] });
    renderInbox();
    fireEvent.click(screen.getByRole('link', { name: /Tasha Williams/ }));
    expect(markRead).toHaveBeenCalledTimes(1);
  });
});

describe('Inbox - the filter lives in the URL', () => {
  it('opens on the filter named by ?filter= (a real, shareable deep link)', () => {
    renderInbox('/inbox?filter=groups');
    expect(screen.getByRole('tab', { name: 'Groups' })).toHaveAttribute('aria-selected', 'true');
    expect(seenFilter).toBe('groups');
  });

  it('writes the filter to the URL when a tab is clicked', () => {
    renderInbox();
    fireEvent.click(screen.getByRole('tab', { name: 'Groups' }));
    expect(seenFilter).toBe('groups');
    expect(screen.getByRole('tab', { name: 'Groups' })).toHaveAttribute('aria-selected', 'true');
  });

  it('degrades an unrecognized filter to All instead of crashing or querying it', () => {
    renderInbox('/inbox?filter=bogus');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    expect(seenFilter).toBe('all');
  });

  it('shows the groups empty copy under the Groups filter', () => {
    state = baseState({ status: 'ready', rows: [] });
    renderInbox('/inbox?filter=groups');
    expect(screen.getByText('No group texts yet')).toBeInTheDocument();
  });
});

describe('Inbox - group truncation affordance', () => {
  const groupRow = mkRow({
    kind: 'group_text',
    contactId: undefined,
    channel: undefined,
    direction: undefined,
    name: 'With Ann & Marcus',
    conversationId: 'gt-1',
  });
  const contactRow = mkRow({ contactId: 'c-other', name: 'Sam Sender' });

  // A26, CORRECTED by adversarial 30. The count is the hook's `groupRowsShown`,
  // which now counts the RENDERED group rows rather than the server page: a
  // notice that names a number the list does not contain is a claim the screen
  // itself contradicts. The fixture is therefore consistent with `rows` on
  // purpose - two group rows in the list, two in the notice.
  it('says what is shown and links to the full list when the server truncated', () => {
    const groupRow2 = mkRow({
      kind: 'group_text',
      contactId: undefined,
      channel: undefined,
      direction: undefined,
      name: 'With Bo & Dev',
      conversationId: 'gt-2',
    });
    state = baseState({
      rows: [contactRow, groupRow, groupRow2],
      groupsTruncated: true,
      groupRowsShown: 2,
    });
    renderInbox();
    expect(screen.getByText(/Showing the latest 2 group texts\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all group texts' })).toHaveAttribute(
      'href',
      '/inbox?filter=groups',
    );
  });

  // C3 / conformance F11. One withheld group row rendered "Showing the latest 1
  // group texts", and two tests PINNED that string as correct. The tests were
  // wrong, not the code.
  it('says "group text", singular, for exactly one', () => {
    state = baseState({ rows: [contactRow, groupRow], groupsTruncated: true, groupRowsShown: 1 });
    renderInbox();
    expect(screen.getByText(/Showing the latest 1 group text\./)).toBeInTheDocument();
    expect(screen.queryByText(/1 group texts/)).toBeNull();
  });

  it('renders no affordance when nothing was withheld', () => {
    state = baseState({ rows: [contactRow, groupRow], groupRowsShown: 1 });
    renderInbox();
    expect(screen.queryByText(/Showing the latest/)).toBeNull();
  });

  it('drops the self-link once the Groups filter is already active', () => {
    state = baseState({ rows: [contactRow, groupRow], groupsTruncated: true, groupRowsShown: 1 });
    renderInbox('/inbox?filter=groups');
    expect(screen.getByText(/Showing the latest 1 group text\./)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'See all group texts' })).toBeNull();
  });

  // C12 / conformance F12. On the Unread tab the notice is about UNREAD group
  // texts, but the link lands on the Groups tab, which pages ALL of them. There
  // is no server-side unread-groups filter, so the affordance is LABELLED for
  // where it actually goes rather than implying a view that does not exist.
  it('is honest on the Unread tab about what it counted and where the link goes', () => {
    state = baseState({ rows: [groupRow], groupsTruncated: true, groupRowsShown: 1 });
    renderInbox('/inbox?filter=unread');
    expect(screen.getByText(/Showing the latest 1 unread group text\./)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Browse all group texts/ });
    expect(link).toHaveAttribute('href', '/inbox?filter=groups');
    expect(link).toHaveTextContent(/read and unread/);
  });

  // Adversarial 30, the other end of the same drift. On Unread the operator can
  // clear every group row on screen while the server's truncation flag stands,
  // so the count reaches zero with the notice still rendering. "Showing the
  // latest 0 group texts" is not a sentence - and the affordance it carries (the
  // link to the full list) is exactly what the operator needs at that moment, so
  // the notice stays and drops the count instead of disappearing.
  it('makes no "showing the latest" claim when no group rows are on screen', () => {
    state = baseState({ rows: [contactRow], groupsTruncated: true, groupRowsShown: 0 });
    renderInbox('/inbox?filter=unread');
    expect(screen.queryByText(/Showing the latest/)).toBeNull();
    expect(screen.queryByText(/0 group texts/)).toBeNull();
    expect(screen.getByText(/Not all group texts are shown here\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Browse all group texts/ })).toHaveAttribute(
      'href',
      '/inbox?filter=groups',
    );
  });
});

// S8. A truncated NON-EMPTY unread page used to end SILENTLY: on the CAPPED
// exits the server mints no cursor, so no "Load more" renders, and the
// truncation banner above is gated on the page having come back EMPTY - so a
// capped list looked exactly like the end of the feed. A cap is acceptable only
// if the list says it is capped. `hasMore` is deliberately NOT part of the gate:
// `truncated` also names rows that no page can reach, and those exits can mint a
// cursor too, so a `!hasMore` gate would go SILENT exactly there.
describe('Inbox - the Unread truncation notice', () => {
  const NOTICE =
    'Showing the most recent unread. There are older unread threads not shown here.';

  it('renders on a NON-EMPTY truncated unread page', () => {
    state = baseState({ rows: [mkRow()], truncated: true, serverRowCount: 1 });
    renderInbox('/inbox?filter=unread');
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it('renders no notice when the server did not truncate', () => {
    state = baseState({ rows: [mkRow()], truncated: false, serverRowCount: 1 });
    renderInbox('/inbox?filter=unread');
    expect(screen.queryByText(/Showing the most recent unread/)).toBeNull();
  });

  // The exact complement of `serverEndedEarlyEmpty`: an EMPTY server page that
  // says truncated keeps the shipped failure surface, and the two can never
  // render together.
  it('never renders alongside the empty-page truncation banner', () => {
    state = baseState({ status: 'ready', rows: [], truncated: true, serverRowCount: 0 });
    renderInbox('/inbox?filter=unread');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/Showing the most recent unread/)).toBeNull();
  });

  // Fix wave 2, REVERTING fix wave 1's `!hasMore` gate. `truncated` carries TWO
  // meanings on one wire flag: the pageable budget exit, and `unresolvedDrops`,
  // which is set AFTER the whole cursor chain and names rows no page in this
  // session can reach. Both can co-occur with a cursor, so `hasMore` cannot
  // separate them - and gating on it silenced the notice in the LEAST
  // recoverable state. The notice STAYS while paging is still available: an
  // imprecise notice beats silence about a badge disagreement.
  // Follow-up: docs/issues/inbox-truncated-flag-two-meanings.md.
  it('still renders while paging is available - a cursor does not mean the withheld rows are reachable', () => {
    state = baseState({ rows: [mkRow()], truncated: true, serverRowCount: 1, hasMore: true });
    renderInbox('/inbox?filter=unread');
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  // PLANNER REVIEW 2026-08-18. The copy is unread-specific, but the notice was
  // gated only on `truncated` - correct today purely because the server sets
  // that flag in the filter=unread branch alone, a dependency nothing on the
  // client encoded. And `useInbox` clears `truncated` in an EFFECT, so an
  // Unread -> All switch has one committed render where the filter is already
  // `all` while `truncated`/`serverRowCount` still describe the unread page.
  // Without the filter in the gate, the unread copy renders on the All tab.
  it('renders no notice on a NON-unread filter, even while truncated still describes the old page', () => {
    state = baseState({ rows: [mkRow()], truncated: true, serverRowCount: 1 });
    renderInbox('/inbox');
    expect(screen.queryByText(/Showing the most recent unread/)).toBeNull();
  });

  it('renders no notice on the groups filter under the same stale flag', () => {
    state = baseState({ rows: [mkRow()], truncated: true, serverRowCount: 1 });
    renderInbox('/inbox?filter=groups');
    expect(screen.queryByText(/Showing the most recent unread/)).toBeNull();
  });

  it('renders no notice on the error surface', () => {
    state = baseState({ status: 'error', truncated: true, serverRowCount: 3 });
    renderInbox('/inbox?filter=unread');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/Showing the most recent unread/)).toBeNull();
  });

  // THE test that matters. `truncated` and `serverRowCount` describe the SERVER
  // page; `rows` is the client-filtered list the Unread tab EMPTIES as the
  // operator marks rows read. Keyed on `rows` the notice vanishes mid-triage -
  // exactly when the operator most needs to know older unread threads are still
  // out there - and the first three cases above all stay green while that ships.
  it('STAYS rendered after every visible row is marked read', () => {
    const rowA = mkRow({ contactId: 'c-a', name: 'Alma Reed' });
    const rowB = mkRow({ contactId: 'c-b', name: 'Bo Nunez' });
    state = baseState({ rows: [rowA, rowB], truncated: true, serverRowCount: 2 });
    const view = renderInbox('/inbox?filter=unread');
    expect(screen.getByText(NOTICE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mark Alma Reed read' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark Bo Nunez read' }));
    expect(markRead).toHaveBeenCalledTimes(2);

    // What useInbox produces next: the Unread tab drops both rows, while the
    // SERVER statements it read - the truncation flag and the server row count -
    // are untouched (mark-read only patches `unreadCount`).
    state = baseState({ rows: [], truncated: true, serverRowCount: 2 });
    view.rerender(
      <MemoryRouter initialEntries={['/inbox?filter=unread']}>
        <Inbox />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('list', { name: 'Conversations' })).toBeNull();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });
});

describe('the Unknown tab empty state (contact-side read, 2026-08-25)', () => {
  it('an empty ready page renders the honest empty copy, never the failure banner', () => {
    state = baseState();
    renderInbox('/inbox?filter=unknown');
    expect(screen.getByText('No unknown numbers')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // M1 / blast-radius finding 2, THE DEAD END. The server deliberately returns
  // an EMPTY page WITH a cursor when its per-request scan budget expires
  // (app/src/routes/inbox.ts, the unknown branch's budget exit; pinned app-side
  // by test/inboxUnknownTab.test.ts "the SCAN BUDGET returns a SHORT page WITH
  // a cursor"). Load more used to be nested inside `rows.length > 0`, so that
  // state rendered the empty copy with NO affordance and every row behind the
  // budget was unreachable from the UI - the exact defect the rework was
  // chartered to remove, reintroduced one layer up. There was no dashboard pin,
  // so it shipped green.
  it('renders Load more on an EMPTY page that still carries a cursor - a budget-stopped page is not a dead end', () => {
    state = baseState({ status: 'ready', rows: [], hasMore: true });
    renderInbox('/inbox?filter=unknown');
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  // ...and the COPY changes with it. "No unknown numbers" over a live Load more
  // is a contradiction an operator reads as a broken app; the honest sentence is
  // that this page found nothing YET and there is more to read.
  it('says the page found nothing YET - not that the queue is empty - while a cursor stands', () => {
    state = baseState({ status: 'ready', rows: [], hasMore: true });
    renderInbox('/inbox?filter=unknown');
    expect(screen.queryByText('No unknown numbers')).toBeNull();
    expect(screen.getByText('Nothing on this page yet')).toBeInTheDocument();
  });

  it('keeps the real empty copy - and no Load more - once the walk has actually ended', () => {
    state = baseState({ status: 'ready', rows: [], hasMore: false });
    renderInbox('/inbox?filter=unknown');
    expect(screen.getByText('No unknown numbers')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('an empty page the server calls truncated DOES banner - which is why the unknown branch must never set the flag (requirement 5)', () => {
    // This pins the DEPENDENCY, not a wish: serverEndedEarlyEmpty is not
    // filter-gated (Inbox.tsx:42), so the server-side rule "no truncated on
    // filter=unknown" (routes/inbox.ts, the unknown branch's return) is what
    // keeps a cleared triage queue from rendering as a load failure.
    state = baseState({ truncated: true });
    renderInbox('/inbox?filter=unknown');
    expect(screen.queryByText('No unknown numbers')).toBeNull();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
