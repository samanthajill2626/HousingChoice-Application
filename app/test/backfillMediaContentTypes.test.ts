import { describe, expect, it, vi } from 'vitest';
import {
  backfillMediaContentTypes,
  messagingMisconfiguration,
  type BackfillResult,
} from '../scripts/backfill-media-content-types.js';
import type { AppConfig } from '../src/lib/config.js';

// REAL-SHAPED SIDs: `ME` + 32 hex. An underscore-and-letters placeholder like
// `ME_ZERO` cannot match the parser's own regex and would redden most of this
// file while looking like a logic bug.
const ME0 = 'ME00000000000000000000000000000000';
const ME1 = 'ME11111111111111111111111111111111';
const ACCOUNT = 'AC1';
const URL0 = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages/MM1/Media/${ME0}`;
const URL1 = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages/MM1/Media/${ME1}`;

/** An inbound MMS row with `n` octet-stream attachments, keys index 0..n-1. */
function inboundRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: 'c1',
    tsMsgId: '2026-08-01T00:00:00.000Z#MM1',
    provider_sid: 'MM1',
    direction: 'inbound',
    mediaUrls: [URL0, URL1],
    media_attachments: [{ s3Key: 'media/c1/MM1/0', contentType: 'application/octet-stream' }],
    ...overrides,
  };
}

const twoAttachmentRow = inboundRow({
  media_attachments: [
    { s3Key: 'media/c1/MM1/0', contentType: 'application/octet-stream' },
    { s3Key: 'media/c1/MM1/1', contentType: 'application/octet-stream' },
  ],
});

/** Runs the backfill over `rows` with recording fakes. `calls` records the
 *  ORDER of the pre-write re-read and the three writes, which is the whole
 *  point of several tests. */
async function run(opts: {
  rows: Record<string, unknown>[];
  /** What Twilio answers. `null` means "Twilio no longer has it" (404). */
  contentType?: string | null;
  /** Reject with a 429 this many times before answering normally.
   *  `Infinity` = throttled forever. */
  throttleTimes?: number;
  dryRun?: boolean;
  annotateFails?: boolean;
  /** What the PRE-WRITE re-read returns, when it must differ from the scanned
   *  row: an object stands in for the row as it is at write time, `null` for a
   *  row that is gone. Omitted = the scanned row, i.e. nothing changed. */
  reread?: Record<string, unknown> | null;
  /** The account the fake adapter is credentialed for. Omitted by every test
   *  that is not about the wrong-account abort, exactly as the suite omits it
   *  in real life and the CLI never does. */
  expectedAccountSid?: string;
  /** Capture a thrown abort instead of rejecting, so the test can assert on the
   *  fakes (no vendor call, no writes) as well as on the message. */
  captureError?: boolean;
}) {
  const calls: string[] = [];
  const setContentType = vi.fn(async (key: string) => {
    calls.push(`s3:${key}`);
  });
  const getByTsMsgId = vi.fn(async (conversationId: string, tsMsgId: string) => {
    calls.push(`read:${conversationId}`);
    if (opts.reread !== undefined) return opts.reread ?? undefined;
    return opts.rows.find((r) => r.conversationId === conversationId && r.tsMsgId === tsMsgId);
  });
  // The full signatures, not just the recorded field: the merge tests assert on
  // the ATTACHMENT ARRAY these two are handed.
  const putMediaPointers = vi.fn(
    async (conversationId: string, _tsMsgId: string, _attachments: unknown) => {
      calls.push(`pointers:${conversationId}`);
    },
  );
  const annotateMessage = vi.fn(
    async (conversationId: string, _tsMsgId: string, _annotations: unknown) => {
      calls.push(`annotate:${conversationId}`);
      if (opts.annotateFails) throw new Error('boom');
    },
  );
  let throttlesLeft = opts.throttleTimes ?? 0;
  const getMediaContentType = vi.fn(async () => {
    if (throttlesLeft > 0) {
      throttlesLeft -= 1;
      throw Object.assign(new Error('too many requests'), { status: 429 });
    }
    return opts.contentType === null ? undefined : (opts.contentType ?? 'video/mp4');
  });
  const doc = { send: vi.fn().mockResolvedValue({ Items: opts.rows }) };

  let result: BackfillResult | undefined;
  let error: unknown;
  try {
    result = await backfillMediaContentTypes({
      doc: doc as never,
      adapter: { getMediaContentType } as never,
      mediaStore: { setContentType } as never,
      messagesRepo: { getByTsMsgId, putMediaPointers, annotateMessage } as never,
      // Injected so a throttle test does not actually wait seven seconds.
      sleep: async () => {},
      ...(opts.expectedAccountSid !== undefined && {
        expectedAccountSid: opts.expectedAccountSid,
      }),
      ...(opts.dryRun === true && { dryRun: true }),
    });
  } catch (err) {
    if (opts.captureError !== true) throw err;
    error = err;
  }
  return {
    // Only the abort test runs without a result, and it reads `error` instead.
    result: result as BackfillResult,
    error,
    calls,
    setContentType,
    getByTsMsgId,
    putMediaPointers,
    annotateMessage,
    getMediaContentType,
  };
}

