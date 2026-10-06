// AllToursView.test.tsx - the Tours page's All tab body (spec
// docs/superpowers/specs/2026-10-06-tour-list-design.md sections 4.3-4.9 and
// 6; plan S12).
//
// The REAL ToursPage routes are mounted (as ToursPage.test.tsx's renderPage
// does) with the REAL useAllTours over a mocked api barrel (an importActual
// spread, so ApiError is the real class). listTours answers from a script
// keyed by cursor ('' = a first page); a request with nothing scripted stays
// IN FLIGHT until the test lands or fails it, so the in-flight states can be
// observed. A /tours/:tourId probe shows the tour route's URL and offers a
// "Back to tours" link to state.back carrying state.restore - what TourDetail
// does (plan Task 12.3).
//
// Count lines are asserted by TEXT: a role="status" element takes no
// accessible name from its content, and the Spinner is a status too (named
// "Loading"), so the count line is the status WITHOUT an aria-label.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type TourListPage, type TourListParams, type TourListRow } from '../../api/index.js';

const listToursMock = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    listTours: (...args: unknown[]) => listToursMock(...args) as unknown,
    // Only the named views read these; stubbed so a stray visit stays offline.
    getTours: () => Promise.resolve([]),
    getAllContacts: () => Promise.resolve([]),
    getAllUnits: () => Promise.resolve([]),
  };
});

import { ToursPage } from './ToursPage.js';
import { whenLabel } from './tourTime.js';

// ---------------------------------------------------------------------------
// The scripted server
// ---------------------------------------------------------------------------

interface Call {
  params: TourListParams;
  opts: { cursor?: string; limit?: number };
  signal: AbortSignal | undefined;
  resolve: (page: TourListPage) => void;
  reject: (err: unknown) => void;
}

type Reply = TourListPage | Error;

let calls: Call[] = [];
let script = new Map<string, Reply[]>();

/** Queue replies for the next requests from `cursor` ('' = a first page). */
function reply(cursor: string, ...replies: Reply[]): void {
  script.set(cursor, [...(script.get(cursor) ?? []), ...replies]);
}

function call(i: number): Call {
  const c = calls[i];
  if (c === undefined) throw new Error(`no request #${i} (${calls.length} made)`);
  return c;
}

const lastCall = (): Call => call(calls.length - 1);
const optsOf = (): Array<Call['opts']> => calls.map((c) => c.opts);

beforeEach(() => {
  calls = [];
  script = new Map();
  listToursMock.mockReset();
  listToursMock.mockImplementation(
    (params: TourListParams, opts: { cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
      new Promise<TourListPage>((resolve, reject) => {
        calls.push({ params, opts, signal, resolve, reject });
        const next = script.get(opts.cursor ?? '')?.shift();
        if (next === undefined) return;
        if (next instanceof Error) reject(next);
        else resolve(next);
      }),
  );
});

/** Let every scripted reply and the renders it causes run to rest. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function land(c: Call, page: TourListPage): Promise<void> {
  await act(async () => {
    c.resolve(page);
  });
}

const cursor400 = (): ApiError => new ApiError(400, 'invalid cursor', 'invalid cursor');
const mismatch400 = (): ApiError => new ApiError(400, 'cursor_mismatch', 'cursor_mismatch');
const serverError = (): ApiError => new ApiError(500, 'http_500', 'boom');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DATED = '2026-07-10T14:00:00.000Z';

function row(id: string, over: Partial<TourListRow> = {}): TourListRow {
  return {
    tourId: id,
    tenantId: `tenant-${id}`,
    unitId: `unit-${id}`,
    scheduledAt: DATED,
    tourType: 'self_guided',
    status: 'scheduled',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

function rowsOf(prefix: string, n: number): TourListRow[] {
  return Array.from({ length: n }, (_, i) => row(`${prefix}${i}`));
}

/** A page whose name maps call every row's tenant `First <id>` and its
 *  property `<id> Main St`. */
function page(tours: TourListRow[], nextCursor: string | null): TourListPage {
  return {
    tours,
    contacts: Object.fromEntries(tours.map((t) => [t.tenantId, { firstName: `First ${t.tourId}` }])),
    units: Object.fromEntries(tours.map((t) => [t.unitId, { address: `${t.tourId} Main St` }])),
    nextCursor,
  };
}

/** A page of rows with the given tenant and property names (for search). */
function namedPage(entries: Array<[id: string, tenant: string, property: string]>, nextCursor: string | null): TourListPage {
  return {
    tours: entries.map(([id]) => row(id)),
    contacts: Object.fromEntries(entries.map(([id, tenant]) => [`tenant-${id}`, { firstName: tenant }])),
    units: Object.fromEntries(entries.map(([id, , property]) => [`unit-${id}`, { address: property }])),
    nextCursor,
  };
}

// ---------------------------------------------------------------------------
// The router harness
// ---------------------------------------------------------------------------

/** The current URL, entry key, navigation type and history state. A plain
 *  span: an <output> would add one more `status` role. */
function RouterProbe(): React.JSX.Element {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <span
      data-testid="router"
      data-key={location.key}
      data-nav={navigationType}
      data-state={JSON.stringify(location.state ?? null)}
    >
      {location.pathname + location.search}
    </span>
  );
}

/** The tour route: what TourDetail's back arrow does with the row's state
 *  (plan Task 12.3) - a "Back to tours" link to state.back carrying
 *  state.restore. */
function TourProbe(): React.JSX.Element {
  const location = useLocation();
  const state = (location.state ?? null) as { back?: unknown; restore?: unknown } | null;
  const back = typeof state?.back === 'string' ? state.back : '/tours';
  return (
    <div>
      <p data-testid="tour-route">{location.pathname + location.search}</p>
      <Link to={back} state={state?.restore === undefined ? undefined : { restore: state.restore }}>
        Back to tours
      </Link>
    </div>
  );
}

/** A stand-in for the browser's Back button. */
function BackButton(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      Browser back
    </button>
  );
}

