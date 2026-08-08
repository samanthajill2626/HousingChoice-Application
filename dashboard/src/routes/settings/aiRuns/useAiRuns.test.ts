import { act, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRunDetailResponse, AiRunListPage } from '../../../api/index.js';

const listAiRuns = vi.fn();
const getAiRun = vi.fn();

vi.mock('../../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../api/index.js')>('../../../api/index.js');
  return {
    ...actual,
    listAiRuns: (...args: unknown[]) => listAiRuns(...args),
    getAiRun: (...args: unknown[]) => getAiRun(...args),
  };
});

import { useAiRun, useAiRunList } from './useAiRuns.js';

function page(nextBefore?: string): AiRunListPage {
  return {
    runs: [{
      runId: nextBefore ?? 'run-1', sortKey: nextBefore ?? 'key-1', expired: false,
      startedAt: '2026-08-07T10:00:00.000Z', durationMs: 2, conversationId: 'conv-1',
      trigger: 'sms', outcome: 'applied', driver: 'fake', decisionCounts: {}, notedLines: 0,
    }],
    ...(nextBefore !== undefined && { nextBefore }),
  };
}

function detail(): AiRunDetailResponse {
  return {
    run: {
      runId: 'run-1', startedAt: '2026-08-07T10:00:00.000Z', finishedAt: '2026-08-07T10:00:01.000Z',
      durationMs: 1, conversationId: 'conv-1', trigger: 'sms', outcome: 'applied', driver: 'fake',
      decisions: {}, notedLines: 0,
    },
    window: { messages: [] },
  };
}

function ListProbe({ scope }: { scope: 'global' | 'outcome#applied' }): React.JSX.Element {
  const state = useAiRunList({ scope });
  return createElement('div', undefined,
    createElement('span', { 'data-testid': 'status' }, state.status),
    createElement('span', { 'data-testid': 'rows' }, state.rows.length),
    createElement('button', { type: 'button', onClick: state.loadMore }, 'more'),
    createElement('button', { type: 'button', onClick: state.retry }, 'retry'),
  );
}

function DetailProbe({ runId }: { runId?: string }): React.JSX.Element {
  const state = useAiRun(runId);
  return createElement('div', undefined,
    createElement('span', { 'data-testid': 'detail-status' }, state.status),
    createElement('button', { type: 'button', onClick: state.retry }, 'retry detail'),
  );
}

beforeEach(() => { listAiRuns.mockReset(); getAiRun.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe('AI run data hooks', () => {
  it('fetches once per scope change and resets the list', async () => {
    listAiRuns.mockResolvedValue(page());
    const rendered = render(createElement(ListProbe, { scope: 'global' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    rendered.rerender(createElement(ListProbe, { scope: 'outcome#applied' }));
    await waitFor(() => expect(listAiRuns).toHaveBeenCalledTimes(2));
    expect(listAiRuns.mock.calls[1]?.[0]).toMatchObject({ scope: 'outcome#applied' });
  });

  it('appends an opaque next page through before', async () => {
    listAiRuns.mockResolvedValueOnce(page('opaque-before')).mockResolvedValueOnce(page());
    render(createElement(ListProbe, { scope: 'global' }));
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('2'));
    expect(listAiRuns.mock.calls[1]?.[0]).toMatchObject({ scope: 'global', before: 'opaque-before' });
  });

  it('aborts an in-flight request on unmount', () => {
    listAiRuns.mockImplementation((_params: unknown, signal: AbortSignal) => new Promise(() => { void signal; }));
    const rendered = render(createElement(ListProbe, { scope: 'global' }));
    const signal = listAiRuns.mock.calls[0]?.[1] as AbortSignal;
    rendered.unmount();
    expect(signal.aborted).toBe(true);
  });

  it('retries a failed first page', async () => {
    listAiRuns.mockRejectedValueOnce(new Error('no')).mockResolvedValueOnce(page());
    render(createElement(ListProbe, { scope: 'global' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    act(() => screen.getByRole('button', { name: 'retry' }).click());
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(listAiRuns).toHaveBeenCalledTimes(2);
  });

  it('leaves an undefined detail id idle without fetching', () => {
    render(createElement(DetailProbe, {}));
    expect(screen.getByTestId('detail-status')).toHaveTextContent('idle');
    expect(getAiRun).not.toHaveBeenCalled();
  });

  it('loads the two-key detail envelope', async () => {
    getAiRun.mockResolvedValue(detail());
    render(createElement(DetailProbe, { runId: 'run-1' }));
    await waitFor(() => expect(screen.getByTestId('detail-status')).toHaveTextContent('ready'));
    expect(getAiRun).toHaveBeenCalledWith('run-1', expect.any(AbortSignal));
  });
});
