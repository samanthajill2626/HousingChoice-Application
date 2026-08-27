// backfill:media-content-types - one-time, IDEMPOTENT repair of INBOUND MMS
// attachments whose stored Content-Type is `application/octet-stream` because
// our own mirror discarded the real type before the DECLARABLE tier existed.
//
// Every video, audio clip, vCard and office document that arrived over MMS
// before this feature was stored as an opaque download and renders in the
// dashboard as a bare "Attachment N". The true type is still recoverable from
// Twilio's Media resource (METADATA ONLY - no bytes are fetched), so for each
// such attachment this script asks Twilio, normalizes the answer through the
// SAME allowlist the runtime uses, rewrites the S3 object's Content-Type in
// place, and then rewrites the message row.
//
// WRITE ORDER IS LOAD-BEARING: S3 object -> media pointers -> message row.
// The message row's `contentType` is the RE-SCAN PREDICATE - once it stops
// saying `application/octet-stream` this script will never look at that
// attachment again. And `messagesRepo.annotateMessage` writes its pointer rows
// BEST-EFFORT, swallowing pointer failures (messagesRepo.ts:2544-2550). Writing
// the row first would therefore let a pointer failure clear the predicate and
// leave the gallery permanently wrong with no way to notice. Writing the
// predicate LAST means every partial failure is simply re-runnable: the object
// may already carry the right type, the row still says octet-stream, and the
// next run finishes the job. Nothing here is destructive on a re-run.
//
// `--dry-run` WRITES NOTHING but STILL READS THE LIVE TWILIO ACCOUNT - one
// authenticated Media metadata fetch per candidate attachment. It is a
// read-only rehearsal, not an offline one; the report states how many vendor
// calls it made.
//
// MISCONFIGURATION IS THE REAL HAZARD, so the CLI guards for it BEFORE the
// scan. `getMediaContentType` resolves `undefined` both for "Twilio no longer
// has this media" and for "this client cannot read media at all" (the CONSOLE
// driver, a message-only fake, a credential pointed at another account). A
// misconfigured run would therefore report "every attachment aged out", write
// nothing, and EXIT GREEN - indistinguishable from a completed repair. See
// `main` below for the guard and why `messagingDriver === 'twilio'` is the
// load-bearing half of it.
//
// PII: logs COUNTS and IDs only - never a filename, a media URL, a body or a
// phone number.
//
// Human-run per the RUNBOOK's `npx tsx` convention (there is deliberately no
// npm script; no backfill has one):
//   npx tsx app/scripts/backfill-media-content-types.ts --dry-run
//   npx tsx app/scripts/backfill-media-content-types.ts
// The operator shell needs MESSAGING_DRIVER=twilio, the TWILIO_* credentials,
// MEDIA_BUCKET and TABLE_PREFIX for the TARGET environment, plus the
// `housingchoice` AWS profile.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  assertHousingChoiceAccount,
  hcCredentials,
  HC_PROFILE,
  HC_REGION,
} from '../../scripts/lib/hcAws.mjs';
import { createMediaStore, type MediaStore } from '../src/adapters/mediaStore.js';
import { createMessagingAdapter, type MessagingAdapter } from '../src/adapters/messaging.js';
import { loadConfig, tableName, type AppConfig } from '../src/lib/config.js';
import { logger } from '../src/lib/logger.js';
import { normalizeStoredMediaType } from '../src/lib/mediaTypes.js';
import {
  createMessagesRepo,
  type MediaAttachment,
  type MessageItem,
  type MessagesRepo,
} from '../src/repos/messagesRepo.js';

/** The stored type that MARKS an attachment as unrepaired - the re-scan predicate. */
const OPAQUE_CONTENT_TYPE = 'application/octet-stream';

/** Twilio metadata reads in flight at once. Small on purpose: the whole
 *  population is a few dozen rows and a 429 costs more than the parallelism. */
