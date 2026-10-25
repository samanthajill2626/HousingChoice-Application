// Today across a failed live refetch (fix wave 1, FW1-1; code review R1A-2 /
// R1SC-1, their probes made permanent): the REAL useToday under the real page,
// with only the api barrel and the past-tours hook mocked. One live refetch
// fails and the next succeeds with the SAME data; what the viewer opened,
// folded or expanded must survive it - spec 6.3 ("the viewer's choices are
// kept by unitId across live refetches"), spec 2.1 (expansion is lost only on
// reload). Today.test.tsx covers the page's handling of each hook state.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type TodayItem, type TodayResponse } from '../../api/index.js';
import type { TodayPastToursState } from './useTodayPastTours.js';

const getToday = vi.fn();
// The client fallback's three reads (a 404 from GET /api/today, spec 3.1).
const getAllPlacements = vi.fn();
const getAllConversations = vi.fn();
const getTours = vi.fn();
let handlers: { onConversationUpdated?: () => void } = {};
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getToday: (...a: unknown[]) => getToday(...a),
    getAllPlacements: (...a: unknown[]) => getAllPlacements(...a),
    getAllConversations: (...a: unknown[]) => getAllConversations(...a),
    getTours: (...a: unknown[]) => getTours(...a),
    useEventStream: (h: typeof handlers) => {
      handlers = h;
    },
  };
});

// Past tours settle with nothing to list (useTodayPastTours.test.tsx covers
// them), so only useToday drives the page here.
vi.mock('./useTodayPastTours.js', () => ({
  useTodayPastTours: (): TodayPastToursState => ({ status: 'ready', rows: [], total: 0, reloadFailed: false }),
}));

import { Today } from './Today.js';

/** test/setup.ts pins the clock to this instant. */
const GENERATED_AT = '2026-07-01T12:00:00.000Z';
const SIX_DAYS_AGO = new Date(Date.parse(GENERATED_AT) - 6 * 86_400_000).toISOString();

function row(group: TodayItem['group'], refId: string, over: Partial<TodayItem> = {}): TodayItem {
  return { group, refType: 'placement', refId, who: `Who ${refId}`, why: `Why ${refId}`, ...over };
}

/** Two quiet-share properties, seven Needs you now rows (Show all 7) and one
 *  AI suggestion (the collapsed line). */
const LOADED: TodayResponse = {
  generatedAt: GENERATED_AT,
  items: [
    ...Array.from({ length: 7 }, (_, i) => row('needs_you_now', `n${i}`)),
    row('ai_suggestions', 'a1', { refType: 'contact', who: 'Ann Lee', why: '1 suggestion(s)' }),
  ],
  relayCloseNags: [],
  quietShares: {
    status: 'ok',
    truncated: false,
    properties: [
      {
        unitId: 'u1',
        unitLabel: '12 Oak St',
        people: [{ contactId: 'q1', name: 'Dana Ruiz', type: 'tenant', state: 'no_reply', quietSince: SIX_DAYS_AGO }],
      },
      {
        unitId: 'u2',
        unitLabel: '9 Elm Ave',
        people: [{ contactId: 'q2', name: 'Kim Tran', type: 'tenant', state: 'no_reply', quietSince: SIX_DAYS_AGO }],
      },
    ],
  },
  toursToBook: 'ok',
};

/** Nothing on the checklist: the page reads "All caught up". */
const EMPTY: TodayResponse = {
  generatedAt: GENERATED_AT,
  items: [],
  relayCloseNags: [],
  quietShares: { status: 'ok', truncated: false, properties: [] },
  toursToBook: 'ok',
};

const NOTE = "We couldn't refresh Today. Reload the page to see the latest.";

function renderPage(): void {
  render(
    <MemoryRouter>
      <Today />
    </MemoryRouter>,
  );
}

/** One live refetch fails, then the next succeeds with the same data. Waits
 *  only on what both a failure and its recovery always show (an alert, then
 *  none), so the state assertions after it are the ones under test. */
async function failThenRecover(): Promise<void> {
  getToday.mockRejectedValueOnce(new ApiError(500, 'boom', 'server error'));
  handlers.onConversationUpdated?.();
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  handlers.onConversationUpdated?.();
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(getToday).toHaveBeenCalledTimes(3);
}

const propertyLine = (unitLabel: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`^${unitLabel}, `) });

