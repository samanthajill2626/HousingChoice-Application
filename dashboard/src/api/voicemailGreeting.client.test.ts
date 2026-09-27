import { describe, it, expect, vi, afterEach } from 'vitest';
import { uploadVoicemailGreeting, removeVoicemailGreeting, voicemailGreetingAudioUrl } from './endpoints.js';
import { ApiError } from './client.js';
import * as serverClock from './serverClock.js';

const GREETING = {
  s3Key: 'settings/voicemail-greeting',
  contentType: 'audio/mpeg' as const,
  fileName: 'sam.mp3',
  sizeBytes: 427,
  uploadedAt: '2026-09-26T12:00:00.000Z',
  uploadedByUserId: 'u1',
  uploadedByEmail: 'founder@example.com',
};

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json', Date: 'Sat, 26 Sep 2026 12:00:00 GMT' }), json: async () => body }) as unknown as Response;
const errJson = (status: number, body: unknown) =>
  ({ ok: false, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body }) as unknown as Response;
const noContent = () => ({ ok: true, status: 204, headers: new Headers() }) as unknown as Response;

afterEach(() => vi.restoreAllMocks());

describe('voicemail greeting client', () => {
  it('uploadVoicemailGreeting PUTs the raw file with its type and the encoded name header, never JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ voicemailGreeting: GREETING }));
    const noteSpy = vi.spyOn(serverClock, 'noteServerDate');
    const file = new File([new Uint8Array([0x49, 0x44, 0x33])], 'Sam greeting.mp3', { type: 'audio/mpeg' });
    const out = await uploadVoicemailGreeting(file, 'audio/mpeg');
    expect(out).toEqual(GREETING);
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/voicemail-greeting', expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(file);
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('audio/mpeg');
    expect(headers['X-Greeting-File-Name']).toBe(encodeURIComponent('Sam greeting.mp3'));
    expect(noteSpy).toHaveBeenCalled();
  });
  it('maps a refusal to ApiError with the server code and message body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errJson(400, { error: 'unsupported_media_type', message: 'Upload an MP3 or WAV file.' }));
    const file = new File([new Uint8Array([1])], 'x.m4a', { type: 'audio/mp4' });
    const err = await uploadVoicemailGreeting(file, 'audio/mp4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('unsupported_media_type');
    expect((err as ApiError).status).toBe(400);
  });
  it('removeVoicemailGreeting DELETEs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(noContent());
    await removeVoicemailGreeting();
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/voicemail-greeting', expect.objectContaining({ method: 'DELETE' }));
  });
  it('voicemailGreetingAudioUrl carries the upload instant as a cache-buster', () => {
    expect(voicemailGreetingAudioUrl(GREETING)).toBe('/api/settings/voicemail-greeting/audio?v=2026-09-26T12%3A00%3A00.000Z');
  });
  it('request() refuses body + rawBody together (programmer error) before any fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { request } = await import('./client.js');
    await expect(request('/api/x', { method: 'PUT', body: { a: 1 }, rawBody: new Blob(['x']) })).rejects.toThrow('mutually exclusive');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
