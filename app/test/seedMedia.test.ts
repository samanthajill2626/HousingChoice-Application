// Unit tests for the media seed module (app/src/lib/seed/media.ts).
//
// What we assert:
//  1. minimalJpeg() returns a buffer whose first 2 bytes are the JPEG SOI
//     marker (FF D8) and whose last 2 bytes are the EOI marker (FF D9).
//  2. minimalMp3() returns a buffer whose first 3 bytes are "ID3" and whose
//     next bytes (after the 10-byte ID3 header) begin with the MPEG sync
//     word (FF FB).
//  3. seedMedia() is a no-op (no throw, no PUT call) when createMediaStore
//     returns undefined (i.e. MEDIA_BUCKET unset — the Docker-less unit run).
//  4. seedMedia() calls store.put() for both keys when the store is healthy.
//  5. seedMedia() warn-and-continues when store.put() throws (fail-soft).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  minimalJpeg,
  minimalMp3,
  CAST_PHOTO_KEY,
  CAST_RECORDING_KEY,
} from '../src/lib/seed/media.js';

// ---------------------------------------------------------------------------
// Mock createMediaStore so no real S3/MinIO is touched.
// ---------------------------------------------------------------------------

const putMock = vi.fn();
vi.mock('../src/adapters/mediaStore.js', () => ({
  createMediaStore: vi.fn(),
  LOCAL_S3_ACCESS_KEY: 'local',
  LOCAL_S3_SECRET_KEY: 'locallocal',
}));

// Mock loadConfig so we don't need process.env populated.
vi.mock('../src/lib/config.js', () => ({
  loadConfig: vi.fn(() => ({
    nodeEnv: 'test',
    mediaBucket: 'hc-local-media',
    mediaS3Endpoint: 'http://localhost:9000',
    awsRegion: 'us-east-1',
    tablePrefix: 'hc-local-',
    // --- the rest are unused by seedMedia; satisfy the type with dummies ---
    devAuthEnabled: false,
    recordOutbox: false,
    port: 8080,
    logLevel: 'silent',
    cfOriginSecret: 'test-secret',
    otelSdkDisabled: true,
    appEnv: 'local',
    alarmNamePrefix: 'hc-local-',
    errorLogGroupName: '/hc/local/app',
    workerLogGroupName: '/hc/local/worker',
    systemLogGroupName: '/hc/local/system',
    messagingDriver: 'console',
    relayLiveProvisioning: false,
    smsSendingEnabled: false,
  })),
  tableName: (base: string) => `hc-local-${base}`,
}));

// Import after mocks are set up so the module sees the mocked deps.
const { createMediaStore } = await import('../src/adapters/mediaStore.js');
const { seedMedia } = await import('../src/lib/seed/media.js');
const createMediaStoreMock = createMediaStore as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Byte-header assertions
// ---------------------------------------------------------------------------

describe('minimalJpeg', () => {
  it('starts with the JPEG SOI marker (FF D8)', () => {
    const buf = minimalJpeg();
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  });

  it('ends with the JPEG EOI marker (FF D9)', () => {
    const buf = minimalJpeg();
    expect(buf[buf.length - 2]).toBe(0xff);
    expect(buf[buf.length - 1]).toBe(0xd9);
  });

  it('contains the JFIF identifier', () => {
    const buf = minimalJpeg();
    // "JFIF\0" starts at byte 6 (after SOI + APP0 marker + 2-byte length)
    const jfif = buf.slice(6, 11).toString('ascii');
    expect(jfif).toBe('JFIF\0');
  });
});

describe('minimalMp3', () => {
  it('starts with the ID3 signature', () => {
    const buf = minimalMp3();
    expect(buf.slice(0, 3).toString('ascii')).toBe('ID3');
  });

  it('contains an MPEG sync word (FF FB) immediately after the 10-byte ID3 header', () => {
    const buf = minimalMp3();
    // ID3 header is exactly 10 bytes; MPEG frame starts at offset 10
    expect(buf[10]).toBe(0xff);
    expect(buf[11]).toBe(0xfb);
  });

  it('has a non-trivial length (header + at least one frame body)', () => {
    const buf = minimalMp3();
    // 10 (ID3) + 4 (MPEG header) + 413 (frame body) = 427
    expect(buf.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// seedMedia behaviour
// ---------------------------------------------------------------------------

describe('seedMedia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    putMock.mockReset();
  });

  it('is skip-safe when createMediaStore returns undefined (no MEDIA_BUCKET)', async () => {
    createMediaStoreMock.mockReturnValueOnce(undefined);
    await expect(seedMedia()).resolves.toBeUndefined();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('calls store.put() for both cast keys with the right content-types', async () => {
    createMediaStoreMock.mockReturnValueOnce({ put: putMock, getStream: vi.fn() });
    putMock.mockResolvedValue(undefined);

    await seedMedia();

    // Called twice — once per object
    expect(putMock).toHaveBeenCalledTimes(2);

    const calls = putMock.mock.calls as [string, unknown, string][];
    const keys = calls.map((c) => c[0]);
    expect(keys).toContain(CAST_PHOTO_KEY);
    expect(keys).toContain(CAST_RECORDING_KEY);

    const photoCall = calls.find((c) => c[0] === CAST_PHOTO_KEY)!;
    expect(photoCall[2]).toBe('image/jpeg');

    const recCall = calls.find((c) => c[0] === CAST_RECORDING_KEY)!;
    expect(recCall[2]).toBe('audio/mpeg');
  });

  it('is fail-soft (warn + continue) when store.put() throws', async () => {
    createMediaStoreMock.mockReturnValueOnce({ put: putMock, getStream: vi.fn() });
    putMock.mockRejectedValue(new Error('MinIO unreachable'));

    // Must not throw; must log warnings (console.warn is called by the module).
    await expect(seedMedia()).resolves.toBeUndefined();
  });
});
