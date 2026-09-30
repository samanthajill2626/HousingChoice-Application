import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayCloseNag, TodayItem, Tour } from '../../api/index.js';
import type { TodayPastTourRow, TodayPastToursState } from './useTodayPastTours.js';

// Drive the page entirely through a mocked useToday so the render test is
// independent of fetching/SSE (those are covered in useToday.test.tsx).
let state: {
  status: string;
  items: TodayItem[];
  source: string;
  relayCloseNags?: RelayCloseNag[];
  dismissNag?: (id: string) => void;
} = {
  status: 'loading',
  items: [],
  source: 'server',
};
vi.mock('./useToday.js', () => ({ useToday: () => state }));

// The past-tours section's hook, mocked the same way (its fetching is covered in
// useTodayPastTours.test.tsx). Default: settled, nothing to list, and the last
// reload did not fail (reloadFailed defaults to false unless a test sets it).
let past: Omit<TodayPastToursState, 'reloadFailed'> & { reloadFailed?: boolean } = {
  status: 'ready',
  rows: [],
  total: 0,
};
vi.mock('./useTodayPastTours.js', () => ({
  useTodayPastTours: (): TodayPastToursState => ({ reloadFailed: false, ...past }),
}));

// The nag card drives the two relay endpoints directly; mock them, keep the rest.
const closeConversation = vi.fn();
const deferCloseNag = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    closeConversation: (...a: unknown[]) => closeConversation(...a),
    deferCloseNag: (...a: unknown[]) => deferCloseNag(...a),
  };
});

import { Today } from './Today.js';

