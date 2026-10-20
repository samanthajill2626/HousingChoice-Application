import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from './client.js';

afterEach(() => vi.restoreAllMocks());

function jsonOk(): Response {
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
}

// A fetch stub that honours its signal the way the browser does: it rejects
// with the signal's reason once aborted, and otherwise answers 200 - or, with
// `hold`, never answers, so the request stays in flight until it is aborted.
function abortableFetch({ hold = false }: { hold?: boolean } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    const signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason as Error);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason as Error));
      if (!hold) setTimeout(() => resolve(jsonOk()), 0);
    });
  });
}

describe('request: a signal aborted in the same tick never reaches the network', () => {
  it('drops the fetch and rejects with an AbortError, not an ApiError', async () => {
    const fetchMock = abortableFetch();
    const controller = new AbortController();

    const pending = request('/api/things', { signal: controller.signal });
    controller.abort();
    const error: unknown = await pending.catch((value: unknown) => value);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('sends only the second request of a StrictMode mount, cleanup, mount', async () => {
    const fetchMock = abortableFetch();
    const first = new AbortController();
    const second = new AbortController();

    const dropped = request('/api/things', { signal: first.signal }).catch((value: unknown) => value);
    first.abort();
    const kept = request('/api/things', { signal: second.signal });

    await expect(kept).resolves.toEqual({ ok: true });
    await expect(dropped).resolves.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(second.signal);
  });

  it('still cancels a request aborted after it was dispatched', async () => {
    const fetchMock = abortableFetch({ hold: true });
    const controller = new AbortController();

    const pending = request('/api/things', { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const error: unknown = await pending.catch((value: unknown) => value);

    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('dispatches a signalled request that is not aborted', async () => {
    const fetchMock = abortableFetch();

    await expect(request('/api/things', { signal: new AbortController().signal }))
      .resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dispatches an unsignalled request synchronously, as before', () => {
    const fetchMock = abortableFetch();

    void request('/api/things', { method: 'POST', body: { a: 1 } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