const VENDOR_CONCURRENCY = 4;

/** Backoff before retry 1, 2 and 3 of a throttled Twilio read. A FOURTH
 *  throttle gives up on that attachment (skippedThrottled) - it never aborts. */
const THROTTLE_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];

export interface BackfillResult {
  /** Message rows returned by the scan, before ANY filtering. */
  rowsScanned: number;
  /** ATTACHMENTS that passed the full candidate predicate (inbound row, stored
   *  mediaUrls, stored type still `application/octet-stream`). Every skip
   *  counter below is a subset of these except the two ROW-level ones. */
  eligible: number;
  /** Canonical type -> count: the histogram the ops go/no-go decision reads.
   *  Counts STAGED repairs, so a dry run reports the full picture. */
  recovered: Record<string, number>;
  /** Attachments whose repair COMMITTED, which means their message's row write
   *  succeeded. An attachment whose S3 copy landed but whose row write then
   *  failed is NOT counted: it is still octet-stream in the row, so the next
   *  run re-selects it. Always 0 on a dry run. */
  written: number;
  /** S3 key did not match `media/<conversation>/<sid>/<index>`, so the media
   *  index is unknown. NEVER guessed - a guessed index stamps the wrong type on
   *  the wrong object and nothing downstream could detect it. */
  skippedUnparseableKey: number;
  /** The parsed index has no usable Twilio media URL in the row's stored
   *  `mediaUrls` (absent, out of range, or not a `/Media/ME<32 hex>` URL). */
  skippedNoUrl: number;
  /** Twilio no longer holds the media (404). PERMANENT: these are gone, and a
   *  steady state where they are re-queried on every run is expected. */
  skippedTwilio404: number;
  /** Twilio throttled us through all four attempts. TRANSIENT and deliberately
   *  NOT folded into skippedTwilio404: throttling means "run it again",
   *  retention loss means "these are gone". Folding them together corrupts the
   *  one number the go/no-go decision turns on. */
  skippedThrottled: number;
  /** Twilio's answer still normalizes to the opaque tier (script-capable or
   *  unknown types). Storing it would change nothing and serving it inline is
   *  exactly the stored-XSS hole the allowlist exists to close. */
  skippedStillOpaque: number;
  /** ROW-level: an inbound row carrying attachments but no `mediaUrls` - an
   *  inbound EMAIL. There is no Twilio media behind it; counted separately so
   *  it does not inflate the histogram the ops decision reads. */
  skippedEmailRow: number;
  /** ROW-level: a legacy row carrying only `media_s3_keys` (no
   *  `media_attachments`). Its "type" is synthesized at read time, so there is
   *  no stored type to repair; left strictly alone. */
  skippedLegacyRow: number;
  /** Twilio metadata reads PERFORMED, throttled attempts included, and
   *  INCLUDING on a dry run. */
  vendorCalls: number;
}