type Entry = string | { pathname: string; search?: string; state?: unknown };

/** The tours routes as ToursPage.test.tsx mounts them, plus the tour probe.
 *  `from` puts an earlier history entry behind the list. */
function renderAt(entry: Entry = '/tours/all', from?: Entry) {
  return render(
    <MemoryRouter
      initialEntries={from === undefined ? [entry] : [from, entry]}
      initialIndex={from === undefined ? 0 : 1}
    >
      <Routes>
        <Route path="/tours" element={<ToursPage />} />
        <Route path="/tours/all" element={<ToursPage view="all" />} />
        <Route path="/tours/past" element={<ToursPage view="past" />} />
        <Route path="/tours/closed" element={<ToursPage view="closed" />} />
        <Route path="/tours/:tourId" element={<TourProbe />} />
        <Route path="/elsewhere" element={<p>Somewhere else</p>} />
      </Routes>
      <RouterProbe />
      <BackButton />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const list = (): HTMLElement => screen.getByRole('list', { name: 'All tours list' });
const rowLinks = (): HTMLElement[] => within(list()).getAllByRole('link');
const rowIds = (): string[] => rowLinks().map((a) => a.getAttribute('data-tour-id') ?? '');
const rowNames = (): string[] => rowLinks().map((a) => a.getAttribute('aria-label') ?? '');

/** The count line: the one status region that is not the Spinner. */
function countLine(): HTMLElement {
  const lines = screen.getAllByRole('status').filter((el) => !el.hasAttribute('aria-label'));
  if (lines.length !== 1) throw new Error(`expected one count line, found ${lines.length}`);
  return lines[0]!;
}
const countText = (): string => countLine().textContent ?? '';

const select = (name: string): HTMLSelectElement => screen.getByRole('combobox', { name });
const options = (el: HTMLSelectElement): string[] => Array.from(el.options).map((o) => o.textContent ?? '');
const pick = (el: HTMLElement, value: string): void => {
  fireEvent.change(el, { target: { value } });
};
const statusGroup = (): HTMLElement => screen.getByRole('group', { name: 'Status' });
/** A string `name` matches the WHOLE accessible name (testing-library). */
const chip = (name: string): HTMLElement => within(statusGroup()).getByRole('button', { name });
const chipLabels = (): string[] =>
  within(statusGroup())
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('aria-pressed'))
    .map((b) => b.textContent ?? '');
const searchBox = (): HTMLInputElement => screen.getByRole('searchbox', { name: 'Search' });
const typeSearch = (value: string): void => {
  fireEvent.change(searchBox(), { target: { value } });
};
const button = (name: string): HTMLElement => screen.getByRole('button', { name });
const expectNoButton = (name: string): void => {
  expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
};

const LOAD_FAILED = "We couldn't load tours. Please try again.";
const DEAD = "We couldn't load more tours.";

/** A first page is pending: the Spinner, an EMPTY count line (still mounted -
 *  ruling D-6), no rows and no action area. */
function expectLoading(): void {
  expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  expect(countText()).toBe('');
  expect(screen.queryByText(/Showing 0 tours/)).not.toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'All tours list' })).not.toBeInTheDocument();
  for (const name of ['Load more', 'Keep checking', 'Retry', 'Start over']) expectNoButton(name);
}