beforeEach(() => {
  getToday.mockReset();
  getToday.mockResolvedValue(LOADED);
  // The fallback, when a case triggers it, assembles from nothing.
  getAllPlacements.mockReset().mockResolvedValue([]);
  getAllConversations.mockReset().mockResolvedValue([]);
  getTours.mockReset().mockResolvedValue([]);
  handlers = {};
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Today across a failed live refetch (fix wave 1)', () => {
  it('quiet-share open/folded choices survive a failed-then-successful live refetch (spec 6.3)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Quiet shares' });
    expect(propertyLine('12 Oak St')).toHaveAttribute('aria-expanded', 'true'); // seeded open
    await user.click(propertyLine('12 Oak St')); // fold the seeded one
    await user.click(propertyLine('9 Elm Ave')); // open the second
    expect(propertyLine('12 Oak St')).toHaveAttribute('aria-expanded', 'false');
    expect(propertyLine('9 Elm Ave')).toHaveAttribute('aria-expanded', 'true');

    await failThenRecover();

    expect(propertyLine('12 Oak St')).toHaveAttribute('aria-expanded', 'false');
    expect(propertyLine('9 Elm Ave')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list', { name: 'People waiting on 9 Elm Ave' })).toBeInTheDocument();
  });

  it('a Show all expansion survives a failed-then-successful live refetch (spec 2.1)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Show all 7' }));
    expect(within(screen.getByRole('list', { name: 'Needs you now' })).getAllByRole('listitem')).toHaveLength(7);

    await failThenRecover();

    expect(within(screen.getByRole('list', { name: 'Needs you now' })).getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });

  it("the AI line's open state survives a failed-then-successful live refetch", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'AI suggestions for 1 contact' }));
    expect(screen.getByRole('list', { name: 'AI suggestions' })).toBeInTheDocument();

    await failThenRecover();

    expect(screen.getByRole('button', { name: 'AI suggestions for 1 contact' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list', { name: 'AI suggestions' })).toBeInTheDocument();
  });

  it('while a refetch has failed: ONE refresh note and no All caught up; the next good load clears it', async () => {
    getToday.mockResolvedValue(EMPTY);
    renderPage();
    expect(await screen.findByText('All caught up')).toBeInTheDocument();

    getToday.mockRejectedValueOnce(new ApiError(500, 'boom', 'server error'));
    handlers.onConversationUpdated?.();
    expect(await screen.findByRole('alert')).toHaveTextContent(NOTE);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByText('All caught up')).not.toBeInTheDocument();

    handlers.onConversationUpdated?.();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('All caught up')).toBeInTheDocument();
  });

  it('a FIRST-load failure still shows the full-page error, with no checklist and no refresh note', async () => {
    getToday.mockRejectedValue(new ApiError(500, 'boom', 'server error'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load your queue. Please try again.");
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
  });
});

// Fix wave 2 (FW2-2; code review R2-2, its probes made permanent): a live
// refetch the route ANSWERS can still drop a section - Tours to book or Quiet
// shares unavailable (spec 2.5), or a 404 and the client fallback (spec 3.1),
// which shows neither. The per-viewer state must outlive that load too (spec
// 6.3, 2.1): the next good load shows what the viewer expanded, opened and
// folded.

/** Seven Tours to book rows (Show all 7), seven quiet-share properties ("Show
 *  all 7 properties") and six relay groups to close (Show all 6). */
const MANY: TodayResponse = {
  generatedAt: GENERATED_AT,
  items: Array.from({ length: 7 }, (_, i) =>
    row('tours_to_book', `b${i}`, { refType: 'tour', urgency: 'Requested 3 days ago' }),
  ),
  relayCloseNags: Array.from({ length: 6 }, (_, i) => ({
    conversationId: `g${i}`,
    poolNumber: `+1555019000${i}`,
    memberNames: [`Member ${i}`],
    ownerType: null,
    nagDueAt: '2026-07-01T00:00:00Z',
  })),
  quietShares: {
    status: 'ok',
    truncated: false,
    properties: Array.from({ length: 7 }, (_, i) => ({
      unitId: `p${i}`,
      unitLabel: `${i + 1} Pine St`,
      people: [{ contactId: `qp${i}`, name: `Person ${i}`, type: 'tenant', state: 'no_reply', quietSince: SIX_DAYS_AGO }],
    })),
  },
  toursToBook: 'ok',
};

const FALLBACK_LINE = "Some sections can't load right now.";

/** The <section> a heading heads. */
function sectionOf(headingName: string): HTMLElement {
  const section = screen.getByRole('heading', { name: headingName }).closest('section');
  if (section === null) throw new Error(`no section for ${headingName}`);
  return section;
}

/** One live refetch is answered by `drop` (a load that shows `shows`), then
 *  the next by the default load again. Waits on `shows` and then on its
 *  absence, so it cannot pass on a missed refetch; `during` runs while the
 *  dropped load is on screen. */
