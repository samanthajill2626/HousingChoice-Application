// media.mirror - the DEFERRED tail of the inbound-media mirror (prod incident
// 2026-08-17/18: 2 of 6 inbound MMS in one day lost their photo because Twilio
// served the media a beat after the webhook and the single inline fetch 404'd).
//
// The webhook's inline tries (services/mediaMirror.ts, ~1.2s) cover the
// observed race. This job covers a provider that stays slow for longer, on a
// schedule of MINUTES the webhook could never afford: +5s, +15s, +45s, +2min
// (MAX_MEDIA_MIRROR_ATTEMPTS rungs), then ONE ERROR that names the message. It
// re-mirrors only the attachments still missing, APPENDS what lands to the
// message's stored attachments (the dashboard addresses an attachment by its
// position in that array, so appending never invalidates a URL already
// rendered), and hands the rest to the next rung.
//
// IDEMPOTENT under at-least-once delivery: the S3 key is deterministic
// (media/<conversationId>/<sid>/<i>), and the append dedupes by s3Key, so a
// redelivered rung re-puts the same object and records it once. No execution
// marker needed - nothing here texts a human.
//
// PII (doc 9): the payload carries provider media URLs (account/message SIDs,
// no phone numbers, no bytes); logs carry SIDs, indexes and counts only.
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { createMessagingAdapter, type MessagingAdapter } from '../adapters/messaging.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  type MediaAttachment,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import { INLINE_MIRROR_DELAYS_MS, mirrorMediaSet, type MediaMirrorTarget } from '../services/mediaMirror.js';
import { defineJobHandler, enqueue } from './jobs.js';

export const MEDIA_MIRROR_JOB = 'media.mirror';

/** Rungs of the deferred tail; the LAST failing rung is the ERROR. */
export const MAX_MEDIA_MIRROR_ATTEMPTS = 4;

/** +5s, +15s, +45s, +2min for attempts 1..4 - minutes of tail, front-loaded. */
export function mediaMirrorBackoffMs(attempt: number): number {
  const rungs = [5_000, 15_000, 45_000, 120_000] as const;
  return rungs[Math.min(Math.max(attempt, 1), rungs.length) - 1]!;
}

export interface MediaMirrorPayload {
  conversationId: string;
  tsMsgId: string;
  messageSid: string;
  /** The attachments STILL MISSING - never the ones already stored. */
  media: MediaMirrorTarget[];
  /** 1-based rung of THIS run. */
  attempt: number;
}

export function parseMediaMirrorPayload(payload: unknown): MediaMirrorPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('media.mirror: payload is not an object');
  }
  const p = payload as Partial<MediaMirrorPayload>;
  for (const key of ['conversationId', 'tsMsgId', 'messageSid'] as const) {
    if (typeof p[key] !== 'string' || p[key].length === 0) throw new Error(`media.mirror: missing ${key}`);
  }
  if (!Array.isArray(p.media) || p.media.length === 0) throw new Error('media.mirror: media is empty');
  const media: MediaMirrorTarget[] = p.media.map((m, i) => {
    if (typeof m !== 'object' || m === null) throw new Error(`media.mirror: media[${i}] is not an object`);
    const t = m as Partial<MediaMirrorTarget>;
    if (typeof t.index !== 'number' || !Number.isInteger(t.index) || t.index < 0) {
      throw new Error(`media.mirror: media[${i}].index invalid`);
    }
    if (typeof t.url !== 'string' || t.url.length === 0) throw new Error(`media.mirror: media[${i}].url missing`);
    return {
      index: t.index,
      url: t.url,
      ...(typeof t.contentType === 'string' && { contentType: t.contentType }),
    };
  });
  if (
    typeof p.attempt !== 'number' ||
    !Number.isInteger(p.attempt) ||
    p.attempt < 1 ||
    p.attempt > MAX_MEDIA_MIRROR_ATTEMPTS
  ) {
    throw new Error(`media.mirror: invalid attempt (1..${MAX_MEDIA_MIRROR_ATTEMPTS})`);
  }
  return {
    conversationId: p.conversationId as string,
    tsMsgId: p.tsMsgId as string,
    messageSid: p.messageSid as string,
    media,
    attempt: p.attempt,
  };
}

/** Producer side (the webhook, and this job's own next rung): schedule ONE rung. */
export async function enqueueMediaMirror(payload: MediaMirrorPayload, runAt: Date): Promise<void> {
  await enqueue(MEDIA_MIRROR_JOB, payload, { runAt });
}

