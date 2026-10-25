import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuietSharePerson, QuietShareProperty, RelayCloseNag, TodayItem, Tour } from '../../api/index.js';
import type { QuietSharesState } from './useToday.js';
import type { TodayPastTourRow, TodayPastToursState } from './useTodayPastTours.js';

// Drive the page entirely through a mocked useToday so the render test is
// independent of fetching/SSE (those are covered in useToday.test.tsx). The
// hook always sets quietShares / toursToBookStatus / generatedAt; a case that
// leaves them out gets the page's defaults (an empty, available Quiet shares
// and Tours to book), as relayCloseNags already does.
let state: {
  status: string;
  items: TodayItem[];
  source: string;
  relayCloseNags?: RelayCloseNag[];
  dismissNag?: (id: string) => void;
  quietShares?: QuietSharesState;
  toursToBookStatus?: 'ok' | 'unavailable';
  generatedAt?: string;
  refreshFailed?: boolean;
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

function todayTree(): React.JSX.Element {
  return (
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/tours/:tourId" element={<TourPageProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Renders the page; the result's rerender(todayTree()) re-reads `state`. */
function renderToday(): ReturnType<typeof render> {
  return render(todayTree());
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

/** test/setup.ts pins the clock to this instant; Quiet shares counts its days
 *  from the server's generatedAt. */
const GENERATED_AT = '2026-07-01T12:00:00.000Z';
const DAY_MS = 86_400_000;

function daysBefore(n: number): string {
  return new Date(Date.parse(GENERATED_AT) - n * DAY_MS).toISOString();
}

function quietPerson(contactId: string, over: Partial<QuietSharePerson> = {}): QuietSharePerson {
  return { contactId, name: `Name ${contactId}`, type: 'tenant', state: 'no_reply', quietSince: daysBefore(6), ...over };
}

function quietOk(properties: QuietShareProperty[]): QuietSharesState {
  // PR103: the wire carries no distinct-people count.
  return { status: 'ok', properties, truncated: false };
}

function item(group: TodayItem['group'], refId: string, over: Partial<TodayItem> = {}): TodayItem {
  return { group, refType: 'placement', refId, who: `Who ${refId}`, why: `Why ${refId}`, ...over };
}

/** The <section> a heading heads. */
function sectionOf(headingName: string): HTMLElement {
  const section = screen.getByRole('heading', { name: headingName }).closest('section');
  if (section === null) throw new Error(`no section for ${headingName}`);
  return section;
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

  it('renders only the non-empty checklist sections, with rows, urgency, tag, and links', () => {
    state = {
      status: 'ready',
      source: 'server',
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
          why: 'Opted out of the relay group',
          tag: 'Relay group',
          attention: true,
        },
        {
          group: 'identify',
          refType: 'contact',
          refId: 'ct1',
          who: 'James Porter',
          why: 'New unknown contact',
          tag: 'Contact - Unknown',
        },
      ],
    };
    renderToday();

    // Group headings present for non-empty groups; absent groups are skipped.
    // String names are EXACT matches: the headings are bare labels — the count
    // chips were removed 2026-08-03 ("Needs you now" has 2 rows here).
    expect(screen.getByRole('heading', { name: 'Needs you now' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Identify these contacts' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Tours today/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Placements/ })).not.toBeInTheDocument();
    // Unreplied is gone (spec 4), and so is the old Follow-ups heading.
    expect(screen.queryByRole('heading', { name: /Unreplied|Follow-ups/ })).not.toBeInTheDocument();

    // A placement row links to /placements/:id and shows who / why / urgency / tag.
    const placementLink = screen.getByRole('link', { name: /Tasha Williams/ });
    expect(placementLink).toHaveAttribute('href', '/placements/k1');
    expect(within(placementLink).getByText('RTA window closing')).toBeInTheDocument();
    expect(within(placementLink).getByText('2h left')).toBeInTheDocument();
    expect(within(placementLink).getByText('Placement - Touring')).toBeInTheDocument();

    // refType drives the link target: conversation -> /conversations/:id.
    expect(screen.getByRole('link', { name: /\(404\) 010-0007/ })).toHaveAttribute(
      'href',
      '/conversations/cv1',
    );
    // contact -> /contacts/:id.
    expect(screen.getByRole('link', { name: /James Porter/ })).toHaveAttribute(
      'href',
      '/contacts/ct1',
    );
  });

  it('shows the AI suggestions as one collapsed line whose list is absent until opened', async () => {
    const user = userEvent.setup();
    state = {
      status: 'ready',
      source: 'server',
      items: [
        { group: 'ai_suggestions', refType: 'contact', refId: 'k1', who: 'Tasha Williams', why: '2 suggestion(s)' },
        { group: 'ai_suggestions', refType: 'contact', refId: 'k2', who: 'Ann Lee', why: '1 suggestion(s)' },
      ],
    };
    renderToday();
    const line = screen.getByRole('button', { name: 'AI suggestions for 2 contacts' });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'AI suggestions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Tasha Williams/ })).not.toBeInTheDocument();
    await user.click(line);
    expect(line).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'AI suggestions' });
    expect(document.getElementById(line.getAttribute('aria-controls') ?? '')).toContainElement(list);
    const link = within(list).getByRole('link', { name: /Tasha Williams/ });
    expect(link).toHaveAttribute('href', '/contacts/k1');
    expect(within(link).getByText('2 suggestion(s)')).toBeInTheDocument();
  });

  it('names one AI suggestion contact in the singular', () => {
    state = { status: 'ready', source: 'server', items: [item('ai_suggestions', 'k1', { refType: 'contact' })] };
    renderToday();
    expect(screen.getByRole('button', { name: 'AI suggestions for 1 contact' })).toBeInTheDocument();
  });

  it('lists Tours today under At a glance as compact rows: local time, tenant, property', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [
        {
          group: 'tours_today',
          refType: 'tour',
          refId: 'tt1',
          who: 'Dana Ruiz',
          why: 'Tour today',
          tag: 'Tour',
          at: new Date(2026, 6, 1, 10, 0).toISOString(),
          unitLabel: '1458 Maple Ridge Dr SW',
        },
        {
          group: 'tours_today',
          refType: 'tour',
          refId: 'tt2',
          who: 'Tony Banks',
          why: 'Tour today',
          tag: 'Tour',
          at: new Date(2026, 6, 1, 14, 30).toISOString(),
          unitLabel: '910 Peachtree Pl NE',
        },
      ],
    };
    renderToday();
    const glance = sectionOf('At a glance');
    expect(within(glance).getByRole('heading', { level: 3, name: 'Tours today' })).toBeInTheDocument();
    const list = within(glance).getByRole('list', { name: 'Tours today' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const first = within(list).getByRole('link', { name: 'Tour for Dana Ruiz at 1458 Maple Ridge Dr SW, 10:00 AM' });
    expect(first).toHaveAttribute('href', '/tours/tt1');
    expect(within(first).getByText('10:00 AM')).toBeInTheDocument();
    expect(within(first).getByText('Dana Ruiz')).toBeInTheDocument();
    expect(within(first).getByText('1458 Maple Ridge Dr SW')).toBeInTheDocument();
    // Compact: no "Tour today" reason and no tag chip.
    expect(within(first).queryByText('Tour today')).not.toBeInTheDocument();
    expect(within(first).queryByText('Tour')).not.toBeInTheDocument();
  });
});

describe('Today - the checklist layout (spec 2026-10-23 2)', () => {
  function fullPage(): void {
    state = {
      status: 'ready',
      source: 'server',
      generatedAt: GENERATED_AT,
      items: [
        item('needs_you_now', 'n1'),
        item('identify', 'i1', { refType: 'contact' }),
        item('tours_to_book', 'b1', { refType: 'tour', urgency: 'Requested 3 days ago' }),
        item('follow_ups', 'f1'),
        item('tours_today', 't1', { refType: 'tour' }),
        item('ai_suggestions', 'a1', { refType: 'contact' }),
      ],
      relayCloseNags: [makeNag()],
      dismissNag: vi.fn(),
      quietShares: quietOk([{ unitId: 'u1', unitLabel: '12 Oak St', people: [quietPerson('q1')] }]),
      toursToBookStatus: 'ok',
    };
    past = { status: 'ready', rows: [pastRow('p1')], total: 1 };
  }

  it('orders the checklist sections, then At a glance below the divider', () => {
    fullPage();
    renderToday();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Needs you now',
      'Identify these contacts',
      'Past tours needing an outcome',
      'Tours to book',
      'Quiet shares',
      'Relay groups to close',
      'Placements',
      'At a glance',
    ]);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Tours today']);
    expect(screen.getByRole('button', { name: 'AI suggestions for 1 contact' })).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });

  it('reads the checklist subtitle', () => {
    state = { status: 'ready', source: 'server', items: [] };
    renderToday();
    expect(
      screen.getByText("Clear every section above the line and today's checklist is done. New messages are in the Inbox."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/What needs you, across every placement and contact/)).not.toBeInTheDocument();
  });

  it('shows the VA help lines on Identify, Tours to book and Quiet shares only', () => {
    fullPage();
    renderToday();
    expect(
      within(sectionOf('Identify these contacts')).getByText(
        "We don't know yet who these are. Call each one; after about a week with no contact, mark them Inactive.",
      ),
    ).toBeInTheDocument();
    expect(
      within(sectionOf('Tours to book')).getByText('Said yes to a property; the tour has no date yet. Oldest first.'),
    ).toBeInTheDocument();
    expect(
      within(sectionOf('Quiet shares')).getByText(
        'Properties sent in the last 14 days. Replied and then went quiet for 2+ days, or never replied in 5+ days. A message or call from either side restarts the clock; sending another property does not.',
      ),
    ).toBeInTheDocument();
    for (const heading of ['Needs you now', 'Past tours needing an outcome', 'Relay groups to close', 'Placements']) {
      // No paragraph at all in these sections: their rows already say why (spec 2.2).
      expect(sectionOf(heading).querySelectorAll('p')).toHaveLength(0);
    }
  });

  it('shows the first 5 rows of a section; Show all N expands it in place and Show fewer folds it', async () => {
    const user = userEvent.setup();
    state = {
      status: 'ready',
      source: 'server',
      items: Array.from({ length: 7 }, (_, i) => item('needs_you_now', `n${i}`)),
    };
    renderToday();
    const list = screen.getByRole('list', { name: 'Needs you now' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    // The heading carries no count (PR102); the button names all seven.
    expect(screen.getByRole('heading', { name: 'Needs you now' })).toHaveTextContent(/^Needs you now$/);
    const toggle = screen.getByRole('button', { name: 'Show all 7' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(toggle).toHaveAccessibleName('Show fewer');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  });

  it('Relay groups to close takes the same 5-row limit (spec 5.5)', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [],
      relayCloseNags: Array.from({ length: 6 }, (_, i) => makeNag({ conversationId: `g${i}` })),
      dismissNag: vi.fn(),
    };
    renderToday();
    expect(within(screen.getByRole('list', { name: 'Relay groups to close' })).getAllByRole('listitem')).toHaveLength(5);
    expect(within(sectionOf('Relay groups to close')).getByRole('button', { name: 'Show all 6' })).toBeInTheDocument();
  });

  it('a Tours to book row names the tenant, the property and the request age, and opens the tour with the back pointer', async () => {
    const user = userEvent.setup();
    state = {
      status: 'ready',
      source: 'server',
      items: [
        {
          group: 'tours_to_book',
          refType: 'tour',
          refId: 'tb1',
          who: 'Nia Porter',
          why: '1458 Maple Ridge Dr SW',
          urgency: 'Requested 3 days ago',
          at: daysBefore(3),
          unitLabel: '1458 Maple Ridge Dr SW',
        },
      ],
    };
    renderToday();
    const link = within(screen.getByRole('list', { name: 'Tours to book' })).getByRole('link', { name: /Nia Porter/ });
    expect(link).toHaveAttribute('href', '/tours/tb1');
    expect(within(link).getByText('1458 Maple Ridge Dr SW')).toBeInTheDocument();
    expect(within(link).getByText('Requested 3 days ago')).toBeInTheDocument();
    await user.click(link);
    expect(await screen.findByText(/TOUR PAGE/)).toBeInTheDocument();
    expect(screen.getByTestId('state')).toHaveTextContent('{"back":"/"}');
  });

  it('Quiet shares on the page: a bare heading, the first property is open, a person row opens the contact page', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [],
      generatedAt: GENERATED_AT,
      quietShares: quietOk(
        [
          {
            unitId: 'u1',
            unitLabel: '12 Oak St',
            people: [
              quietPerson('q-marcus', { name: 'Marcus Lee', state: 'replied', quietSince: daysBefore(3) }),
              quietPerson('q-dana', { name: 'Dana Ruiz' }),
            ],
          },
          { unitId: 'u2', unitLabel: '9 Elm Ave', people: [quietPerson('q-kim', { name: 'Kim Tran', quietSince: daysBefore(5) })] },
        ],
      ),
    };
    renderToday();
    expect(screen.getByRole('heading', { name: 'Quiet shares' })).toHaveTextContent(/^Quiet shares$/);
    expect(
      screen.getByRole('button', { name: '12 Oak St, 2 people: 1 replied, then quiet - 1 never replied' }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '9 Elm Ave, 1 person: 1 never replied' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const people = screen.getByRole('list', { name: 'People waiting on 12 Oak St' });
    expect(within(people).getByRole('link', { name: 'Marcus Lee, Replied, then quiet 3 days' })).toHaveAttribute(
      'href',
      '/contacts/q-marcus',
    );
    expect(within(people).getByRole('link', { name: 'Dana Ruiz, No reply in 6 days' })).toHaveAttribute(
      'href',
      '/contacts/q-dana',
    );
    expect(screen.queryByRole('list', { name: 'People waiting on 9 Elm Ave' })).not.toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });
});

describe('Today - All caught up (spec 2026-10-23 2.3, 2.5)', () => {
  it('ignores At a glance, which still renders below it', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [item('tours_today', 't1', { refType: 'tour' }), item('ai_suggestions', 'a1', { refType: 'contact' })],
    };
    renderToday();
    expect(screen.getByText('All caught up')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'At a glance' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Tours today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI suggestions for 1 contact' })).toBeInTheDocument();
  });

  it('no At a glance section when both of its parts are empty', () => {
    state = { status: 'ready', source: 'server', items: [] };
    renderToday();
    expect(screen.getByText('All caught up')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'At a glance' })).not.toBeInTheDocument();
  });

  it('a Tours to book the server could not compute says so in place and withholds All caught up', () => {
    state = { status: 'ready', source: 'server', items: [], toursToBookStatus: 'unavailable' };
    renderToday();
    expect(within(sectionOf('Tours to book')).getByRole('alert')).toHaveTextContent("We couldn't load tours to book.");
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });

  it('Quiet shares the server could not compute say so in place and withhold All caught up', () => {
    state = { status: 'ready', source: 'server', items: [], quietShares: { status: 'unavailable' } };
    renderToday();
    expect(within(sectionOf('Quiet shares')).getByRole('alert')).toHaveTextContent("We couldn't load quiet shares.");
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });

  it('the fallback shows one line instead of an error per section, and never All caught up', () => {
    state = {
      status: 'ready',
      source: 'fallback',
      items: [],
      quietShares: { status: 'unavailable' },
      toursToBookStatus: 'unavailable',
    };
    renderToday();
    expect(screen.getByText("Some sections can't load right now.")).toBeInTheDocument();
    expect(screen.queryByText(/We couldn.t load/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Tours to book|Quiet shares/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
    // Not a blank page either: no spinner left spinning.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('the fallback still renders its Identify rows', () => {
    state = {
      status: 'ready',
      source: 'fallback',
      items: [
        item('identify', 'unknown?phone=%2B14040100007', {
          refType: 'contact',
          who: '(404) 010-0007',
          tag: 'Contact - Unknown',
          attention: true,
        }),
      ],
      quietShares: { status: 'unavailable' },
      toursToBookStatus: 'unavailable',
    };
    renderToday();
    expect(screen.getByRole('heading', { name: 'Identify these contacts' })).toBeInTheDocument();
    expect(screen.getByText("Some sections can't load right now.")).toBeInTheDocument();
  });
});

// Fix wave 1 (FW1-1; code review R1A-2 / R1SC-1): after a good load, a failed
// live refetch keeps the checklist on screen (useToday stays 'ready' with
// refreshFailed set) under ONE note, and the page never claims "All caught
// up" on data it could not refresh (spec 2.3). Today.refetch.test.tsx drives
// the same through the real hook.
describe('Today - a failed live refresh (fix wave 1)', () => {
  const NOTE = "We couldn't refresh Today. Reload the page to see the latest.";

  it('keeps the checklist on screen with ONE alert note above the sections', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [item('needs_you_now', 'n1'), item('identify', 'i1', { refType: 'contact' })],
      refreshFailed: true,
    };
    renderToday();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    const note = screen.getByRole('alert');
    expect(note).toHaveTextContent(NOTE);
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(['Needs you now', 'Identify these contacts']);
    // Above the sections: the note precedes the first section heading.
    const firstSection = sectionOf('Needs you now');
    expect(note.compareDocumentPosition(firstSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/couldn.t load your queue/i)).not.toBeInTheDocument();
  });

  it('withholds All caught up while the refresh failed', () => {
    state = { status: 'ready', source: 'server', items: [], refreshFailed: true };
    renderToday();
    expect(screen.getByRole('alert')).toHaveTextContent(NOTE);
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });

  it('the next good load clears the note, and an empty checklist reads All caught up again', () => {
    state = { status: 'ready', source: 'server', items: [], refreshFailed: true };
    const view = renderToday();
    expect(screen.getByRole('alert')).toHaveTextContent(NOTE);
    state = { status: 'ready', source: 'server', items: [], refreshFailed: false };
    view.rerender(todayTree());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('All caught up')).toBeInTheDocument();
  });

  it('a FIRST-load failure keeps the full-page error, and no refresh note', () => {
    state = { status: 'error', items: [], source: 'server' };
    renderToday();
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load your queue. Please try again.");
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
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

  it('sits after Identify these contacts and before Tours to book (spec 2026-10-23 2)', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [item('identify', 'k1', { refType: 'contact' }), item('tours_to_book', 'k2', { refType: 'tour' })],
    };
    past = { status: 'ready', rows: [pastRow('t1')], total: 1 };
    renderToday();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Identify these contacts', HEADING, 'Tours to book']);
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

  it('a no-show row reads "No show" and opens the plain tour page (no ?outcome=1), back to Today', async () => {
    // Today lists the Past tab's no-shows (spec 9.4): the row's next step
    // (Reschedule, the no-show check-in) lives on the tour page itself.
    const user = userEvent.setup();
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'ready', rows: [pastRow('t3', { status: 'no_show' })], total: 1 };
    renderToday();
    const link = screen.getByRole('link', {
      name: 'Tour for Tasha Nguyen at 88 Sycamore St on Sep 24, 2026, 2:30 PM, No show',
    });
    expect(link).toHaveAttribute('href', '/tours/t3');
    expect(within(link).getByText('No show')).toBeInTheDocument();
    await user.click(link);
    expect(await screen.findByText(/TOUR PAGE/)).toBeInTheDocument();
    // No query string at all: Record outcome is not this row's next step.
    expect(screen.getByTestId('search').textContent).toBe('');
    expect(screen.getByTestId('state')).toHaveTextContent('{"back":"/"}');
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

  it('shows 5 rows with "Show all N" beside the Past tab link (spec 2.1)', async () => {
    const user = userEvent.setup();
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'ready', rows: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => pastRow(id)), total: 7 };
    renderToday();
    const list = screen.getByRole('list', { name: HEADING });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    const section = sectionOf(HEADING);
    const toggle = within(section).getByRole('button', { name: 'Show all 7' });
    const link = within(section).getByRole('link', { name: 'Open the Past tab' });
    expect(toggle.parentElement).toBe(link.parentElement);
    await user.click(toggle);
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
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
      items: [{ group: 'needs_you_now', refType: 'contact', refId: 'k1', who: 'A', why: 'Hi' }],
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

  it("links the Past tab count when the Past tab holds more than Today lists (a deleted tenant's tour)", () => {
    state = { status: 'ready', source: 'server', items: [] };
    past = { status: 'ready', rows: [pastRow('a'), pastRow('b')], total: 3 };
    renderToday();
    expect(screen.getByRole('link', { name: 'See all 3 on the Past tab' })).toHaveAttribute('href', '/tours/past');
  });

  it('no section at all when nothing qualifies', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [{ group: 'needs_you_now', refType: 'contact', refId: 'k1', who: 'A', why: 'Hi' }],
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
      items: [{ group: 'identify', refType: 'contact', refId: 'k1', who: 'James Porter', why: 'New unknown contact' }],
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

describe('Today - the sections below past tours are never held (round 4)', () => {
  it('the AI suggestions line renders at once while the past-tours section is still loading', () => {
    state = {
      status: 'ready',
      source: 'server',
      items: [{ group: 'ai_suggestions', refType: 'contact', refId: 'k2', who: 'Ann Lee', why: '1 suggestion(s)' }],
    };
    past = { status: 'idle', rows: [], total: 0 };
    renderToday();
    // Core content never waits on the section's best-effort lookups - and a
    // page with only an AI line is never a blank page (or a spinner).
    expect(screen.getByRole('button', { name: 'AI suggestions for 1 contact' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // But it is not "done" either until past tours settle.
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });
});