async function dropThenRecover(drop: () => void, shows: string, during?: () => void): Promise<void> {
  drop();
  handlers.onConversationUpdated?.();
  expect(await screen.findByText(shows)).toBeInTheDocument();
  during?.();
  handlers.onConversationUpdated?.();
  await waitFor(() => expect(screen.queryByText(shows)).not.toBeInTheDocument());
  expect(getToday).toHaveBeenCalledTimes(3);
}

const quietLines = (): HTMLElement[] =>
  within(screen.getByRole('list', { name: 'Quiet shares' })).getAllByRole('button', { name: / Pine St, / });

describe('Today across a live refetch that drops a section (fix wave 2)', () => {
  it('Tours to book: a Show all expansion survives one refetch where the section was unavailable (spec 2.1, 2.5)', async () => {
    const user = userEvent.setup();
    getToday.mockResolvedValue(MANY);
    renderPage();
    await screen.findByRole('heading', { name: 'Tours to book' });
    await user.click(within(sectionOf('Tours to book')).getByRole('button', { name: 'Show all 7' }));
    expect(within(screen.getByRole('list', { name: 'Tours to book' })).getAllByRole('listitem')).toHaveLength(7);

    await dropThenRecover(
      () =>
        getToday.mockResolvedValueOnce({
          ...MANY,
          items: MANY.items.filter((i) => i.group !== 'tours_to_book'),
          toursToBook: 'unavailable',
        }),
      "We couldn't load tours to book.",
    );

    expect(within(screen.getByRole('list', { name: 'Tours to book' })).getAllByRole('listitem')).toHaveLength(7);
    expect(within(sectionOf('Tours to book')).getByRole('button', { name: 'Show fewer' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('Quiet shares: "Show all 7 properties" survives one refetch where the section was unavailable (spec 2.1, 6.3)', async () => {
    const user = userEvent.setup();
    getToday.mockResolvedValue(MANY);
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Show all 7 properties' }));
    expect(quietLines()).toHaveLength(7);

    await dropThenRecover(
      () => getToday.mockResolvedValueOnce({ ...MANY, quietShares: { status: 'unavailable' } }),
      "We couldn't load quiet shares.",
    );

    expect(quietLines()).toHaveLength(7);
    expect(within(sectionOf('Quiet shares')).getByRole('button', { name: 'Show fewer' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('Quiet shares: open/folded choices survive one FALLBACK refetch (a 404), which shows no section and no alert (spec 6.3, 3.1)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Quiet shares' });
    expect(propertyLine('12 Oak St')).toHaveAttribute('aria-expanded', 'true'); // seeded open
    await user.click(propertyLine('12 Oak St')); // fold the seeded one
    await user.click(propertyLine('9 Elm Ave')); // open the second

    await dropThenRecover(
      () => getToday.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Not found')),
      FALLBACK_LINE,
      () => {
        // The fallback's own posture is unchanged: one line, no Quiet shares,
        // no per-section alert.
        expect(screen.queryByRole('heading', { name: 'Quiet shares' })).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      },
    );

    expect(propertyLine('12 Oak St')).toHaveAttribute('aria-expanded', 'false');
    expect(propertyLine('9 Elm Ave')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list', { name: 'People waiting on 9 Elm Ave' })).toBeInTheDocument();
  });

  it('Show all expansions survive one FALLBACK refetch: Tours to book, Quiet shares, Relay groups to close (spec 2.1, 3.1)', async () => {
    const user = userEvent.setup();
    getToday.mockResolvedValue(MANY);
    renderPage();
    await screen.findByRole('heading', { name: 'Tours to book' });
    await user.click(within(sectionOf('Tours to book')).getByRole('button', { name: 'Show all 7' }));
    await user.click(within(sectionOf('Quiet shares')).getByRole('button', { name: 'Show all 7 properties' }));
    await user.click(within(sectionOf('Relay groups to close')).getByRole('button', { name: 'Show all 6' }));

    await dropThenRecover(() => getToday.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Not found')), FALLBACK_LINE);

    expect(within(screen.getByRole('list', { name: 'Tours to book' })).getAllByRole('listitem')).toHaveLength(7);
    expect(quietLines()).toHaveLength(7);
    expect(within(screen.getByRole('list', { name: 'Relay groups to close' })).getAllByRole('listitem')).toHaveLength(6);
    for (const heading of ['Tours to book', 'Quiet shares', 'Relay groups to close']) {
      expect(within(sectionOf(heading)).getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
    }
  });
});
