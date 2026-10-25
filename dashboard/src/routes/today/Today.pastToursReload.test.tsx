// Today across a failed past-tours RELOAD (fix wave 3, FW3-1; code review
// R3-1, its real-hooks probe made permanent): the REAL useToday and the REAL
// useTodayPastTours under the real page, with only the api barrel mocked.
// Today's queue is empty and past tours list nothing, so the page reads "All
// caught up". One tour.updated reaches every subscriber: Today's own refetch
// succeeds, the past-tours reload fails. The section must say so and the page
// must stop claiming "All caught up" - an unknown state is not "done" (spec
// 2.3). Today.test.tsx covers the page's handling of each hook state.
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type TodayResponse } from '../../api/index.js';

const getToday = vi.fn();
const getTours = vi.fn();
/** Each subscribing hook's latest handlers, keyed by the events it names
 *  (useToday names five, useTodayPastTours one). */
const subscribers = new Map<string, { onTourUpdated?: () => void }>();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getToday: (...a: unknown[]) => getToday(...a),
    getTours: (...a: unknown[]) => getTours(...a),
    useEventStream: (h: { onTourUpdated?: () => void }) => {
      subscribers.set(Object.keys(h).sort().join(','), h);
    },
  };
});

import { Today } from './Today.js';

/** Nothing on the checklist. */
const EMPTY: TodayResponse = {
  generatedAt: '2026-07-01T12:00:00.000Z',
  items: [],
  relayCloseNags: [],
  quietShares: { status: 'ok', truncated: false, properties: [] },
  toursToBook: 'ok',
};

const HEADING = 'Past tours needing an outcome';
const PAST_NOTE = 'Could not refresh past tours. Reload the page to see the latest.';
const TODAY_NOTE = "We couldn't refresh Today. Reload the page to see the latest.";

beforeEach(() => {
  getToday.mockReset().mockResolvedValue(EMPTY);
  // The Past tab's two reads (the range and status=toured) list nothing.
  getTours.mockReset().mockResolvedValue([]);
  subscribers.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Today across a failed past-tours reload, with the real hooks (fix wave 3)', () => {
  it('after an empty load, a failed past-tours reload withholds All caught up and the section says so', async () => {
    render(
      <MemoryRouter>
        <Today />
      </MemoryRouter>,
    );
    expect(await screen.findByText('All caught up')).toBeInTheDocument();
    expect(getTours).toHaveBeenCalledTimes(2);

    getTours.mockRejectedValue(new ApiError(503, 'unavailable', 'Service unavailable'));
    for (const handlers of subscribers.values()) handlers.onTourUpdated?.();
    // Both hooks heard it: the past-tours reload's two reads, Today's refetch.
    await waitFor(() => expect(getTours).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(getToday).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(screen.queryByText('All caught up')).not.toBeInTheDocument());
    const section = screen.getByRole('heading', { name: HEADING }).closest('section');
    if (section === null) throw new Error(`no section for ${HEADING}`);
    expect(within(section).getByRole('alert')).toHaveTextContent(PAST_NOTE);
    // Today's own refetch succeeded: no Today refresh note.
    expect(screen.queryByText(TODAY_NOTE)).not.toBeInTheDocument();
  });
});
