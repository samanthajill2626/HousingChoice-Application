// useOrgAdmin tests - the Settings tab's data (spec 2026-10-06 D10, D11; R5
// ruling): the lists, the use counts and the "Not on the list" rows load on
// mount; only the lists repeat every pollMs while a rewrite runs with a fresh
// heartbeat, the counts and rows are read once more when it stops, and a
// details read in flight is never aborted.
import { act, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type OrgRewriteState } from '../../api/index.js';
import { noteServerDate, resetServerClockForTests } from '../../api/serverClock.js';

const getOrgList = vi.fn();
const getOrgUsage = vi.fn();
const getNotOnList = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getOrgList: (...a: unknown[]) => getOrgList(...a),
    getOrgUsage: (...a: unknown[]) => getOrgUsage(...a),
    getNotOnList: (...a: unknown[]) => getNotOnList(...a),
  };
});

import { useOrgAdmin, type OrgAdminState } from './useOrgAdmin.js';

// dashboard/src/test/setup.ts pins Date.now() to 2026-07-01T12:00:00Z.
const RUNNING: OrgRewriteState = {
  jobId: 'j1',
  action: 'rename',
  fromTexts: ['Atlanta HA'],
  fields: ['housingAuthority', 'accepted_authorities'],
  toName: 'Atlanta Housing Authority',
  status: 'running',
  heartbeatAt: '2026-07-01T11:59:50.000Z',
  startedAt: '2026-07-01T11:59:00.000Z',
  startedBy: 'u1',
};
const DONE: OrgRewriteState = { ...RUNNING, status: 'done', finishedAt: '2026-07-01T12:00:00.000Z' };
const COUNTS = { o1: { tenants: 2, otherContacts: 0, properties: 1, deleted: 0 } };
const ROW = {
  field: 'housingAuthority',
  value: 'AHA',
  count: 2,
  deletedCount: 0,
  resolution: { status: 'ambiguous', candidates: [] },
};

let latest: OrgAdminState | undefined;
function Probe({ pollMs }: { pollMs?: number }): React.JSX.Element {
  latest = useOrgAdmin(pollMs === undefined ? {} : { pollMs });
  return <div />;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  latest = undefined;
  getOrgList.mockReset().mockResolvedValue({ version: 1, entries: [] });
  getOrgUsage.mockReset().mockResolvedValue(COUNTS);
  getNotOnList.mockReset().mockResolvedValue([ROW]);
});

describe('useOrgAdmin', () => {
  it('loads the lists, the use counts and the "Not on the list" rows on mount', async () => {
    render(<Probe />);
    await waitFor(() => expect(latest!.notOnList).toEqual([ROW]));
    expect(latest!.usage).toEqual(COUNTS);
    await waitFor(() => expect(latest!.list.version).toBe(1));
    expect(latest!.rewriteLive).toBe(false);
    expect(getOrgUsage).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(getNotOnList).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('loads under StrictMode too (mount, cleanup, mount - every dev session and every e2e lane)', async () => {
    // main.tsx renders the app in <StrictMode> and the e2e lanes serve the
    // Vite dev server, so the first mount's read is aborted by a simulated
    // unmount at once. The second mount's read must start, not queue behind it.
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await waitFor(() => expect(latest!.notOnList).toEqual([ROW]));
    expect(latest!.usage).toEqual(COUNTS);
    const signals = getNotOnList.mock.calls.map((c) => c[0] as AbortSignal);
    expect(signals.at(-1)?.aborted).toBe(false);
  });

  it('a failed counts read is reported and the rows still load', async () => {
    getOrgUsage.mockRejectedValue(new ApiError(503, 'org_list_busy', 'org_list_busy'));
    render(<Probe />);
    await waitFor(() => expect(latest!.usageError).toBe(true));
    expect(latest!.notOnList).toEqual([ROW]);
    expect(latest!.usage).toBeNull();
  });

  it('while a rewrite runs polls ONLY the lists, and reads the counts and rows once more when it stops', async () => {
    getOrgList
      .mockResolvedValueOnce({ version: 1, entries: [], lastRewrite: RUNNING })
      .mockResolvedValueOnce({ version: 1, entries: [], lastRewrite: RUNNING })
      .mockResolvedValue({ version: 2, entries: [], lastRewrite: DONE });
    render(<Probe pollMs={25} />);
    await waitFor(() => expect(latest!.list.lastRewrite?.status).toBe('done'));
    expect(latest!.rewriteLive).toBe(false);
    await pause(100); // any in-flight tick settles; polling has stopped
    const listReads = getOrgList.mock.calls.length;
    expect(listReads).toBeGreaterThanOrEqual(3); // mount + two polls
    // The two full-scan reads: once on mount, once when the rewrite stopped -
    // never once per poll.
    await waitFor(() => expect(getNotOnList).toHaveBeenCalledTimes(2));
    expect(getOrgUsage).toHaveBeenCalledTimes(2);
    await pause(100);
    expect(getOrgList).toHaveBeenCalledTimes(listReads);
    expect(getNotOnList).toHaveBeenCalledTimes(2);
  });

  it('never aborts a details read in flight - reloads meanwhile run ONE more read after it lands', async () => {
    let land: (rows: unknown) => void = () => {};
    getNotOnList.mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve;
      }),
    );
    render(<Probe />);
    await waitFor(() => expect(getNotOnList).toHaveBeenCalledTimes(1));
    const firstSignal = getNotOnList.mock.calls[0]?.[0] as AbortSignal;
    act(() => latest!.reload());
    act(() => latest!.reload());
    // Still one scan in flight: neither aborted nor doubled.
    expect(getNotOnList).toHaveBeenCalledTimes(1);
    expect(firstSignal.aborted).toBe(false);
    await act(async () => land([ROW]));
    // The two reloads made while it ran became ONE more read.
    await waitFor(() => expect(getNotOnList).toHaveBeenCalledTimes(2));
    await pause(50);
    expect(getNotOnList).toHaveBeenCalledTimes(2);
    expect(latest!.notOnList).toEqual([ROW]);
  });

  it('does not poll a stalled rewrite (a heartbeat 15 minutes old or more)', async () => {
    getOrgList.mockResolvedValue({
      version: 1,
      entries: [],
      lastRewrite: { ...RUNNING, heartbeatAt: '2026-07-01T11:40:00.000Z' },
    });
    render(<Probe pollMs={20} />);
    await waitFor(() => expect(latest!.list.lastRewrite).toBeDefined());
    expect(latest!.rewriteLive).toBe(false);
    await pause(100);
    expect(getOrgList).toHaveBeenCalledTimes(1);
  });

  it('reload re-reads the lists, the counts and the rows', async () => {
    render(<Probe />);
    await waitFor(() => expect(latest!.notOnList).not.toBeNull());
    await waitFor(() => expect(latest!.list.loading).toBe(false));
    act(() => latest!.reload());
    await waitFor(() => expect(getNotOnList).toHaveBeenCalledTimes(2));
    expect(getOrgList).toHaveBeenCalledTimes(2);
    expect(getOrgUsage).toHaveBeenCalledTimes(2);
  });
});