describe('backfillMediaContentTypes', () => {
  it('derives the media index from the S3 KEY, not the array position', async () => {
    // media_attachments is a compacted successes-only list that the deferred
    // mirror job appends to, so position 0 can carry index 1. Reading
    // mediaUrls[position] would stamp the WRONG type on the WRONG object, and
    // nothing downstream could detect it.
    const row = inboundRow({
      media_attachments: [
        { s3Key: 'media/c1/MM1/1', contentType: 'application/octet-stream' },
      ],
    });
    const { getMediaContentType } = await run({ rows: [row] });
    expect(getMediaContentType).toHaveBeenCalledWith('MM1', ME1);
  });

  it('skips an attachment already carrying a real type', async () => {
    // The per-attachment predicate. Without it a re-run re-queries Twilio for
    // every attachment on a partially repaired row.
    const row = inboundRow({
      media_attachments: [{ s3Key: 'media/c1/MM1/0', contentType: 'video/mp4' }],
    });
    const { result, getMediaContentType } = await run({ rows: [row] });
    expect(result.eligible).toBe(0);
    expect(getMediaContentType).not.toHaveBeenCalled();
  });

  it('writes S3, then pointers, then the row - the predicate-clearing write LAST', async () => {
    // annotateMessage swallows pointer failures, so a row-first order can
    // clear the re-scan predicate and leave the gallery permanently wrong.
    // The re-read sits between the S3 copy and the two row writes: it must be
    // as LATE as possible, because everything after it is the lost-update
    // window.
    const { calls } = await run({ rows: [inboundRow()] });
    expect(calls).toEqual(['s3:media/c1/MM1/0', 'read:c1', 'pointers:c1', 'annotate:c1']);
  });

  it('leaves everything repairable when the row write fails', async () => {
    const first = await run({ rows: [inboundRow()], annotateFails: true });
    expect(first.result.written).toBe(0);
    // The row still says octet-stream, so a clean re-run completes it.
    const second = await run({ rows: [inboundRow()] });
    expect(second.result.written).toBe(1);
  });

  it('writes the row ONCE for a two-attachment message', async () => {
    const { result, annotateMessage, setContentType } = await run({ rows: [twoAttachmentRow] });
    expect(result.written).toBe(2);
    expect(setContentType).toHaveBeenCalledTimes(2);
    expect(annotateMessage).toHaveBeenCalledTimes(1);
  });

  it('never writes a type the runtime would refuse', async () => {
    const { result, setContentType } = await run({
      rows: [inboundRow()],
      contentType: 'text/html',
    });
    expect(result.skippedStillOpaque).toBe(1);
    expect(setContentType).not.toHaveBeenCalled();
  });

  it('skips an unparseable s3 key rather than guessing an index', async () => {
    const row = inboundRow({
      media_attachments: [{ s3Key: 'uploads/abc', contentType: 'application/octet-stream' }],
    });
    const { result, getMediaContentType } = await run({ rows: [row] });
    expect(result.skippedUnparseableKey).toBe(1);
    expect(getMediaContentType).not.toHaveBeenCalled();
  });

  it('skips an attachment whose index is past the stored mediaUrls', async () => {
    const row = inboundRow({
      mediaUrls: [URL0],
      media_attachments: [{ s3Key: 'media/c1/MM1/5', contentType: 'application/octet-stream' }],
    });
    expect((await run({ rows: [row] })).result.skippedNoUrl).toBe(1);
  });

  it('retries through a transient 429 and still repairs', async () => {
    const { result, setContentType } = await run({ rows: [inboundRow()], throttleTimes: 2 });
    expect(result.written).toBe(1);
    expect(result.skippedThrottled).toBe(0);
    expect(setContentType).toHaveBeenCalledTimes(1);
  });

  it('counts a persistent 429 as THROTTLED, never as retention loss', async () => {
    // Conflating the two corrupts the histogram the ops go/no-go reads:
    // throttling means "run it again", retention loss means "these are gone".
    const { result } = await run({ rows: [inboundRow()], throttleTimes: Infinity });
    expect(result.skippedThrottled).toBe(1);
    expect(result.skippedTwilio404).toBe(0);
    expect(result.written).toBe(0);
  });

  it('skips an attachment whose media Twilio no longer has', async () => {
    const { result, setContentType } = await run({ rows: [inboundRow()], contentType: null });
    expect(result.skippedTwilio404).toBe(1);
    expect(setContentType).not.toHaveBeenCalled();
  });

  it('counts an inbound EMAIL row separately and never queries Twilio for it', async () => {
    // Inbound + media_attachments + octet-stream, but no Twilio media behind
    // it. Without its own bucket it inflates the histogram the ops decision
    // reads.
    const row = inboundRow({ mediaUrls: undefined });
    const { result, getMediaContentType } = await run({ rows: [row] });
    expect(result.skippedEmailRow).toBe(1);
    expect(getMediaContentType).not.toHaveBeenCalled();
  });

  it('counts a legacy media_s3_keys row and leaves it alone', async () => {
    const row = inboundRow({ media_attachments: undefined, media_s3_keys: ['media/c1/MM1/0'] });
    const { result, setContentType } = await run({ rows: [row] });
    expect(result.skippedLegacyRow).toBe(1);
    expect(setContentType).not.toHaveBeenCalled();
  });

  it('ignores outbound rows, which are already correct', async () => {
    const row = inboundRow({ direction: 'outbound' });
    expect((await run({ rows: [row] })).result.eligible).toBe(0);
  });

  it('writes nothing on a dry run but still reports the histogram', async () => {
    const { result, setContentType, annotateMessage } = await run({
      rows: [inboundRow()],
      dryRun: true,
    });
    expect(result.recovered['video/mp4']).toBe(1);
    expect(setContentType).not.toHaveBeenCalled();
    expect(annotateMessage).not.toHaveBeenCalled();
    // A dry run performs no WRITES but it DOES read the live Twilio account.
    expect(result.vendorCalls).toBe(1);
  });

  it('skips a row whose provider_sid is missing rather than 404ing on it', async () => {
    // messages(undefined) 404s, which the adapter reports as "Twilio no longer
    // has this media" - a silent, WRONG retention-loss count. There is no
    // addressable Twilio evidence for such a row at all, so it is declined
    // BEFORE the vendor call and lands in skippedNoUrl with the other rows
    // whose media cannot be addressed.
    const row = inboundRow({ provider_sid: undefined });
    const { result, getMediaContentType } = await run({ rows: [row] });
    expect(result.skippedNoUrl).toBe(1);
    expect(result.skippedTwilio404).toBe(0);
    expect(getMediaContentType).not.toHaveBeenCalled();
  });
});