// ---------------------------------------------------------------------------
// Task 12.1 - filter bar, rows, count line, states
// ---------------------------------------------------------------------------

describe('AllToursView - rows (spec 4.4)', () => {
  it('loads the default list (when any, sort latest, limit 50) and renders every row in the page order', async () => {
    reply('', {
      tours: [
        row('t1', { tenantId: 'c1', unitId: 'u1' }),
        row('t2', { tenantId: 'c-missing', unitId: 'u-blank', scheduledAt: undefined, status: 'requested', tourType: 'landlord_led' }),
        row('t3', { tenantId: 'c3', unitId: 'u1', status: 'closed', outcome: 'not_a_fit', tourType: 'pm_team' }),
        row('t4', { tenantId: 'c4', unitId: 'u-missing', scheduledAt: undefined, status: 'toured', outcome: 'move_forward', convertible: true }),
      ],
      contacts: { c1: { firstName: 'Tasha', lastName: 'Nguyen' }, c3: { firstName: 'Ray' }, c4: {} },
      units: { u1: { address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA' } }, 'u-blank': {} },
      nextCursor: null,
    });
    renderAt();
    await settle();

    expect(calls).toHaveLength(1);
    expect(call(0).params).toStrictEqual({ when: 'any', sort: 'latest' });
    expect(call(0).opts).toStrictEqual({ limit: 50 });
    expect(rowIds()).toEqual(['t1', 't2', 't3', 't4']);
    // The accessible name: identity, the date column, the status label, and a
    // closed row's outcome. A missing name entry reads the raw id; an entry
    // with no name or phone reads "Unknown contact"; an address that formats
    // to nothing reads the unit id.
    expect(rowNames()).toEqual([
      `Tour for Tasha Nguyen at 12 Oak St, Atlanta, GA, ${whenLabel(DATED)}, Scheduled`,
      'Tour for c-missing at u-blank, Needs booking, Requested',
      `Tour for Ray at 12 Oak St, Atlanta, GA, ${whenLabel(DATED)}, Closed, Not a fit`,
      'Tour for Unknown contact at u-missing, Undated, Toured - needs placement',
    ]);
    const [first, second, third, fourth] = rowLinks();
    expect(first).toHaveAttribute('href', '/tours/t1');
    for (const text of ['Tasha Nguyen', '12 Oak St, Atlanta, GA', whenLabel(DATED), 'Scheduled', 'Self-guided']) {
      expect(within(first!).getByText(text)).toBeInTheDocument();
    }
    for (const text of ['c-missing', 'u-blank', 'Needs booking', 'Requested', 'Landlord-led']) {
      expect(within(second!).getByText(text)).toBeInTheDocument();
    }
    for (const text of ['Ray', 'Closed', 'Not a fit', 'PM team']) {
      expect(within(third!).getByText(text)).toBeInTheDocument();
    }
    expect(within(fourth!).getByText('Undated')).toBeInTheDocument();
    // An outcome badge only on a CLOSED row.
    expect(within(fourth!).queryByText('Move forward')).not.toBeInTheDocument();
    expect(fourth).toHaveAttribute('data-tour-id', 't4');
  });
});

describe('AllToursView - the filter bar (spec 4.3)', () => {
  it('When: Any time, Upcoming, Past, Date range; Upcoming sorts earliest by default; a picked sort sticks across When changes', async () => {
    renderAt();
    await settle();
    expect(options(select('When'))).toEqual(['Any time', 'Upcoming', 'Past', 'Date range']);
    expect(options(select('Sort'))).toEqual(['Latest first', 'Earliest first']);
    expect(select('Sort').value).toBe('latest');

    pick(select('When'), 'upcoming');
    await settle();
    expect(lastCall().params).toStrictEqual({ when: 'upcoming', sort: 'earliest' });
    expect(lastCall().opts).toStrictEqual({ limit: 50 });
    expect(select('Sort').value).toBe('earliest');

    pick(select('When'), 'past');
    await settle();
    expect(lastCall().params).toStrictEqual({ when: 'past', sort: 'latest' });
    pick(select('Sort'), 'earliest');
    await settle();
    expect(lastCall().params).toStrictEqual({ when: 'past', sort: 'earliest' });
    pick(select('When'), 'any');
    await settle();
    expect(lastCall().params).toStrictEqual({ when: 'any', sort: 'earliest' });
    expect(calls).toHaveLength(5);
  });

  it('Status: six chips in order under Any time; Needs booking sends status=requested; it is hidden (and pruned) under Upcoming, Past and Date range', async () => {
    renderAt();
    await settle();
    expect(chipLabels()).toEqual(['Needs booking', 'Scheduled', 'Toured', 'No show', 'Canceled', 'Closed']);
    expect(chip('Needs booking')).toHaveAttribute('aria-pressed', 'false');
    expectNoButton('Clear status filter');

    fireEvent.click(chip('Needs booking'));
    await settle();
    expect(chip('Needs booking')).toHaveAttribute('aria-pressed', 'true');
    expect(lastCall().params).toStrictEqual({ when: 'any', status: 'requested', sort: 'latest' });
    fireEvent.click(chip('No show'));
    await settle();
    expect(lastCall().params).toStrictEqual({ when: 'any', status: 'requested,no_show', sort: 'latest' });
    expect(button('Clear status filter')).toBeInTheDocument();

    pick(select('When'), 'upcoming');
    await settle();
    expect(chipLabels()).toEqual(['Scheduled', 'Toured', 'No show', 'Canceled', 'Closed']);
    expect(lastCall().params).toStrictEqual({ when: 'upcoming', status: 'no_show', sort: 'earliest' });
    pick(select('When'), 'past');
    await settle();
    expect(chipLabels()).toEqual(['Scheduled', 'Toured', 'No show', 'Canceled', 'Closed']);
    expect(lastCall().params).toStrictEqual({ when: 'past', status: 'no_show', sort: 'latest' });
    pick(select('When'), 'range');
    await settle();
    expect(chipLabels()).toEqual(['Scheduled', 'Toured', 'No show', 'Canceled', 'Closed']);
    expect(lastCall().params).toStrictEqual({ when: 'range', status: 'no_show', sort: 'latest' });
  });

  it('a URL status=requested under when=past sends NO status (pruned) and shows no Needs booking chip', async () => {
    renderAt('/tours/all?when=past&status=requested');
    await settle();
    expect(calls).toHaveLength(1);
    expect(call(0).params).toStrictEqual({ when: 'past', sort: 'latest' });
    expect(select('When').value).toBe('past');
    expect(chipLabels()).toEqual(['Scheduled', 'Toured', 'No show', 'Canceled', 'Closed']);
  });

  it('Tour type: All types, Self-guided, Landlord-led, PM team', async () => {
    renderAt();
    await settle();
    expect(options(select('Tour type'))).toEqual(['All types', 'Self-guided', 'Landlord-led', 'PM team']);
    pick(select('Tour type'), 'pm_team');
    await settle();
    expect(lastCall().params).toStrictEqual({ when: 'any', type: 'pm_team', sort: 'latest' });
  });

  it('the Search box is labelled Search with the placeholder Search tenant or property', async () => {
    renderAt();
    await settle();
    expect(searchBox()).toHaveAttribute('placeholder', 'Search tenant or property');
  });

  it('Clear filters shows once anything differs from the defaults and resets every control, the search included', async () => {
    renderAt();
    await settle();
    expectNoButton('Clear filters');
    typeSearch('x');
    expect(button('Clear filters')).toBeInTheDocument();
    typeSearch('');
    expectNoButton('Clear filters');

    pick(select('When'), 'past');
    fireEvent.click(chip('Toured'));
    pick(select('Tour type'), 'self_guided');
    pick(select('Sort'), 'earliest');
    typeSearch('Smith');
    await settle();
    expect(lastCall().params).toStrictEqual({ when: 'past', status: 'toured', type: 'self_guided', sort: 'earliest' });

    fireEvent.click(button('Clear filters'));
    await settle();
    expect(select('When').value).toBe('any');
    expect(chip('Toured')).toHaveAttribute('aria-pressed', 'false');
    expect(select('Tour type').value).toBe('');
    expect(select('Sort').value).toBe('latest');
    expect(searchBox().value).toBe('');
    expect(lastCall().params).toStrictEqual({ when: 'any', sort: 'latest' });
    expect(lastCall().opts).toStrictEqual({ limit: 50 });
    expectNoButton('Clear filters');
  });

  it('Date range: From and To show only under it; no bounds sends none; the bounds are local-day ends; From after To sends nothing and says so', async () => {
    renderAt();
    await settle();
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument();

    pick(select('When'), 'range');
    await settle();
    expect(lastCall().params).toStrictEqual({ when: 'range', sort: 'latest' });
    pick(screen.getByLabelText('From'), '2026-10-01');
    pick(screen.getByLabelText('To'), '2026-10-31');
    await settle();
    expect(lastCall().params).toStrictEqual({
      when: 'range',
      from: new Date(2026, 9, 1).toISOString(),
      to: new Date(new Date(2026, 9, 32).getTime() - 1).toISOString(),
      sort: 'latest',
    });

    const before = calls.length;
    pick(screen.getByLabelText('From'), '2026-11-05');
    await settle();
    expect(calls).toHaveLength(before);
    expect(screen.getByText('From must be on or before To.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
    expect(countText()).toBe('');
    expectNoButton('Load more');

    pick(screen.getByLabelText('From'), '2026-10-05');
    await settle();
    expect(calls).toHaveLength(before + 1);
    expect(screen.queryByText('From must be on or before To.')).not.toBeInTheDocument();
  });
});

describe('AllToursView - paging and the count line (spec 4.5)', () => {
  it.each([
    ['Showing 50 tours', 50, 'c1'],
    ['3 tours', 3, null],
    ['1 tour', 1, null],
    ['Showing 1 tour', 1, 'c1'],
  ] as const)('the count line reads "%s"', async (text, n, cursor) => {
    reply('', page(rowsOf('r', n), cursor));
    renderAt();
    await settle();
    expect(countText()).toBe(text);
  });

  it('reads Checking more tours... while it follows an empty page', async () => {
    reply('', page([], 'f0'));
    renderAt();
    await settle();
    expect(lastCall().opts).toStrictEqual({ cursor: 'f0', limit: 50 });
    expect(countText()).toBe('Checking more tours...');
    expectNoButton('Load more');
  });

  it('after 10 empty followed pages it stops: No more matches... with Keep checking and no Load more; Keep checking asks for the next page', async () => {
    reply('', page([], 'f0'));
    for (let i = 0; i < 10; i++) reply(`f${i}`, page([], `f${i + 1}`));
    renderAt();
    await settle();
    expect(calls).toHaveLength(11);
    expect(screen.getByText('No more matches in the tours checked so far.')).toBeInTheDocument();
    expectNoButton('Load more');

    fireEvent.click(button('Keep checking'));
    await settle();
    expect(calls).toHaveLength(12);
    expect(lastCall().opts).toStrictEqual({ cursor: 'f10', limit: 50 });
  });

  it('Load more shows only with a cursor and no loader running, and appends the next page', async () => {
    reply('', page([row('a1'), row('a2')], 'c1'));
    renderAt();
    await settle();
    fireEvent.click(button('Load more'));
    expect(lastCall().opts).toStrictEqual({ cursor: 'c1', limit: 50 });
    expectNoButton('Load more');
    await land(lastCall(), page([row('a3')], null));
    expect(rowIds()).toEqual(['a1', 'a2', 'a3']);
    expectNoButton('Load more');
    expect(countText()).toBe('3 tours');
  });

  it('while a first page is pending - on arrival, after a filter change, during the restart page 1 and after Start over - shows Loading with no count text and no actions', async () => {
    renderAt();
    expectLoading();
    // The count line is mounted, empty, from the start (D-6).
    const line = countLine();
    await land(call(0), page([row('a1')], 'c1'));
    expect(countText()).toBe('Showing 1 tour');
    expect(countLine()).toBe(line);

    pick(select('When'), 'past');
    expectLoading();
    expect(countLine()).toBe(line);
    await land(lastCall(), page([row('p1')], 'p-c1'));
    expect(countText()).toBe('Showing 1 tour');

    reply('p-c1', cursor400());
    fireEvent.click(button('Load more'));
    await settle();
    expect(lastCall().opts).toStrictEqual({ limit: 50 });
    expectLoading();
    await land(lastCall(), page([row('p2')], 'p-d1'));
    expect(countText()).toBe('Showing 1 tour The list was refreshed.');

    reply('p-d1', mismatch400());
    fireEvent.click(button('Load more'));
    await settle();
    fireEvent.click(button('Start over'));
    expectLoading();
    expect(countLine()).toBe(line);
  });
});

describe('AllToursView - states (spec 4.5)', () => {
  it('a first-page failure shows the message and Retry inside an alert (D-9); Retry loads the page again', async () => {
    reply('', serverError());
    renderAt();
    await settle();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(LOAD_FAILED);
    expect(countText()).toBe('');
    expectNoButton('Load more');

    reply('', page([row('a1')], null));
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(optsOf()).toStrictEqual([{ limit: 50 }, { limit: 50 }]);
    expect(rowIds()).toEqual(['a1']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a Load more failure keeps the rows and shows the same message with Retry, which asks for that page again', async () => {
    reply('', page([row('a1')], 'c1'));
    reply('c1', serverError());
    renderAt();
    await settle();
    fireEvent.click(button('Load more'));
    await settle();
    expect(rowIds()).toEqual(['a1']);
    expect(screen.getByText(LOAD_FAILED)).toBeInTheDocument();
    expectNoButton('Load more');

    reply('c1', page([row('a2')], null));
    fireEvent.click(button('Retry'));
    await settle();
    expect(optsOf()).toStrictEqual([{ limit: 50 }, { cursor: 'c1', limit: 50 }, { cursor: 'c1', limit: 50 }]);
    expect(rowIds()).toEqual(['a1', 'a2']);
    expect(screen.queryByText(LOAD_FAILED)).not.toBeInTheDocument();
  });

  it('a first cursor 400 restarts at page 1 and the count line also says The list was refreshed. until the next page lands', async () => {
    reply('', page([row('a1')], 'c1'), page([row('n1'), row('n2')], 'd1'));
    reply('c1', cursor400());
    renderAt();
    await settle();
    fireEvent.click(button('Load more'));
    await settle();
    expect(optsOf()).toStrictEqual([{ limit: 50 }, { cursor: 'c1', limit: 50 }, { limit: 50 }]);
    expect(rowIds()).toEqual(['n1', 'n2']);
    // Its own span inside the count line; the count text is unchanged.
    expect(within(countLine()).getByText('Showing 2 tours')).toBeInTheDocument();
    expect(within(countLine()).getByText('The list was refreshed.')).toBeInTheDocument();
    expect(countText()).toBe('Showing 2 tours The list was refreshed.');

    fireEvent.click(button('Load more'));
    expect(countText()).toBe('Showing 2 tours The list was refreshed.');
    await land(lastCall(), page([row('n3')], 'd2'));
    expect(countText()).toBe('Showing 3 tours');
  });

  it('a filter change drops the refreshed notice too', async () => {
    reply('', page([row('a1')], 'c1'), page([row('n1')], 'd1'), page([row('p1')], 'p-c1'));
    reply('c1', mismatch400());
    renderAt();
    await settle();
    fireEvent.click(button('Load more'));
    await settle();
    expect(countText()).toBe('Showing 1 tour The list was refreshed.');
    pick(select('When'), 'past');
    await settle();
    expect(rowIds()).toEqual(['p1']);
    expect(countText()).toBe('Showing 1 tour');
  });

  it("a second cursor 400 shows We couldn't load more tours. with Start over in place of Load more; Start over loads page 1 of a new list", async () => {
    reply('', page([row('a1')], 'c1'), page([row('n1')], 'd1'));
    reply('c1', cursor400());
    reply('d1', mismatch400());
    renderAt();
    await settle();
    fireEvent.click(button('Load more'));
    await settle();
    fireEvent.click(button('Load more'));
    await settle();
    expect(calls).toHaveLength(4);
    expect(screen.getByText(DEAD)).toBeInTheDocument();
    expectNoButton('Load more');
    expectNoButton('Retry');
    // Never "The list was refreshed." beside the dead list's message (F-s11 O1).
    expect(countText()).toBe('Showing 1 tour');

    reply('', page([row('s1')], null));
    fireEvent.click(button('Start over'));
    await settle();
    expect(calls).toHaveLength(5);
    expect(call(4).opts).toStrictEqual({ limit: 50 });
    expect(rowIds()).toEqual(['s1']);
    expect(countText()).toBe('1 tour');
    expect(screen.queryByText(DEAD)).not.toBeInTheDocument();
  });

  it('an empty complete list says No tours match these filters. - with Clear filters only when filters are set', async () => {
    reply('', page([], null));
    const first = renderAt();
    await settle();
    expect(screen.getByText('No tours match these filters.')).toBeInTheDocument();
    expect(countText()).toBe('0 tours');
    expectNoButton('Clear filters');
    first.unmount();

    reply('', page([], null));
    renderAt('/tours/all?when=past');
    await settle();
    const empty = screen.getByText('No tours match these filters.').parentElement!;
    expect(within(empty).getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });
});

describe('AllToursView - search (spec 6)', () => {
  const NAMES: Array<[string, string, string]> = [
    ['t1', 'Tasha Nguyen', '1 Oak St'],
    ['t2', 'Ray Smith', '2 Elm St'],
    ['t3', 'Ann Lee', '9 Smith Rd'],
  ];

  it('narrows the loaded rows at once (tenant or property, any case); 300 ms later the walk loads the rest with limit 100', async () => {
    reply('', namedPage(NAMES, 'c1'));
    renderAt();
    await settle();
    typeSearch('SMITH');
    expect(rowIds()).toEqual(['t2', 't3']);
    // Debounced: no walk request yet.
    expect(calls).toHaveLength(1);

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(call(1).opts).toStrictEqual({ cursor: 'c1', limit: 100 });
    expect(countText()).toBe('Searching... 2 matches so far');
    expectNoButton('Load more');

    await land(call(1), namedPage([['t4', 'Jo Smith', '4 Pine St'], ['t5', 'Kim Park', '5 Ash St']], 'c2'));
    expect(call(2).opts).toStrictEqual({ cursor: 'c2', limit: 100 });
    expect(rowIds()).toEqual(['t2', 't3', 't4']);
    expect(countText()).toBe('Searching... 3 matches so far');

    await land(call(2), namedPage([], null));
    expect(calls).toHaveLength(3);
    expect(countText()).toBe('3 matches');
    expectNoButton('Load more');
  });

  it('reads 1 match on a complete list', async () => {
    reply('', namedPage(NAMES, null));
    renderAt();
    await settle();
    typeSearch('tasha');
    expect(rowIds()).toEqual(['t1']);
    expect(countText()).toBe('1 match');
  });

  it('clearing the box aborts the walk at once - no further request - and keeps the loaded rows', async () => {
    reply('', namedPage(NAMES, 'c1'));
    renderAt();
    await settle();
    typeSearch('smith');
    await waitFor(() => expect(calls).toHaveLength(2));
    const walk = call(1);

    typeSearch('');
    await settle();
    expect(walk.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(2);
    expect(rowIds()).toEqual(['t1', 't2', 't3']);
    expect(countText()).toBe('Showing 3 tours');
    expect(button('Load more')).toBeInTheDocument();
  });

  it('stops at the walk cap (50 requests): N matches so far - not the whole list, and says the search stopped', async () => {
    reply('', namedPage([['t0', 'Ray Smith', '1 Oak St']], 'w0'));
    for (let i = 0; i < 50; i++) reply(`w${i}`, namedPage([[`x${i}`, 'Kim Park', `${i} Ash St`]], `w${i + 1}`));
    renderAt();
    await settle();
    typeSearch('smith');
    await waitFor(() => expect(calls).toHaveLength(51));
    await settle();
    expect(calls).toHaveLength(51);
    expect(within(countLine()).getByText('1 match so far - not the whole list')).toBeInTheDocument();
    expect(
      within(countLine()).getByText(
        'Search stopped before the end of the list. Narrow the filters to search the rest.',
      ),
    ).toBeInTheDocument();
    expect(button('Load more')).toBeInTheDocument();
  });

  it('a filter change while searching starts a new list and walks it', async () => {
    reply('', namedPage([['t1', 'Ray Smith', '1 Oak St']], 'c1'));
    renderAt();
    await settle();
    typeSearch('smith');
    await waitFor(() => expect(calls).toHaveLength(2));

    reply('', namedPage([['p1', 'Jo Smith', '2 Elm St']], 'p-c1'));
    pick(select('When'), 'past');
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(call(1).signal?.aborted).toBe(true);
    expect(call(2).params).toStrictEqual({ when: 'past', sort: 'latest' });
    expect(call(2).opts).toStrictEqual({ limit: 50 });
    expect(call(3).opts).toStrictEqual({ cursor: 'p-c1', limit: 100 });
  });
});
