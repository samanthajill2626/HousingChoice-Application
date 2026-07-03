// seed/media.ts — PUT the two cast media objects into the local MinIO bucket.
//
// Called by seedAll for the 'full' profile ONLY (lean never seeds media).
// Fail-soft: if MinIO is unreachable (no MEDIA_S3_ENDPOINT or no MEDIA_BUCKET,
// or the endpoint is down), we log a single warning and return — this keeps
// the unit-test suite (which runs without Docker/MinIO) fully green.
//
// Keys are the EXACT strings the cast.ts references; the objects are generated
// in-code (no binaries committed):
//   - A minimal valid JPEG (12-byte SOI+APP0+EOI skeleton) for the unit photo.
//   - A minimal valid MP3 (a single ID3v2 tag + one silent MPEG frame) for the
//     call recording.
//
// The media-store client (S3MediaStore via createMediaStore) owns ALL S3 I/O;
// this module imports nothing from @aws-sdk directly.

import { Readable } from 'node:stream';
import { createMediaStore } from '../../adapters/mediaStore.js';
import { loadConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Exact S3 keys — must stay in sync with cast.ts constants.
// ---------------------------------------------------------------------------

export const CAST_RECORDING_KEY = 'media/cast/call-recordings/parked-landlord-call.mp3';
export const CAST_PHOTO_KEY = 'media/cast/unit-photos/mid-intake-unit-exterior.jpg';

// ---------------------------------------------------------------------------
// Minimal valid byte generators (in-code, no binary files committed)
// ---------------------------------------------------------------------------

/**
 * Returns a minimal valid JPEG file in a Buffer.
 *
 * Structure: SOI (FF D8) → APP0 marker (FF E0) with a 16-byte JFIF APP0
 * segment → EOI (FF D9). The segment is long enough that a strict JPEG
 * parser won't reject it as truncated APP0, and browsers/image libs accept it
 * as a 0×0 JPEG (or silently read the header before hitting empty data).
 *
 * Byte layout of the APP0 segment (16 bytes total including the 2-byte length):
 *   00 10        length (16 in big-endian, including these 2 bytes)
 *   4A 46 49 46 00  "JFIF\0"
 *   01 01        JFIF version 1.1
 *   00           units = 0 (no units / aspect ratio)
 *   00 01 00 01  Xdensity=1, Ydensity=1
 *   00 00        thumbnail W=0, H=0
 */
export function minimalJpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, // APP0 marker
    0x00, 0x10, // segment length = 16 (big-endian)
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version 1.1
    0x00,       // pixel aspect ratio (none)
    0x00, 0x01, // Xdensity = 1
    0x00, 0x01, // Ydensity = 1
    0x00, 0x00, // thumbnail Xthumbnail=0, Ythumbnail=0
    0xff, 0xd9, // EOI
  ]);
}

/**
 * Returns a minimal valid MP3 file in a Buffer.
 *
 * Structure: a minimal ID3v2.3 tag header + one MPEG 1 Layer III silence
 * frame (128 kbps, 44100 Hz, stereo). The frame is valid enough that any
 * MPEG header parser will recognise it as an audio frame.
 *
 * ID3v2.3 tag header (10 bytes):
 *   49 44 33        "ID3"
 *   03 00           version 2.3.0
 *   00              flags = 0
 *   00 00 00 00     tag size = 0 (no frames in the tag — just the header)
 *
 * MPEG1 Layer III frame sync word + header:
 *   FF FB           sync word 0xFFF + MPEG1 + Layer3 + no-CRC
 *   90              bitrate=128kbps, samplerate=44100Hz, no padding, stereo
 *   00              no additional bits, original, no emphasis
 * Followed by 413 zero bytes (the frame body for 128kbps, 44100Hz).
 */
export function minimalMp3(): Buffer {
  // ID3v2 tag header
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

  // MPEG 1, Layer 3, 128kbps, 44100Hz, Stereo — frame size = 417 bytes
  // header: 4 bytes; body: 413 bytes of silence (zeros)
  const frameHeader = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const frameBody = Buffer.alloc(413, 0x00);

  return Buffer.concat([id3, frameHeader, frameBody]);
}

// ---------------------------------------------------------------------------
// seedMedia — the public entry point called by seedAll
// ---------------------------------------------------------------------------

/**
 * Seed the two cast media objects into the local MinIO bucket.
 *
 * @param endpoint  Optional MinIO S3 endpoint override (e.g. 'http://localhost:9000').
 *                  When omitted the standard env-based config is used (MEDIA_S3_ENDPOINT
 *                  + MEDIA_BUCKET). Useful for scripted invocations that need to target
 *                  a specific lane's MinIO.
 */
export async function seedMedia(endpoint?: string): Promise<void> {
  // Build a config that respects the caller-supplied endpoint, or falls back to env.
  const baseConfig = loadConfig();
  const config =
    endpoint !== undefined
      ? { ...baseConfig, mediaS3Endpoint: endpoint, mediaBucket: baseConfig.mediaBucket ?? 'hc-local-media' }
      : baseConfig;

  const store = createMediaStore({ config });
  if (store === undefined) {
    // MEDIA_BUCKET is unset — MinIO not configured locally.  Skip gracefully.
    console.warn('  media seed SKIPPED — no MEDIA_BUCKET configured (MinIO not wired)');
    return;
  }

  const objects: Array<{ key: string; bytes: Buffer; contentType: string }> = [
    { key: CAST_PHOTO_KEY, bytes: minimalJpeg(), contentType: 'image/jpeg' },
    { key: CAST_RECORDING_KEY, bytes: minimalMp3(), contentType: 'audio/mpeg' },
  ];

  for (const { key, bytes, contentType } of objects) {
    try {
      await store.put(key, Readable.from(bytes), contentType);
      console.log(`  seeded   s3://${config.mediaBucket ?? 'hc-local-media'}/${key}`);
    } catch (err) {
      // Fail-soft: warn once per object — a down MinIO must not abort a
      // Docker-less unit run or the lean profile that never calls us.
      console.warn(`  media seed WARN — could not PUT ${key}: ${(err as Error).message ?? String(err)}`);
    }
  }
}
