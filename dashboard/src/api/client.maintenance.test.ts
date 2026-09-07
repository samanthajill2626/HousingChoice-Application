import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from './client.js';

afterEach(() => vi.restoreAllMocks());

describe('maintenance response API contract', () => {
  it.each([502, 504])('throws status %s for HTML and does not replay a POST', async (status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<!doctype html><title>Temporarily unavailable</title>',
      { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ));

    const error: unknown = await request('/api/maintenance-contract', {
      method: 'POST', body: { submitted: true },
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code: `http_${status}`, body: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/maintenance-contract',
      expect.objectContaining({ method: 'POST', body: '{"submitted":true}' }));
  });

  it.each(['relay_provisioning_disabled', 'pool_number_unavailable', 'push_not_configured'])(
    'preserves typed 503 refusal %s', async (code) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({ error: code }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ));

      await expect(request('/api/maintenance-contract')).rejects.toMatchObject({
        status: 503, code, body: { error: code },
      });
    },
  );

  it('preserves successful JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await expect(request('/api/maintenance-contract')).resolves.toEqual({ ok: true });
  });
});