describe('backfillMediaContentTypes - the wrong-account abort', () => {
  it('ABORTS on the first media URL naming another account, before any vendor call', async () => {
    // The green-exit catastrophe: dev credentials against prod data 404 on
    // every media SID, so the run reports "all aged out", writes nothing and
    // exits 0 - indistinguishable from a completed repair. The stored URL names
    // the owning account, so this is detectable with data the scan already
    // parses, and it is an AUTH-CLASS failure: it throws, never counts.
    const { error, getMediaContentType, setContentType, annotateMessage } = await run({
      rows: [inboundRow()],
      expectedAccountSid: 'ACother',
      captureError: true,
    });
    expect(String(error)).toContain(ACCOUNT);
    expect(String(error)).toContain('ACother');
    expect(String(error)).toMatch(/WRONG ENVIRONMENT/);
    expect(getMediaContentType).not.toHaveBeenCalled();
    expect(setContentType).not.toHaveBeenCalled();
    expect(annotateMessage).not.toHaveBeenCalled();
  });

  it('runs normally when the media URL names the configured account', async () => {
    const { result } = await run({ rows: [inboundRow()], expectedAccountSid: ACCOUNT });
    expect(result.written).toBe(1);
  });
});

describe('backfillMediaContentTypes - the row write is a re-read, not a blind replace', () => {
  it('PRESERVES an attachment the mirror appended between the scan and the write', async () => {
    // The lost-update path: annotateMessage SETs media_attachments wholesale,
    // so writing the scan-time snapshot back deletes anything the deferred
    // media.mirror job appended in between - permanently, and with the pointer
    // row surviving to address a /media/:idx the row no longer exposes.
    const appended = { s3Key: 'media/c1/MM1/1', contentType: 'application/octet-stream' };
    const { result, annotateMessage, putMediaPointers } = await run({
      rows: [inboundRow()],
      reread: inboundRow({
        media_attachments: [
          { s3Key: 'media/c1/MM1/0', contentType: 'application/octet-stream' },
          appended,
        ],
      }),
    });
    const expected = [{ s3Key: 'media/c1/MM1/0', contentType: 'video/mp4' }, appended];
    expect(annotateMessage).toHaveBeenCalledWith('c1', '2026-08-01T00:00:00.000Z#MM1', {
      mediaAttachments: expected,
    });
    expect(putMediaPointers).toHaveBeenCalledWith('c1', '2026-08-01T00:00:00.000Z#MM1', expected);
    expect(result.written).toBe(1);
  });

  it('matches the staged repair BY s3Key, not by array position', async () => {
    // The mirror APPENDS, so the same attachment can sit at a different index
    // at write time than it did at scan time. Applying the staged type
    // positionally would stamp video/mp4 onto whatever moved into slot 0.
    const moved = { s3Key: 'media/c1/MM1/9', contentType: 'image/png' };
    const { annotateMessage } = await run({
      rows: [inboundRow()],
      reread: inboundRow({
        media_attachments: [moved, { s3Key: 'media/c1/MM1/0', contentType: 'application/octet-stream' }],
      }),
    });
    expect(annotateMessage).toHaveBeenCalledWith('c1', '2026-08-01T00:00:00.000Z#MM1', {
      mediaAttachments: [moved, { s3Key: 'media/c1/MM1/0', contentType: 'video/mp4' }],
    });
  });

  it('writes nothing and does not throw when the row is gone at write time', async () => {
    const { result, putMediaPointers, annotateMessage } = await run({
      rows: [inboundRow()],
      reread: null,
    });
    expect(putMediaPointers).not.toHaveBeenCalled();
    expect(annotateMessage).not.toHaveBeenCalled();
    expect(result.written).toBe(0);
    // The S3 object was already re-typed; that is idempotent and harmless.
    expect(result.recovered['video/mp4']).toBe(1);
  });
});

describe('messagingMisconfiguration', () => {
  const OK = {
    messagingDriver: 'twilio',
    twilioAccountSid: 'AC1',
    twilioApiKeySid: 'SK1',
    twilioApiKeySecret: 'secret',
  } as AppConfig;

  it('passes a fully configured twilio shell', () => {
    expect(messagingMisconfiguration(OK)).toBeUndefined();
  });

  it('REFUSES when TWILIO_API_BASE_URL is set', () => {
    // The redirecting HTTP client is installed for EVERY REST call, media
    // metadata included, and loadConfig only rejects the variable under
    // NODE_ENV=production - which an operator running a tsx script is not. A
    // leftover fake-Twilio override would read a fake account and report the
    // whole population as aged out, green.
    const reason = messagingMisconfiguration({
      ...OK,
      twilioApiBaseUrl: 'http://localhost:8889',
    } as AppConfig);
    expect(reason).toMatch(/TWILIO_API_BASE_URL/);
  });

  it('REFUSES the console driver first, before the credential check', () => {
    expect(messagingMisconfiguration({ ...OK, messagingDriver: 'console' } as AppConfig)).toMatch(
      /MESSAGING_DRIVER/,
    );
  });
});
