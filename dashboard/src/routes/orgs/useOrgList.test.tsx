// useOrgList tests - the picker's list (plan 3.11): loading, the entries,
// version and latest rewrite, a failed read reported (never an empty list),
// reload keeping the current data while it runs, and noteAdded counting a
// just-added name at once.
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';

const getOrgList = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, getOrgList: (...a: unknown[]) => getOrgList(...a) };
});

import { useOrgList, type OrgListState } from './useOrgList.js';

const ENTRY = {
  orgId: 'o1',
  kind: 'housing_authority',
  name: 'Atlanta Housing Authority',
  spellings: ['AHA'],
  createdAt: '2026-10-06T00:00:00.000Z',
  createdBy: 'system',
  updatedAt: '2026-10-06T00:00:00.000Z',
  updatedBy: 'system',
};

let latest: OrgListState | undefined;
function Probe(): React.JSX.Element {
  latest = useOrgList();
  return <div />;
}

beforeEach(() => {
  latest = undefined;
  getOrgList.mockReset();
});

describe('useOrgList', () => {
  it('starts loading, then holds the entries, the version and the latest rewrite', async () => {
    const lastRewrite = {
      jobId: 'j1',
      action: 'rename',
      fromTexts: ['A'],
      status: 'done',
      heartbeatAt: '2026-07-01T11:00:00.000Z',
      startedAt: '2026-07-01T11:00:00.000Z',
      startedBy: 'u1',
    };
    getOrgList.mockResolvedValue({ version: 4, entries: [ENTRY], lastRewrite });
    render(<Probe />);
    expect(latest!.loading).toBe(true);
    expect(latest!.entries).toEqual([]);
    await waitFor(() => expect(latest!.loading).toBe(false));
    expect(latest!.entries).toEqual([ENTRY]);
    expect(latest!.version).toBe(4);
    expect(latest!.lastRewrite).toEqual(lastRewrite);
    expect(latest!.error).toBe(false);
    expect(getOrgList).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('reports a failed read instead of an empty list', async () => {
    getOrgList.mockRejectedValue(new ApiError(503, 'org_list_busy', 'org_list_busy'));
    render(<Probe />);
    await waitFor(() => expect(latest!.error).toBe(true));
    expect(latest!.loading).toBe(false);
    expect(latest!.version).toBeNull();
  });

  it('reload re-reads and keeps the current entries while it runs', async () => {
    getOrgList.mockResolvedValueOnce({ version: 1, entries: [ENTRY] });
    render(<Probe />);
    await waitFor(() => expect(latest!.entries).toHaveLength(1));
    getOrgList.mockResolvedValueOnce({ version: 2, entries: [] });
    act(() => latest!.reload());
    expect(latest!.entries).toHaveLength(1);
    await waitFor(() => expect(latest!.version).toBe(2));
    expect(getOrgList).toHaveBeenCalledTimes(2);
  });

  it('poll() skips while a read is in flight, so a slow read is never aborted by a timer (R1-ADV-FE-5)', async () => {
    let land: (value: unknown) => void = () => {};
    getOrgList.mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve;
      }),
    );
    render(<Probe />);
    await waitFor(() => expect(getOrgList).toHaveBeenCalledTimes(1));
    act(() => latest!.poll());
    // Skipped: the mount read has not landed, and is not aborted.
    expect(getOrgList).toHaveBeenCalledTimes(1);
    expect((getOrgList.mock.calls[0]?.[0] as AbortSignal).aborted).toBe(false);
    await act(async () => land({ version: 1, entries: [ENTRY] }));
    expect(latest!.version).toBe(1);
    // Once it landed, the next poll reads again.
    getOrgList.mockResolvedValueOnce({ version: 2, entries: [ENTRY] });
    act(() => latest!.poll());
    await waitFor(() => expect(latest!.version).toBe(2));
    expect(getOrgList).toHaveBeenCalledTimes(2);
  });

  it('noteAdded counts a just-added entry at once, and until a read returns it (spec D6)', async () => {
    getOrgList.mockResolvedValueOnce({ version: 1, entries: [ENTRY] });
    render(<Probe />);
    await waitFor(() => expect(latest!.entries).toHaveLength(1));
    const added = { ...ENTRY, kind: 'housing_authority' as const, orgId: 'o2', name: 'Metro Housing Authority', spellings: [] };
    let land: (value: unknown) => void = () => {};
    getOrgList.mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve;
      }),
    );
    act(() => latest!.noteAdded(added));
    // Before the re-read lands the new name already counts: its chip never
    // flashes "Not on the list".
    expect(latest!.entries.map((e) => e.name)).toEqual(['Atlanta Housing Authority', 'Metro Housing Authority']);
    expect(getOrgList).toHaveBeenCalledTimes(2);
    // A read that does not return it yet keeps it counted...
    await act(async () => land({ version: 2, entries: [ENTRY] }));
    expect(latest!.entries.map((e) => e.name)).toEqual(['Atlanta Housing Authority', 'Metro Housing Authority']);
    // ...and once a read returns it, the server's copy is the only one.
    getOrgList.mockResolvedValueOnce({ version: 3, entries: [ENTRY, added] });
    act(() => latest!.reload());
    await waitFor(() => expect(latest!.version).toBe(3));
    expect(latest!.entries).toEqual([ENTRY, added]);
  });
});
