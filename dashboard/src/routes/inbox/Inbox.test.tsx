import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow as InboxRowData } from '../../api/index.js';
import type { InboxState } from './useInbox.js';

let state: InboxState;
let seenFilter: string | undefined;
const markRead = vi.fn();
const loadMore = vi.fn();
const retry = vi.fn();

function baseState(over: Partial<InboxState> = {}): InboxState {
  return {
    status: 'ready',
    rows: [],
    groupsTruncated: false,
    truncated: false,
    groupRowsShown: 0,
    hasMore: false,
    loadingMore: false,
    loadMore,
    retry,
    markRead,
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
function renderInbox(entry = '/inbox'): void {
  render(
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