export interface BackfillMediaContentTypesOpts {
  /** The DynamoDB document client to scan through. REQUIRED - see `main`: an
   *  ops script must never reach for an ambient default-chain client. */
  doc: DynamoDBDocumentClient;
  /** Reads the true Content-Type from Twilio. Metadata only, no bytes. */
  adapter: Pick<MessagingAdapter, 'getMediaContentType'>;
  /** Rewrites the stored object's Content-Type in place. */
  mediaStore: Pick<MediaStore, 'setContentType'>;
  /** Writes the pointer rows and then the message row. */
  messagesRepo: Pick<MessagesRepo, 'putMediaPointers' | 'annotateMessage'>;
  /** Read + report, write NOTHING. Twilio is still read. */
  dryRun?: boolean;
  /** Env used for physical table resolution (TABLE_PREFIX). */
  env?: NodeJS.ProcessEnv;
  /** Test seam for the throttle backoff, so a retry test is instant. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `media/<conversationId>/<providerSid>/<index>` - the key shape
 * `inboundMediaKey` (services/mediaMirror.ts) mints. The trailing integer is
 * the position in the ROW'S STORED `mediaUrls` array, NOT Twilio's own
 * `MediaUrl{i}` numbering: `parseInboundMediaUrls`
 * (routes/webhooks/twilio.ts:440-448) skips absent/empty entries, so the two
 * can differ. It is the correct index precisely because the s3Key and the
 * stored `mediaUrls` derive from the same compacted list.
 */
export function parseMediaIndexFromKey(s3Key: string): number | undefined {
  const match = /^media\/[^/]+\/[^/]+\/(\d+)$/.exec(s3Key);
  const digits = match?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/**
 * The Twilio Media SID out of a stored media URL. A real one is `ME` + 32 hex;
 * a looser pattern silently accepts junk and we would query Twilio for it.
 */
export function parseMediaSid(url: string): string | undefined {
  return /\/Media\/(ME[0-9a-fA-F]{32})/.exec(url)?.[1];
}

/** One message row with at least one attachment worth attempting. */
interface RowWork {
  conversationId: string;
  tsMsgId: string;
  /** The row's attachments, UNTOUCHED and in their original order. */
  attachments: readonly MediaAttachment[];
  /** Parallel to `attachments`: the canonical type staged for that POSITION,
   *  or undefined where nothing changed. */
  staged: (string | undefined)[];
}

/** One attachment cleared for a Twilio read. */
interface Candidate {
  row: RowWork;
  position: number;
  s3Key: string;
  messageSid: string;
  mediaSid: string;
}

type FetchOutcome =
  | { kind: 'ok'; contentType: string }
  | { kind: 'missing' }
  | { kind: 'throttled' };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Repair every inbound MMS attachment still stored as an opaque download.
 *
 * PURE + FULLY INJECTED: every client is a parameter, so the suite drives it
 * with fakes and needs neither AWS nor Twilio. The misconfiguration guard lives
 * in the CLI wrapper rather than here for exactly that reason - several tests
 * legitimately recover nothing.
 */
export async function backfillMediaContentTypes(
  opts: BackfillMediaContentTypesOpts,
): Promise<BackfillResult> {
  const { doc, adapter, mediaStore, messagesRepo } = opts;
  const dryRun = opts.dryRun === true;
  const sleep = opts.sleep ?? defaultSleep;
  const table = tableName('messages', opts.env ?? process.env);

  const result: BackfillResult = {
    rowsScanned: 0,
    eligible: 0,
    recovered: {},
    written: 0,
    skippedUnparseableKey: 0,
    skippedNoUrl: 0,
    skippedTwilio404: 0,
    skippedThrottled: 0,
    skippedStillOpaque: 0,
    skippedEmailRow: 0,
    skippedLegacyRow: 0,
    vendorCalls: 0,
  };

  /**
   * One Twilio metadata read, retried through a throttle. The adapter returns
   * undefined ONLY for a 404 and RETHROWS everything else, so a 429 arrives
   * here as a THROWN error and is read off the error.
   */
  async function fetchMediaType(candidate: Candidate): Promise<FetchOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        result.vendorCalls += 1;
        const contentType = await adapter.getMediaContentType(
          candidate.messageSid,
          candidate.mediaSid,
        );
        return contentType === undefined ? { kind: 'missing' } : { kind: 'ok', contentType };
      } catch (err) {
        // COMPARE THE CODE STRING-TOLERANTLY: Twilio delivers `code` as a
        // number OR a string depending on the path, which is the whole reason
        // adapters/groupConversations.ts:322-329 exists. A strict
        // `code === 20429` lets the string form fall through to the
        // "propagate everything else" rule below and ABORTS an ops run on a
        // transient rate limit - the opposite of the intent. The
        // `status === 429` half is the load-bearing check.
        const e = err as { status?: number; code?: number | string };
        const code = e.code === undefined ? undefined : Number(e.code);
        const throttled = e.status === 429 || code === 20429;
        // Anything else PROPAGATES: an auth failure or a wrong-account
        // credential must stop the run, never be counted as a skip.
        if (!throttled) throw err;
        const backoff = THROTTLE_BACKOFF_MS[attempt];
        if (backoff === undefined) return { kind: 'throttled' };
        await sleep(backoff);
      }
    }
  }

  /** One attachment: read Twilio, normalize, rewrite S3, stage the repair. */
  async function repairAttachment(candidate: Candidate): Promise<void> {
    const outcome = await fetchMediaType(candidate);
    if (outcome.kind === 'throttled') {
      result.skippedThrottled += 1;
      return;
    }
    if (outcome.kind === 'missing') {
      result.skippedTwilio404 += 1;
      return;
    }
    // The SAME allowlist the runtime writes and serves through, so this script
    // can never introduce a stored type the serve route would refuse.
    const canonical = normalizeStoredMediaType(outcome.contentType);
    if (canonical === OPAQUE_CONTENT_TYPE) {
      result.skippedStillOpaque += 1;
      return;
    }
    // THE ONE CALL THAT MUTATES THE PRODUCTION BUCKET, so it sits inside the
    // dry-run guard. A dry run that mutates anything makes the whole
    // "dry run first" ops sequence a lie. Staging happens EITHER WAY so the
    // histogram is complete on a dry run.
    //
    // An S3 failure PROPAGATES and aborts the run. There is no counter for it
    // on purpose: at this point the credentials and the bucket have already
    // been proven by the account guard, so a failure here is systemic rather
    // than per-object, and the run is restartable (the row still says
    // octet-stream, and re-copying an object is idempotent).
    if (!dryRun) await mediaStore.setContentType(candidate.s3Key, canonical);
    candidate.row.staged[candidate.position] = canonical;
    result.recovered[canonical] = (result.recovered[canonical] ?? 0) + 1;
  }

  /** Bounded concurrency: `VENDOR_CONCURRENCY` workers pulling from a shared
   *  cursor. The cursor advances SYNCHRONOUSLY before the first await, so no
   *  two workers can claim the same index. No dependency, and no unbounded
   *  Promise.all over a whole page. */
  async function drain(candidates: readonly Candidate[]): Promise<void> {
    let cursor = 0;
    const workerCount = Math.min(VENDOR_CONCURRENCY, candidates.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const candidate = candidates[index];
          if (candidate === undefined) return;
          await repairAttachment(candidate);
        }
      }),
    );
  }

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: table,
        // Only message rows with something to repair. Pointer/claim rows in the
        // synthetic partitions carry neither attribute, so they never match.
        // The PER-ATTACHMENT predicate has to run in code: a FilterExpression
        // cannot test a list element.
        FilterExpression: 'attribute_exists(media_attachments) OR attribute_exists(media_s3_keys)',
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );

    const rows: RowWork[] = [];
    const candidates: Candidate[] = [];

    for (const raw of (page.Items ?? []) as MessageItem[]) {
      result.rowsScanned += 1;

      const attachments = raw.media_attachments;
      if (!Array.isArray(attachments)) {
        // Counted regardless of direction: this names an UNREPAIRABLE STORAGE
        // SHAPE (no stored type exists), not a rejected candidate.
        if (Array.isArray(raw.media_s3_keys)) result.skippedLegacyRow += 1;
        continue;
      }
      // Outbound attachments were uploaded by us with a known type; they were
      // never opaque and there is no Twilio media resource behind them.
      if (raw.direction !== 'inbound') continue;
      const mediaUrls = raw.mediaUrls;
      if (!Array.isArray(mediaUrls)) {
        // Inbound + attachments + no provider media URLs = inbound EMAIL.
        result.skippedEmailRow += 1;
        continue;
      }

      const row: RowWork = {
        conversationId: raw.conversationId,
        tsMsgId: raw.tsMsgId,
        attachments,
        staged: attachments.map(() => undefined),
      };
      let rowHasCandidate = false;

      for (let position = 0; position < attachments.length; position += 1) {
        const attachment = attachments[position];
        if (attachment === undefined) continue;
        // A partially repaired row must NOT re-query Twilio for the
        // attachments already fixed.
        if (attachment.contentType !== OPAQUE_CONTENT_TYPE) continue;
        result.eligible += 1;

        const mediaIndex = parseMediaIndexFromKey(attachment.s3Key);
        if (mediaIndex === undefined) {
          result.skippedUnparseableKey += 1;
          continue;
        }
        const url = mediaUrls[mediaIndex];
        const mediaSid = url === undefined ? undefined : parseMediaSid(url);
        if (mediaSid === undefined) {
          result.skippedNoUrl += 1;
          continue;
        }
        candidates.push({
          row,
          position,
          s3Key: attachment.s3Key,
          // The row's OWN provider SID - the Twilio MessageSid the media hangs
          // off - rather than one re-parsed out of the URL.
          messageSid: raw.provider_sid,
          mediaSid,
        });
        rowHasCandidate = true;
      }
      if (rowHasCandidate) rows.push(row);
    }

    await drain(candidates);

    for (const row of rows) {
      const repaired = row.staged.filter((canonical) => canonical !== undefined).length;
      if (repaired === 0) continue;
      if (dryRun) continue;
      // SAME ARRAY, SAME ORDER - only the contentType of repaired entries
      // changes. Positional identity is load-bearing twice over: pointer sort
      // keys are built from the array position (mediaPointerSk), and the
      // dashboard addresses bytes as /media/:idx where idx IS that position.
      // Hence map() - never filter, never reorder, never append.
      const merged: MediaAttachment[] = row.attachments.map((attachment, position) => {
        const canonical = row.staged[position];
        return canonical === undefined ? attachment : { ...attachment, contentType: canonical };
      });
      try {
        await messagesRepo.putMediaPointers(row.conversationId, row.tsMsgId, merged);
        await messagesRepo.annotateMessage(row.conversationId, row.tsMsgId, {
          mediaAttachments: merged,
        });
        result.written += repaired;
      } catch (err) {
        // One bad row must not abort a long ops run. The row still says
        // octet-stream, so the next run repairs it.
        logger.error(
          {
            err,
            conversationId: row.conversationId,
            tsMsgId: row.tsMsgId,
            attachmentCount: repaired,
          },
          'backfill:media-content-types - row write FAILED, not counted as written (re-runnable)',
        );
      }
    }

    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return result;
}

