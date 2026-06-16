import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from './client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('request — success', () => {
  it('parses a JSON 200 body as the typed result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, n: 3 })));
    const result = await request<{ ok: boolean; n: number }>('/api/thing');
    expect(result).toEqual({ ok: true, n: 3 });
  });

  it('returns undefined for a 204 (no body)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const result = await request<void>('/api/thing', { method: 'DELETE' });
    expect(result).toBeUndefined();
  });

  it('serializes a JSON body and sets content-type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { created: true }));
    vi.stubGlobal('fetch', fetchMock);
    await request('/api/thing', { method: 'POST', body: { a: 1 } });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.credentials).toBe('same-origin');
  });

  it('appends defined query params and drops undefined/null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await request('/api/conversations', { query: { status: 'open', limit: 50, cursor: null } });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain('status=open');
    expect(url).toContain('limit=50');
    expect(url).not.toContain('cursor');
  });
});

describe('request — errors', () => {
  it('throws ApiError carrying status + the { error } code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(403, { error: 'forbidden' })));
    await expect(request('/api/settings', { method: 'PUT', body: {} })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('includes a { detail } in the message and keeps the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(409, { error: 'cannot_demote_last_admin', detail: 'x' })),
    );
    try {
      await request('/api/users/u1/role', { method: 'PATCH', body: { role: 'va' } });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(409);
      expect(e.code).toBe('cannot_demote_last_admin');
      expect(e.message).toContain('x');
      expect(e.body).toEqual({ error: 'cannot_demote_last_admin', detail: 'x' });
    }
  });

  it('synthesizes a code when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('boom', { status: 500 })),
    );
    await expect(request('/api/thing')).rejects.toMatchObject({ status: 500, code: 'http_500' });
  });

  it('maps a network failure to ApiError(0, network_error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(request('/api/thing')).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });
});