function renderToday(): void {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/tours/:tourId" element={<TourPageProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The tour route's stand-in: shows the query string and the router state the
 *  row link carried, so a test can read both after a click. */
function TourPageProbe(): React.JSX.Element {
  const location = useLocation();
  return (
    <div>
      TOUR PAGE <span data-testid="search">{location.search}</span>
      <span data-testid="state">{JSON.stringify(location.state)}</span>
    </div>
  );
}

function pastRow(tourId: string, over: Partial<Tour> = {}, labels: Partial<TodayPastTourRow> = {}): TodayPastTourRow {
  return {
    tour: {
      tourId,
      tenantId: 'c1',
      unitId: 'u1',
      scheduledAt: new Date(2026, 8, 24, 14, 30).toISOString(),
      tourType: 'self_guided',
      status: 'toured',
      ...over,
    } as Tour,
    tenant: 'Tasha Nguyen',
    property: '88 Sycamore St',
    ...labels,
  };
}

function makeNag(over: Partial<RelayCloseNag> = {}): RelayCloseNag {
  return {
    conversationId: 'g1',
    poolNumber: '+15550190001',
    memberNames: ['Ann', 'Marcus'],
    ownerType: 'tour',
    ownerId: 'tour-1',
    nagDueAt: '2026-07-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  state = { status: 'loading', items: [], source: 'server' };
  past = { status: 'ready', rows: [], total: 0 };
  closeConversation.mockReset().mockResolvedValue({});
  deferCloseNag.mockReset().mockResolvedValue({});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Today', () => {
  it('shows a Today heading and a spinner while loading', () => {
    state = { status: 'loading', items: [], source: 'server' };
    renderToday();
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an inline error message on error', () => {
    state = { status: 'error', items: [], source: 'server' };
    renderToday();
    expect(screen.getByText(/couldn.t load|something went wrong|try again/i)).toBeInTheDocument();
  });

  it('shows a friendly empty state when there is nothing to do', () => {
    state = { status: 'ready', items: [], source: 'server' };
    renderToday();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
  });

  it('renders only the non-empty groups, with rows, urgency, tag, and links', () => {
    state = {
      status: 'ready',
      source: 'fallback',
      items: [
        {
          group: 'needs_you_now',
          refType: 'placement',
          refId: 'k1',
          who: 'Tasha Williams',
          why: 'RTA window closing',
          urgency: '2h left',
          tag: 'Placement - Touring',
        },
        {
          group: 'needs_you_now',
          refType: 'conversation',
          refId: 'cv1',
          who: '(404) 010-0007',
          why: 'New inbound — untriaged',
          tag: 'Contact - Unknown',
          attention: true,
        },
        {
          group: 'unreplied',
          refType: 'contact',
          refId: 'ct1',
          who: 'James Porter',
          why: 'Is the 2BR still open?',
          tag: 'Contact - Landlord',
        },
      ],
    };
    renderToday();

    // Group headings present for non-empty groups; absent groups are skipped.
    // String names are EXACT matches: the headings are bare labels — the count
    // chips were removed 2026-08-03 ("Needs you now" has 2 rows here).
    expect(screen.getByRole('heading', { name: 'Needs you now' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unreplied' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Tours today/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Follow-ups/i })).not.toBeInTheDocument();

    // A placement row links to /placements/:id and shows who / why / urgency / tag.
    const placementLink = screen.getByRole('link', { name: /Tasha Williams/ });
    expect(placementLink).toHaveAttribute('href', '/placements/k1');
    expect(within(placementLink).getByText('RTA window closing')).toBeInTheDocument();
    expect(within(placementLink).getByText('2h left')).toBeInTheDocument();
    expect(within(placementLink).getByText('Placement - Touring')).toBeInTheDocument();

    // refType drives the link target: conversation → /conversations/:id.
    expect(screen.getByRole('link', { name: /\(404\) 010-0007/ })).toHaveAttribute(
      'href',
      '/conversations/cv1',
    );
    // contact → /contacts/:id.
    expect(screen.getByRole('link', { name: /James Porter/ })).toHaveAttribute(
      'href',
      '/contacts/ct1',
    );
  });

  it('renders the AI suggestions group with its label', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [
        {
          group: 'ai_suggestions',
          refType: 'contact',
          refId: 'k1',
          who: 'Tasha Williams',
          why: '2 suggestion(s)',
        },
      ],
    };
    renderToday();
    expect(screen.getByRole('heading', { name: /AI suggestions to review/i })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Tasha Williams/ });
    expect(link).toHaveAttribute('href', '/contacts/k1');
    expect(within(link).getByText('2 suggestion(s)')).toBeInTheDocument();
  });

  it('exposes each group as a list of rows', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [
        { group: 'tours_today', refType: 'placement', refId: 'k1', who: 'A', why: 'Tour today' },
        { group: 'tours_today', refType: 'placement', refId: 'k2', who: 'B', why: 'Tour today' },
      ],
    };
    renderToday();
    const list = screen.getByRole('list', { name: /Tours today/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('Today - relay close-nag card (D5)', () => {
  it('renders a nag with its pool number, copy, and an Open deep-link', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [],
      relayCloseNags: [makeNag()],
      dismissNag: vi.fn(),
    };
    renderToday();
    // Its own section (not "all caught up", even though items is empty). Exact
    // string name: the heading is a bare label (no count chip).
    expect(screen.getByRole('heading', { name: 'Relay groups to close' })).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
    // Pool number is display DATA (formatted), plus the close-it copy with members.
    expect(screen.getByText('(555) 019-0001')).toBeInTheDocument();
    expect(
      screen.getByText(/Relay group for Ann & Marcus is still open - close it\?/i),
    ).toBeInTheDocument();
    // Open deep-links the owning tour.
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/tours/tour-1');
  });

  it('Close wires closeConversation(true) and removes the row', async () => {
    const user = userEvent.setup();
    const dismissNag = vi.fn();
    state = {
      status: 'ready',
      source: 'server',
      items: [],
      relayCloseNags: [makeNag()],
      dismissNag,
    };
    renderToday();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(closeConversation).toHaveBeenCalledWith('g1', true);
    await waitFor(() => expect(dismissNag).toHaveBeenCalledWith('g1'));
    expect(deferCloseNag).not.toHaveBeenCalled();
  });

  it('Keep open wires the 28-day defer and removes the row', async () => {
    const user = userEvent.setup();
    const dismissNag = vi.fn();
    state = {
      status: 'ready',
      source: 'server',
      items: [],
      relayCloseNags: [makeNag()],
      dismissNag,
    };
    renderToday();
    await user.click(screen.getByRole('button', { name: 'Keep open' }));
    expect(deferCloseNag).toHaveBeenCalledWith('g1');
    await waitFor(() => expect(dismissNag).toHaveBeenCalledWith('g1'));
    expect(closeConversation).not.toHaveBeenCalled();
  });

  it('a nag with a tag names the tag instead of the members', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [],
      relayCloseNags: [makeNag({ tag: 'Maple St tour', ownerType: null, ownerId: undefined })],
      dismissNag: vi.fn(),
    };
    renderToday();
    expect(
      screen.getByText(/Relay group for Maple St tour is still open - close it\?/i),
    ).toBeInTheDocument();
    // No owner -> Open falls back to the conversation.
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/conversations/g1');
  });
});

describe('Today - past tours needing an outcome (Sam item 18)', () => {
  const HEADING = 'Past tours needing an outcome';

  it('sits after Follow-ups due and before AI suggestions to review', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [
        { group: 'follow_ups', refType: 'placement', refId: 'k1', who: 'A', why: 'Follow-up due' },
        { group: 'ai_suggestions', refType: 'contact', refId: 'k2', who: 'B', why: '1 suggestion(s)' },
      ],
    };
    past = { status: 'ready', rows: [pastRow('t1')], total: 1 };
    renderToday();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Follow-ups due', HEADING, 'AI suggestions to review']);
  });

  it('renders each row with tenant, property, date and the Past state, as one link', () => {
    state = { status: 'ready', source: 'server', items: [] };
    past = {
      status: 'ready',
      rows: [pastRow('t1', { status: 'scheduled' }), pastRow('t2', { outcome: 'move_forward', moveForward: true, convertible: true })],
      total: 2,
    };
    renderToday();
    const list = screen.getByRole('list', { name: HEADING });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const notMarked = within(list).getByRole('link', {
      name: 'Tour for Tasha Nguyen at 88 Sycamore St on Sep 24, 2026, 2:30 PM, Not marked',
    });
    expect(notMarked).toHaveAttribute('href', '/tours/t1');
    expect(within(notMarked).getByText('Tasha Nguyen')).toBeInTheDocument();
    expect(within(notMarked).getByText('88 Sycamore St')).toBeInTheDocument();
    expect(within(notMarked).getByText('Sep 24, 2026, 2:30 PM')).toBeInTheDocument();
    expect(within(notMarked).getByText('Not marked')).toBeInTheDocument();
    // A Needs placement row opens the plain tour page (Start placement lives there).
    expect(within(list).getByRole('link', { name: /, Needs placement$/ })).toHaveAttribute('href', '/tours/t2');
  });

  it('a Needs outcome row opens the tour with Record outcome up, and carries the back pointer to Today', async () => {
    const user = userEvent.setup();
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'ready', rows: [pastRow('t1')], total: 1 };
    renderToday();
    const link = screen.getByRole('link', { name: /, Needs outcome$/ });
    expect(link).toHaveAttribute('href', '/tours/t1?outcome=1');
    await user.click(link);
    expect(await screen.findByText(/TOUR PAGE/)).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?outcome=1');
    expect(screen.getByTestId('state')).toHaveTextContent('{"back":"/"}');
  });

  it('an undated row reads Undated, never a dangling "on"', () => {
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'ready', rows: [pastRow('t1', { scheduledAt: undefined })], total: 1 };
    renderToday();
    const link = screen.getByRole('link', { name: 'Tour for Tasha Nguyen at 88 Sycamore St, undated, Needs outcome' });
    expect(within(link).getByText('Undated')).toBeInTheDocument();
  });

  it('links "See all N on the Past tab" when it shows only some of them', () => {
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'ready', rows: ['a', 'b', 'c', 'd', 'e'].map((id) => pastRow(id)), total: 12 };
    renderToday();
    expect(within(screen.getByRole('list', { name: HEADING })).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByRole('link', { name: 'See all 12 on the Past tab' })).toHaveAttribute('href', '/tours/past');
  });

  it('links "Open the Past tab" when every one is shown', () => {
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'ready', rows: [pastRow('a')], total: 1 };
    renderToday();
    expect(screen.getByRole('link', { name: 'Open the Past tab' })).toHaveAttribute('href', '/tours/past');
    expect(screen.queryByRole('link', { name: /^See all/ })).not.toBeInTheDocument();
  });

  it('past tours alone are not "all caught up"', () => {
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'ready', rows: [pastRow('a')], total: 1 };
    renderToday();
    expect(screen.getByRole('heading', { name: HEADING })).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });

  it('"all caught up" waits while the section is still loading, and the page keeps its spinner', () => {
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'idle', rows: [], total: 0 };
    renderToday();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: HEADING })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('no spinner while the section loads when the queue already has rows', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [{ group: 'unreplied', refType: 'contact', refId: 'k1', who: 'A', why: 'Hi' }],
    };
    past = { status: 'idle', rows: [], total: 0 };
    renderToday();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('a "Tours today" row also carries the back pointer to Today', async () => {
    const user = userEvent.setup();
    state = {
      status: 'ready',
      source: 'server',
      items: [{ group: 'tours_today', refType: 'tour', refId: 'tt1', who: 'Tasha Nguyen', why: 'Tour today', tag: 'Tour' }],
    };
    renderToday();
    await user.click(screen.getByRole('link', { name: /Tasha Nguyen/ }));
    expect(await screen.findByText(/TOUR PAGE/)).toBeInTheDocument();
    expect(screen.getByTestId('state')).toHaveTextContent('{"back":"/"}');
  });

  it('links the Past tab count when the Past tab holds more than Today lists (its no-shows)', () => {
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'ready', rows: [pastRow('a'), pastRow('b')], total: 3 };
    renderToday();
    expect(screen.getByRole('link', { name: 'See all 3 on the Past tab' })).toHaveAttribute('href', '/tours/past');
  });

  it('no section at all when nothing qualifies', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [{ group: 'unreplied', refType: 'contact', refId: 'k1', who: 'A', why: 'Hi' }],
    };
    past = { status: 'ready', rows: [], total: 0 };
    renderToday();
    expect(screen.queryByRole('heading', { name: HEADING })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Past tab/ })).not.toBeInTheDocument();
  });

  it('a failed section load says so in the section and leaves the rest of Today alone', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [{ group: 'unreplied', refType: 'contact', refId: 'k1', who: 'James Porter', why: 'Hi' }],
    };
    past = { status: 'error', rows: [], total: 0 };
    renderToday();
    expect(screen.getByRole('heading', { name: HEADING })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load past tours/i);
    expect(screen.getByRole('link', { name: 'Open the Past tab' })).toHaveAttribute('href', '/tours/past');
    expect(screen.getByRole('link', { name: /James Porter/ })).toHaveAttribute('href', '/contacts/k1');
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });
});

describe('Today - round-2 review fixes', () => {
  it('a failed live reload keeps the rows and says so (N6)', () => {
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'ready', rows: [pastRow('a')], total: 1, reloadFailed: true };
    renderToday();
    expect(within(screen.getByRole('list', { name: 'Past tours needing an outcome' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not refresh past tours/i);
  });

  it('no refresh note when the last reload did not fail', () => {
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'ready', rows: [pastRow('a')], total: 1 };
    renderToday();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the close-nag Open link to a tour carries the back pointer to Today (N4)', async () => {
    const user = userEvent.setup();
    state = { status: 'ready', source: 'server', items: [], relayCloseNags: [makeNag()], dismissNag: vi.fn() };
    renderToday();
    await user.click(screen.getByRole('link', { name: 'Open' }));
    expect(await screen.findByText(/TOUR PAGE/)).toBeInTheDocument();
    expect(screen.getByTestId('state')).toHaveTextContent('{"back":"/"}');
  });
});
