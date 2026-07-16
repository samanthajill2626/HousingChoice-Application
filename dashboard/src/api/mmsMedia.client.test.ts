import { describe, it, expect, vi, afterEach } from 'vitest';
import { presignMmsMedia, confirmMmsMedia } from './endpoints.js';
import { ApiError } from './client.js';

const okJson = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  }) as unknown as Response;

const errJson = (status: number, body: unknown) =>
  ({
    ok: false,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  }) as unknown as Response;

afterEach(() => vi.restoreAllMocks());

describe('mms media client', () => {
  it('presignMmsMedia posts contentType and returns key + post', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okJson({ key: 'uploads/x', post: { url: 'u', fields: {} } }));
    const out = await presignMmsMedia('image/webp');
    expect(out.key).toBe('uploads/x');
    expect(out.post.url).toBe('u');
    expect(fetchMock).toHaveBeenCalledWith('/api/media/presign', expect.objectContaining({ method: 'POST' }));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ contentType: 'image/webp' });
  });

  it('confirmMmsMedia returns the attachment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({ attachment: { s3Key: 'uploads/d', contentType: 'image/jpeg', size: 10, originalKey: 'uploads/o', pdfPageCount: 3 } }),
    );
    const out = await confirmMmsMedia('uploads/o');
    expect(out).toMatchObject({ s3Key: 'uploads/d', contentType: 'image/jpeg', originalKey: 'uploads/o', pdfPageCount: 3 });
  });

  it('confirmMmsMedia surfaces transcode_failed with a structured detail', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      errJson(400, { error: 'transcode_failed', detail: 'Input buffer contains unsupported image format' }),
    );
    const err = await confirmMmsMedia('uploads/o').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('transcode_failed');
    expect((err as ApiError).detail).toBe('Input buffer contains unsupported image format');
  });
});