/**
 * The misconfiguration guard, and it is not optional.
 *
 * `getMediaContentType` resolves `undefined` for BOTH "Twilio no longer has
 * this media" and "this client cannot read media at all". Those are
 * indistinguishable at the call site, so a misconfigured run reports "every
 * attachment aged out", writes nothing and EXITS GREEN - the worst outcome,
 * because it looks like a completed repair.
 *
 * THE DRIVER CHECK IS THE LOAD-BEARING HALF. `createMessagingAdapter`
 * (adapters/messaging.ts:1162-1193) selects on `config.messagingDriver`, and
 * `loadConfig` (lib/config.ts:618) defaults that to 'console' whenever
 * MESSAGING_DRIVER is unset and NODE_ENV is not 'production' - EVEN WITH every
 * twilio* credential present. An operator shell with credentials exported but
 * MESSAGING_DRIVER unset would therefore pass a credentials-only guard, get the
 * CONSOLE driver, and hit exactly the green-exit catastrophe above. Checking the
 * credentials is still worth doing (belt and braces; loadConfig already
 * fail-fasts them, plus TWILIO_AUTH_TOKEN, when the driver is twilio -
 * lib/config.ts:623-629).
 *
 * An after-the-fact "recovered is empty" test is the WRONG predicate and is not
 * used: a fully repaired environment legitimately recovers nothing forever, and
 * a single aged-out attachment would trip it. The final report WARNS in that
 * case - a warning is informational, an exit code is a claim.
 */
