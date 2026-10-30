// WP1 B2a spec D9, D11, D12: the rankings endpoint functions - call shape and
// unwrapping only, the transport mocked (the endpoints.test.ts pattern).
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('./client.js', () => ({
  request: vi.fn(() => Promise.resolve({})),
  requestWithStatus: vi.fn(() => Promise.resolve({ status: 200, body: {} })),
}));

import { request } from './client.js';
import {
  getRanking,
  getRankingCost,
  getRankingJob,
  getRankingRun,
  getUnitFairHousingFlags,
  listRankingRuns,
  startRanking,
} from './endpoints.js';

beforeEach(() => {
  vi.mocked(request).mockClear();
});

it('startRanking POSTs the press with its window choice and returns { job, joined }', async () => {
  const body = { job: { status: 'queued' }, joined: false };
  vi.mocked(request).mockResolvedValueOnce(body);
  await expect(startRanking('unit', 'unit 1', { includeOlder: true })).resolves.toEqual(body);
  expect(request).toHaveBeenLastCalledWith('/api/rankings/unit/unit%201/rank', {
    method: 'POST',
    body: { includeOlder: true },
  });
  await startRanking('tenant', 't1', { includeOlder: false });
  expect(request).toHaveBeenLastCalledWith('/api/rankings/tenant/t1/rank', {
    method: 'POST',
    body: { includeOlder: false },
  });
});

it('getRanking sends includeOlder only when it is on, and passes the signal', async () => {
  const signal = new AbortController().signal;
  await getRanking('unit', 'u1', { includeOlder: true }, signal);
  expect(request).toHaveBeenLastCalledWith('/api/rankings/unit/u1', {
    query: { includeOlder: 'true' },
    signal,
  });
  await getRanking('tenant', 't1', { includeOlder: false });
  expect(request).toHaveBeenLastCalledWith('/api/rankings/tenant/t1', { query: {} });
});

it('getRankingJob reads the job record only', async () => {
  vi.mocked(request).mockResolvedValueOnce({ job: null });
  await expect(getRankingJob('unit', 'u1')).resolves.toEqual({ job: null });
  expect(request).toHaveBeenLastCalledWith('/api/rankings/unit/u1/job', {});
});

it('listRankingRuns passes every filter and the cursor', async () => {
  vi.mocked(request).mockResolvedValueOnce({ runs: [], nextCursor: 'c2' });
  await expect(
    listRankingRuns({ from: '2026-07-01', to: '2026-07-07', anchorKind: 'unit', anchorId: 'u1', cursor: 'c1', limit: 25 }),
  ).resolves.toEqual({ runs: [], nextCursor: 'c2' });
  expect(request).toHaveBeenLastCalledWith('/api/admin/rankings/runs', {
    query: { from: '2026-07-01', to: '2026-07-07', anchorKind: 'unit', anchorId: 'u1', cursor: 'c1', limit: 25 },
  });
});

it('getRankingRun and getRankingCost read the admin routes', async () => {
  await getRankingRun('run 1');
  expect(request).toHaveBeenLastCalledWith('/api/admin/rankings/runs/run%201', {});
  await getRankingCost({ from: '2026-07-01' });
  expect(request).toHaveBeenLastCalledWith('/api/admin/rankings/cost', {
    query: { from: '2026-07-01', to: undefined },
  });
});

// Spec D10 rev 7 (charter item 16): the property page's read-only notice.
it("getUnitFairHousingFlags reads one property's open flags and passes the signal", async () => {
  const body = { flags: [{ field: 'qualifications', label: 'Qualifications', reason: 'flagged as a requirement fair housing does not allow' }] };
  vi.mocked(request).mockResolvedValueOnce(body);
  const signal = new AbortController().signal;
  await expect(getUnitFairHousingFlags('unit 1', signal)).resolves.toEqual(body);
  expect(request).toHaveBeenLastCalledWith('/api/rankings/unit/unit%201/flags', { signal });
  await getUnitFairHousingFlags('u1');
  expect(request).toHaveBeenLastCalledWith('/api/rankings/unit/u1/flags', {});
});