// Code review R1-ADV-FE-5: every poll tick used to abort the list read in
// flight, so once a read took longer than pollMs (a slow phone, a cold
// backend) no read ever landed and the status line froze on "Updating
// records". A tick never aborts the poll's own read now.
describe('useOrgAdmin - a list read slower than the poll', () => {
  /** A list read that lands after 60 ms and rejects on abort, like fetch. */
  function slowRead(signal: AbortSignal, value: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), 60);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        },
        { once: true },
      );
    });
  }
  const signals = (): AbortSignal[] => getOrgList.mock.calls.map((c) => c[0] as AbortSignal);

  it('reads taking 60 ms with pollMs 25: the status still advances, and no poll read is aborted', async () => {
    getOrgList
      .mockResolvedValueOnce({ version: 1, entries: [], lastRewrite: RUNNING })
      .mockImplementation((signal: AbortSignal) => slowRead(signal, { version: 2, entries: [], lastRewrite: DONE }));
    render(<Probe pollMs={25} />);
    await waitFor(() => expect(latest!.list.lastRewrite?.status).toBe('done'));
    expect(latest!.rewriteLive).toBe(false);
    expect(signals().filter((s) => s.aborted)).toHaveLength(0);
  });

  it('the same under StrictMode (mount, cleanup, mount)', async () => {
    getOrgList
      .mockResolvedValueOnce({ version: 1, entries: [], lastRewrite: RUNNING })
      .mockResolvedValueOnce({ version: 1, entries: [], lastRewrite: RUNNING })
      .mockImplementation((signal: AbortSignal) => slowRead(signal, { version: 2, entries: [], lastRewrite: DONE }));
    render(
      <StrictMode>
        <Probe pollMs={25} />
      </StrictMode>,
    );
    await waitFor(() => expect(latest!.list.lastRewrite?.status).toBe('done'));
    expect(latest!.rewriteLive).toBe(false);
    // Only the first mount's read is aborted (by StrictMode's simulated unmount).
    expect(signals().slice(1).filter((s) => s.aborted)).toHaveLength(0);
  });
});

// Code review R1-ADV-FE-4: the heartbeat is a SERVER stamp and the server's
// 15-minute lock reads it on the server's clock, so the page must too
// (api/serverClock.ts). The browser is pinned to 12:00:00Z.
describe('useOrgAdmin - the heartbeat on the server clock', () => {
  afterEach(() => resetServerClockForTests());

  it('a browser running 20 minutes FAST still polls a rewrite whose heartbeat is 10 s old', async () => {
    noteServerDate('Wed, 01 Jul 2026 11:40:00 GMT', Date.now());
    getOrgList.mockResolvedValue({
      version: 1,
      entries: [],
      lastRewrite: { ...RUNNING, heartbeatAt: '2026-07-01T11:39:50.000Z' },
    });
    render(<Probe pollMs={20} />);
    await waitFor(() => expect(latest!.list.lastRewrite).toBeDefined());
    expect(latest!.rewriteLive).toBe(true);
    await waitFor(() => expect(getOrgList.mock.calls.length).toBeGreaterThan(1));
  });

  it('a browser running 20 minutes SLOW stops polling a rewrite whose heartbeat is 16 minutes old', async () => {
    noteServerDate('Wed, 01 Jul 2026 12:20:00 GMT', Date.now());
    getOrgList.mockResolvedValue({
      version: 1,
      entries: [],
      lastRewrite: { ...RUNNING, heartbeatAt: '2026-07-01T12:04:00.000Z' },
    });
    render(<Probe pollMs={20} />);
    await waitFor(() => expect(latest!.list.lastRewrite).toBeDefined());
    expect(latest!.rewriteLive).toBe(false);
    await pause(100);
    expect(getOrgList).toHaveBeenCalledTimes(1);
  });
});