function messagingMisconfiguration(config: AppConfig): string | undefined {
  if (config.messagingDriver !== 'twilio') {
    return 'MESSAGING_DRIVER is not "twilio", so this process would use the CONSOLE driver and read undefined for every attachment';
  }
  if (!config.twilioAccountSid || !config.twilioApiKeySid || !config.twilioApiKeySecret) {
    return 'MESSAGING_DRIVER=twilio but TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET are not all set';
  }
  return undefined;
}

const HOW_TO_FIX =
  'Set MESSAGING_DRIVER=twilio and TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID (plus MEDIA_BUCKET and TABLE_PREFIX) for the TARGET environment, then re-run.';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error({ err }, `backfill:media-content-types - config REJECTED, nothing scanned. ${HOW_TO_FIX}`);
    process.exitCode = 1;
    return;
  }

  const misconfiguration = messagingMisconfiguration(config);
  if (misconfiguration !== undefined) {
    // BEFORE THE SCAN, and on the CAUSE rather than a symptom.
    logger.error(
      { messagingDriver: config.messagingDriver },
      `backfill:media-content-types - REFUSING to run: ${misconfiguration}. ${HOW_TO_FIX}`,
    );
    process.exitCode = 1;
    return;
  }

  // THE ACCOUNT GUARD MUST BIND TO THE CLIENTS THIS SCRIPT WRITES THROUGH.
  // Asserting the account and then building clients from the default
  // credential chain proves an account the writes never touch - on this machine
  // the default chain is an UNRELATED account - and that is worse than no guard
  // because it reads as protection. So every client below is constructed
  // explicitly from `hcCredentials()` and injected.
  const identity = await assertHousingChoiceAccount();
  logger.info(
    { profile: HC_PROFILE, account: identity.Account },
    'backfill:media-content-types - account guard OK',
  );

  const credentials = hcCredentials();
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: HC_REGION, credentials }),
    // Must match lib/dynamo.ts createDocumentClient: dropping undefineds is
    // what keeps the sparse GSIs sparse.
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const mediaStore = createMediaStore({ config, credentials });
  if (mediaStore === undefined) {
    logger.error({}, `backfill:media-content-types - MEDIA_BUCKET is unset, so there is no bucket to repair. ${HOW_TO_FIX}`);
    process.exitCode = 1;
    return;
  }
  const adapter = createMessagingAdapter({ config });
  const messagesRepo = createMessagesRepo({ doc });

  logger.info({ dryRun }, 'backfill:media-content-types - starting');
  const result = await backfillMediaContentTypes({
    doc,
    adapter,
    mediaStore,
    messagesRepo,
    dryRun,
  });

  logger.info(
    { ...result, dryRun },
    `backfill:media-content-types - done${dryRun ? ' (DRY RUN - nothing written; Twilio WAS read, see vendorCalls)' : ''}`,
  );
  if (Object.keys(result.recovered).length === 0) {
    // A WARNING, never an exit code: a fully repaired environment recovers
    // nothing forever, so this data cannot honestly carry a failure claim.
    logger.warn(
      {
        eligible: result.eligible,
        skippedTwilio404: result.skippedTwilio404,
        skippedThrottled: result.skippedThrottled,
        skippedStillOpaque: result.skippedStillOpaque,
        vendorCalls: result.vendorCalls,
      },
      'backfill:media-content-types - nothing recovered. Expected once every repairable attachment is done; otherwise check the skip counters above.',
    );
  }
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('backfill-media-content-types.ts');
if (invokedDirectly) {
  main().catch((err: unknown) => {
    logger.error({ err }, 'backfill:media-content-types - FAILED');
    process.exitCode = 1;
  });
}