export interface MediaMirrorJobDeps {
  messagingAdapter?: MessagingAdapter;
  /** Undefined when MEDIA_BUCKET is unset (a no-bucket dev loop). */
  mediaStore?: MediaStore;
  messagesRepo?: Pick<MessagesRepo, 'getByTsMsgId' | 'annotateMessage'>;
  logger?: Logger;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  enqueueMirror?: (payload: MediaMirrorPayload, runAt: Date) => Promise<void>;
  now?: () => Date;
}

/** Consumer side (registerHandlers.ts): register the handler with real (or test) deps. */
export function registerMediaMirrorJobHandler(deps: MediaMirrorJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  const enqueueMirror = deps.enqueueMirror ?? enqueueMediaMirror;
  const now = deps.now ?? ((): Date => new Date());
  // Lazy: adapter/store/repo touch config + AWS only on first job run.
  let adapter = deps.messagingAdapter;
  let messages = deps.messagesRepo;
  let mediaStore = deps.mediaStore;
  let mediaStoreInit = deps.mediaStore !== undefined;

  defineJobHandler(MEDIA_MIRROR_JOB, async (rawPayload) => {
    const payload = parseMediaMirrorPayload(rawPayload);
    adapter ??= createMessagingAdapter({ ...(deps.logger !== undefined && { logger: deps.logger }) });
    messages ??= createMessagesRepo({ ...(deps.logger !== undefined && { logger: deps.logger }) });
    if (!mediaStoreInit) {
      mediaStore = createMediaStore();
      mediaStoreInit = true;
    }
    if (!mediaStore) {
      log.warn(
        { providerSid: payload.messageSid, mediaCount: payload.media.length },
        'media.mirror: MEDIA_BUCKET is not configured - nothing to mirror into',
      );
      return;
    }

    const outcome = await mirrorMediaSet(
      { adapter, mediaStore, logger: log, ...(deps.sleep !== undefined && { sleep: deps.sleep }) },
      {
        conversationId: payload.conversationId,
        messageSid: payload.messageSid,
        targets: payload.media,
        delaysMs: INLINE_MIRROR_DELAYS_MS,
      },
    );

    // APPEND what landed to what the message already carries (the webhook's
    // inline successes, or an earlier rung's). Dedupe by s3Key so a redelivered
    // rung records nothing twice.
    if (outcome.attachments.length > 0) {
      const current = await messages.getByTsMsgId(payload.conversationId, payload.tsMsgId);
      const existing: MediaAttachment[] = current ? mediaAttachmentsOf(current) : [];
      const seen = new Set(existing.map((a) => a.s3Key));
      const merged = [...existing];
      for (const { attachment } of outcome.attachments) {
        if (seen.has(attachment.s3Key)) continue;
        seen.add(attachment.s3Key);
        merged.push(attachment);
      }
      await messages.annotateMessage(payload.conversationId, payload.tsMsgId, { mediaAttachments: merged });
      log.info(
        {
          providerSid: payload.messageSid,
          attempt: payload.attempt,
          mirrored: outcome.attachments.length,
          event: 'media_mirror_deferred_landed',
        },
        'media.mirror: deferred attachments mirrored and recorded on the message',
      );
    }

    const permanent = outcome.failed.filter((f) => !f.retryable);
    for (const f of permanent) {
      log.error(
        { providerSid: payload.messageSid, mediaIndex: f.index, attempt: payload.attempt, event: 'media_mirror_refused' },
        'media.mirror: provider refused this attachment permanently - message record keeps the provider URL',
      );
    }

    const transient = outcome.failed.filter((f) => f.retryable);
    if (transient.length === 0) return;
    if (payload.attempt >= MAX_MEDIA_MIRROR_ATTEMPTS) {
      log.error(
        {
          providerSid: payload.messageSid,
          conversationId: payload.conversationId,
          mediaIndexes: transient.map((f) => f.index),
          attempts: payload.attempt,
          event: 'media_mirror_exhausted',
        },
        'media.mirror: attachments still not fetchable after every rung - message record keeps the provider URL',
      );
      return;
    }
    const next: MediaMirrorPayload = {
      ...payload,
      media: payload.media.filter((m) => transient.some((f) => f.index === m.index)),
      attempt: payload.attempt + 1,
    };
    const runAt = new Date(now().getTime() + mediaMirrorBackoffMs(next.attempt));
    await enqueueMirror(next, runAt);
    log.warn(
      {
        providerSid: payload.messageSid,
        mediaIndexes: next.media.map((m) => m.index),
        attempt: payload.attempt,
        nextAttempt: next.attempt,
        runAt: runAt.toISOString(),
        event: 'media_mirror_deferred',
      },
      'media.mirror: attachments still not fetchable - next rung scheduled',
    );
  });
}
