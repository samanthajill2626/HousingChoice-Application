// /api router — dashboard-facing REST (M1.1 outbound send; M1.2 conversation
// hub: inbox, thread, unread, SSE live updates).
//
// AUTH (M1.3): every route in this router — the SSE stream included — sits
// behind sessionMiddleware + requireAuth, mounted ahead of it in app.ts.
// Role gates are deliberately MINIMAL: VAs run the day-to-day, so nothing here
// uses requireRole('admin') until a genuinely admin-only surface exists (see
// middleware/auth.ts).
//
// PII (doc §9): responses carry bodies/previews to the authenticated client;
// LOG LINES never do — logs are IDs/counts only, correlated via the pino mixin.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { createMessagingAdapter, type MessagingAdapter } from '../adapters/messaging.js';
import { isInlineMediaType, isTwilioDeliverableType, normalizeStoredMediaType } from '../lib/mediaTypes.js';
import { renditionFor } from '../lib/mmsRenditions.js';
import {
  OUTBOUND_MMS_MAX_MEDIA,
  OUTBOUND_MMS_MAX_TOTAL_BYTES,
  UPLOAD_KEY_PATTERN,
} from '../lib/outboundMediaLimits.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { normalizeEmailAddress } from '../lib/email.js';
import { getContext, mergeContext, runWithContext } from '../lib/context.js';
import {
  appEvents,
  toConversationUpdatedEvent,
  type BroadcastUpdatedEvent,
  type PlacementUpdatedEvent,
  type ConversationUpdatedEvent,
  type EventBus,
  type MessagePersistedEvent,
  type ScheduledUpdatedEvent,
  type TourUpdatedEvent,
  type SuggestionUpdatedEvent,
} from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createUserRateLimit } from '../middleware/rateLimit.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  relayMemberKey,
  type MediaAttachment,
  type MessagesRepo,
  type RelayRecipientDelivery,
} from '../repos/messagesRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createActivityEventsRepo, type ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import { createListingSendsRepo, type ListingSendsRepo } from '../repos/listingSendsRepo.js';
import { type SettingsRepo } from '../repos/settingsRepo.js';
import { type ContactVocabularyRepo } from '../repos/contactVocabularyRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import { createPlacementsRepo, type PlacementsRepo } from '../repos/placementsRepo.js';
import {
  createPlacementDeadlinesRepo,
  type PlacementDeadlinesRepo,
} from '../repos/placementDeadlinesRepo.js';
import { createUsersRepo, displayNameOf, type UsersRepo } from '../repos/usersRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import {
  createSendEmailMessageService,
  EmailSendRefusedError,
  type SendEmailService,
} from '../services/sendEmailMessage.js';
import { createApplyParkedEmailEvents } from '../services/emailEvents.js';
import { type PushService } from '../services/pushService.js';
import { type PoolNumbersService } from '../services/poolNumbers.js';
import { createPoolNumbersRepo, type PoolNumbersRepo } from '../repos/poolNumbersRepo.js';
import { createPlacementNudgesRepo, type PlacementNudgesRepo } from '../repos/placementNudgesRepo.js';
import { createExtractionRepo, type ExtractionRepo } from '../repos/extractionRepo.js';
import { createSuggestionsRouter } from './suggestions.js';
import { armNudgeForStage } from '../jobs/placementNudges.js';
import { enqueueImmediate } from '../jobs/jobs.js';
import {
  RELAY_FANOUT_JOB,
  TEAM_SENDER_KEY,
  TEAM_SENDER_LABEL,
} from '../jobs/relayFanOut.js';
import { type BroadcastsRepo } from '../repos/broadcastsRepo.js';
import { type AudienceResolutionService } from '../services/audienceResolution.js';
import { createAdminUsersRouter } from './adminUsers.js';
import { createPoolNumbersAdminRouter } from './poolNumbersAdmin.js';
import { createUsersMeRouter, createVoiceCallRouter } from './voiceApi.js';
import { createBroadcastsRouter } from './broadcasts.js';
import { createPlacementsRouter } from './placements.js';
import { createPlacementNudgesRouter } from './placementNudges.js';
import { createContactsRouter } from './contacts.js';
import { createContactTimelineRouter } from './contactTimeline.js';
import { createInboxRouter } from './inbox.js';
import { createUnmatchedEmailRouter } from './unmatchedEmail.js';
import { type UnmatchedEmailRepo } from '../repos/unmatchedEmailRepo.js';
import { createMmsMediaRouter } from './mmsMedia.js';
import { createEmailMediaRouter } from './emailMedia.js';
import { createPushRouter } from './push.js';
import { createRelayGroupsRouter } from './relayGroups.js';
import { createSettingsRouter } from './settings.js';
import { createStatusTransitionRouter } from './statusTransition.js';
import { createSystemRouter } from './system.js';
import { createTodayRouter } from './today.js';
import { createUnitsRouter } from './units.js';
import { createToursRouter } from './tours.js';
import { createTourRemindersRouter } from './tourReminders.js';
import { createToursRepo, type ToursRepo } from '../repos/toursRepo.js';
import { createTourRemindersRepo, type TourRemindersRepo } from '../repos/tourRemindersRepo.js';
import { type SystemStatusService } from '../services/systemStatus.js';

/** Refusal code → HTTP status for the send endpoint. */
const REFUSAL_STATUS: Record<SendRefusedError['code'], number> = {
  conversation_not_found: 404,
  contact_opted_out: 409,
  // JIT consent gate (A2P/CTIA): a proactive human send to a no-consent contact
  // is blocked; the dashboard records consent via PATCH /api/contacts/:id then
  // retries the send.
  contact_no_consent: 409,
  manual_mode: 409,
  breaker_open: 429,
  relay_not_supported: 409,
  // A2P kill-switch (pre-A2P): SMS sending disabled → 503 (matches the relay
  // provisioning kill-switch's 503 posture).
  sms_sending_disabled: 503,
};

/**
 * Email refusal code -> HTTP status for POST /api/conversations/:id/email.
 * NOTE (worklist ADJ-6 divergence 1, DELIBERATE): email_sending_disabled maps
 * to 409, NOT the 503 the SMS kill-switch uses - do not "fix" it to 503. The
 * two 400-class codes (invalid_cc / invalid_attachment) are request-validation
 * refusals A6 should also surface as friendly copy.
 */
const EMAIL_REFUSAL_STATUS: Record<EmailSendRefusedError['code'], number> = {
  conversation_not_found: 404,
  conversation_contact_mismatch: 409,
  email_sending_disabled: 409,
  email_suppressed: 409,
  email_attachments_too_large: 409,
  contact_email_missing: 409,
  invalid_cc: 400,
  invalid_attachment: 400,
};


/** Page-size bounds shared by the inbox and thread endpoints. */
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

/**
 * The statuses conversations actually use (conversationsRepo: `open` is the
 * only value any code path writes — create, touchLastActivity). ?status= is
 * the byLastActivity partition key, so anything else is allowlisted here
 * before it reaches DynamoDB; extend this set when a close/archive flow
 * lands.
 */
const CONVERSATION_STATUSES = new Set(['open']);

/**
 * SSE heartbeat period. CloudFront severs idle origin reads at 30s by
 * default — 25s comment frames keep the stream alive through it.
 */
const SSE_HEARTBEAT_MS = 25_000;

export interface ApiRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Test seam: injected service (no DynamoDB/provider). */
  sendMessageService?: SendMessageService;
  /** Email-channel A5: injected email send service (test seam). */
  sendEmailService?: SendEmailService;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  auditRepo?: AuditRepo;
  /**
   * S3 media store (M1.9c: serve the founder-bridge recording back to the authed
   * dashboard). Undefined when MEDIA_BUCKET is unset — the recording endpoint
   * then answers 404 (nothing is stored locally).
   */
  mediaStore?: MediaStore;
  /** M1.4 surfaces — injected in tests; default to the real repos/services. */
  contactsRepo?: ContactsRepo;
  settingsRepo?: SettingsRepo;
  /** Task 4: auto-suggest vocabulary (roles, relationship roles, field labels). */
  contactVocabularyRepo?: ContactVocabularyRepo;
  usersRepo?: UsersRepo;
  pushService?: PushService;
  /**
   * Messaging adapter (Voice Phase 1): the originate route (initiateCall) + the
   * self cell verify-start (adapter.sendMessage directly) use it. Injected in
   * tests (the world fake); defaults to the real adapter.
   */
  adapter?: MessagingAdapter;
  /** M1.4 System Status — injected in tests (fake, no AWS); defaults to the real service. */
  systemStatusService?: SystemStatusService;
  /** M1.5 records & intake — injected in tests; default to the real repo. */
  unitsRepo?: UnitsRepo;
  /** M1.10 boards/placements — injected in tests; default to the real repo. */
  placementsRepo?: PlacementsRepo;
  /** First-class placement deadlines (placement-deadline-model) — injected in tests. */
  placementDeadlinesRepo?: PlacementDeadlinesRepo;
  /** Tours — injected in tests; default to the real repo. */
  toursRepo?: ToursRepo;
  /** Tour reminders — injected in tests; default to the real repo. */
  tourRemindersRepo?: TourRemindersRepo;
  /** Injected clock for tour-reminder arm/re-arm dueAt computation (tests only). */
  toursNow?: () => string;
  /** BE2/C2 activity-event log — injected in tests; default to the real repo. */
  activityEventsRepo?: ActivityEventsRepo;
  /** BE4/C4 listing-send record — injected in tests; default to the real repo. */
  listingSendsRepo?: ListingSendsRepo;
  /** M1.7 relay groups — injected in tests; defaults to the real service. */
  poolNumbersService?: PoolNumbersService;
  /**
   * pool-numbers admin inventory (GET /api/pool-numbers) - injected in tests;
   * defaults to the real repo. The route reads listByState (repo), not the service.
   */
  poolNumbersRepo?: PoolNumbersRepo;
  /** Injected clock for the pool-numbers retire-mirror grace cutoff (tests only). */
  poolNumbersNow?: () => Date;
  contactsRepoForRelay?: ContactsRepo;
  /**
   * Post-Tour & Application (Task 5) — durable placement-nudge rows. Injected in
   * tests (a no-network fake); defaults to the real repo. Feeds the choke-point
   * `armStageNudge` hook wired onto the transition service.
   */
  placementNudgesRepo?: PlacementNudgesRepo;
  /**
   * conversation-fact-extraction (T8) - the pending-suggestion store. Read by the
   * review API (suggestions router) + the contact-PATCH provenance-clear. Injected
   * in tests (a no-network fake); defaults to the real repo.
   */
  extractionRepo?: ExtractionRepo;
  /** M1.8a share-broadcast — injected in tests; default to the real repo/service. */
  broadcastsRepo?: BroadcastsRepo;
  audienceResolutionService?: AudienceResolutionService;
  /**
   * email-channel B3: the unmatched_email side-door store (triage routes +
   * B2's ingestion dep). Injected in tests; defaults to the real repo.
   */
  unmatchedEmailRepo?: UnmatchedEmailRepo;
  /** SSE live-update bus (M1.2); the process singleton by default. */
  events?: EventBus;
  /** Test seam: shrink the 25s SSE heartbeat. */
  sseHeartbeatMs?: number;
}

// --- Inbox cursor (opaque to clients) ---------------------------------------
// base64url(JSON) of the Query's LastEvaluatedKey. Clients echo it back via
// ?cursor= — it is never constructed by hand.

function encodeCursor(lastEvaluatedKey: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

/**
 * Decode + validate a cursor against the EXACT ExclusiveStartKey shape for
 * byLastActivity: { conversationId, status, last_activity_at }, all strings,
 * nothing else. Anything off-shape is a 400 upstream — a client-tampered
 * cursor must never reach DynamoDB as a malformed key.
 */
function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const key = parsed as Record<string, unknown>;
      const expected = ['conversationId', 'status', 'last_activity_at'];
      if (
        Object.keys(key).length === expected.length &&
        expected.every((field) => typeof key[field] === 'string')
      ) {
        return key;
      }
    }
  } catch {
    // fall through — malformed cursors are a 400, not a crash
  }
  return undefined;
}

/**
 * Parse an optional ?limit= into 1..MAX_PAGE_LIMIT. Returns undefined when
 * the value is invalid (caller responds 400).
 */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return undefined;
  return limit;
}

/** The denormalized summary the hub's inbox list renders (doc §5). */
function toConversationSummary(item: ConversationItem): Record<string, unknown> {
  return {
    conversationId: item.conversationId,
    type: item.type,
    participant_phone: item.participant_phone,
    participants: item.participants ?? [],
    preview: item.last_message_preview ?? null,
    participant_display_name: item.participant_display_name ?? null,
    last_activity_at: item.last_activity_at,
    unread_count: item.unread_count ?? 0,
    sms_opt_out: item.sms_opt_out === true,
  };
}

/**
 * Validate client-supplied `attachmentKeys` (outbound MMS, design Sec 4) and
 * resolve them to durable MediaAttachment records. Each key must be one our
 * OWN upload endpoint minted (UPLOAD_KEY_PATTERN - the client can never point
 * us at an arbitrary bucket key); at most OUTBOUND_MMS_MAX_MEDIA; each
 * HeadObject'd (missing -> unknown_attachment) with its stored type checked
 * against TWILIO_DELIVERABLE_MMS_TYPES (the 12300 root-cause guard: only
 * jpeg/png/gif may reach Twilio, even if confirm was bypassed) and sizes
 * summed under the carrier total cap - measured over the DELIVERABLE rendition
 * objects, exactly what goes to Twilio. `originalKeys` (index-aligned, from
 * confirm) ride onto each attachment as `originalKey` (RCS-forward, spec Sec
 * 5). Returns the attachments on success, or a {status, error} the caller maps
 * straight to the HTTP response. Presigning is the caller's job (per-attempt):
 * 1:1 presigns now; relay presigns per leg in the fan-out. Exported for tests.
 */
export async function resolveAttachmentKeys(
  keys: string[],
  originalKeys: string[] | undefined,
  mediaStore: MediaStore | undefined,
): Promise<{ ok: true; attachments: MediaAttachment[] } | { ok: false; status: number; error: string }> {
  if (keys.length > OUTBOUND_MMS_MAX_MEDIA) {
    return { ok: false, status: 400, error: 'too_many_attachments' };
  }
  if (!keys.every((k) => UPLOAD_KEY_PATTERN.test(k))) {
    return { ok: false, status: 400, error: 'invalid_attachment_key' };
  }
  // originalKeys are client input too, and get PERSISTED (a future RCS channel
  // presigns them): same own-prefix rule, and index alignment must hold so the
  // pairing cannot be desynchronized.
  if (
    originalKeys !== undefined &&
    (originalKeys.length !== keys.length || !originalKeys.every((k) => UPLOAD_KEY_PATTERN.test(k)))
  ) {
    return { ok: false, status: 400, error: 'invalid_attachment_key' };
  }
  if (!mediaStore) {
    return { ok: false, status: 503, error: 'media_storage_unavailable' };
  }
  const attachments: MediaAttachment[] = [];
  let totalBytes = 0;
  for (let i = 0; i < keys.length; i++) {
    const s3Key = keys[i]!;
    const meta = await mediaStore.head(s3Key);
    if (!meta) {
      return { ok: false, status: 400, error: 'unknown_attachment' };
    }
    const contentType = (meta.contentType ?? '').trim().toLowerCase();
    // Deliverable-type guard: only jpeg/png/gif may reach Twilio (12300 fix).
    if (!isTwilioDeliverableType(contentType)) {
      return { ok: false, status: 400, error: 'unsupported_attachment_type' };
    }
    totalBytes += meta.size ?? 0;
    const originalKey = originalKeys?.[i];
    attachments.push({ s3Key, contentType, ...(originalKey !== undefined && { originalKey }) });
  }
  if (totalBytes > OUTBOUND_MMS_MAX_TOTAL_BYTES) {
    return { ok: false, status: 400, error: 'attachments_too_large' };
  }
  return { ok: true, attachments };
}

export function createApiRouter(deps: ApiRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  // pool-numbers admin inventory (GET /api/pool-numbers) reads the repo directly
  // (listByState); the service has no list method.
  const poolNumbers = deps.poolNumbersRepo ?? createPoolNumbersRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  // BE2/C2: the activity-event log feeds the merged timeline + is emitted into
  // by the placement/relay/phone flows. Shared across the sub-routers below.
  const activityEvents = deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
  // BE4/C4: the listing-send record — read by the units recipients + contacts
  // listings-sent endpoints, written by the response PATCH. Shared across the
  // sub-routers below.
  const listingSends = deps.listingSendsRepo ?? createListingSendsRepo({ logger: deps.logger });
  // Post-Tour & Application (Task 5): the choke-point side effect wired onto the
  // ONE transition service. `armStageNudge` re-keys the stage-application nudge
  // ladder on every move (best-effort inside the transition service).
  // (relay-number-lifecycle spec 4.1: the lost-move relay-close hook was removed -
  // nothing auto-closes a relay group; closing is a human choice.)
  const placementNudges = deps.placementNudgesRepo ?? createPlacementNudgesRepo({ logger: deps.logger });
  // First-class placement deadlines (placement-deadline-model): shared across the
  // placements / status-transition / today / contacts sub-routers so arm/retire
  // and the computed next_deadline read all hit ONE repo.
  const placementDeadlines =
    deps.placementDeadlinesRepo ?? createPlacementDeadlinesRepo({ logger: deps.logger });
  // conversation-fact-extraction (T8): the pending-suggestion store, shared by the
  // review API (suggestions router) and the contacts-router PATCH provenance-clear.
  const extraction = deps.extractionRepo ?? createExtractionRepo({ logger: deps.logger });
  // Scheduled-message-visibility (Task 4 "Upcoming" gather): the contact-timeline
  // gather walks these five scheduled-send repos. Default-construct them here (the
  // same `?? create…` pattern as conversations/messages above) so the gather is
  // LIVE in production/e2e — the production composition root (index.ts) calls
  // buildApp with NO `api` deps, so nothing was injecting them and the gather was
  // permanently gated off. Each factory only builds a client object (no network at
  // construction); the gather itself is best-effort/try-caught in the router, so a
  // repo miss yields an empty `upcoming[]`, never a 500. `placementNudges` above is
  // reused (not rebuilt). Tests that inject fakes via `deps.X` still win through `??`.
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });
  const tourReminders = deps.tourRemindersRepo ?? createTourRemindersRepo({ logger: deps.logger });
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  // M1.9c recording serving: undefined when MEDIA_BUCKET is unset (404 then).
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });
  // Voice Phase 1: the originate route + self cell verify-start need a messaging
  // adapter (initiateCall / adapter.sendMessage). Shared across those sub-routers.
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });
  const events = deps.events ?? appEvents;
  const sseHeartbeatMs = deps.sseHeartbeatMs ?? SSE_HEARTBEAT_MS;
  const sendMessage =
    deps.sendMessageService ??
    createSendMessageService({
      config,
      logger: deps.logger,
      conversationsRepo: conversations,
      messagesRepo: messages,
      auditRepo: audit,
      events,
    });
  // Email-channel A5: the outbound email send service. Default-constructed HERE
  // (the sendMessage precedent lives in this router, not index.ts) so the
  // production composition root needs no change; it builds its own EmailAdapter
  // from config. The email send route also resolves the recipient contact by
  // address, so a contacts repo is shared with it.
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  // The email From line renders "<name> at Housing Choice" to the RECIPIENT;
  // the session user carries no `name`, so resolve the full user record
  // (best-effort - a users-table blip falls back to the session identity).
  const usersForEmail = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const sendEmail =
    deps.sendEmailService ??
    createSendEmailMessageService({
      config,
      logger: deps.logger,
      conversationsRepo: conversations,
      messagesRepo: messages,
      contactsRepo: contacts,
      ...(mediaStore !== undefined && { mediaStore }),
      events,
      // B5/ADJ-7: the post-send orphan-event consumer. Shares THIS router's repos
      // so the parking-lot read + the alias write see one table view (a fast
      // bounce parked before the send returns is applied the moment it lands).
      applyParkedEmailEvents: createApplyParkedEmailEvents({
        messagesRepo: messages,
        contactsRepo: contacts,
        conversationsRepo: conversations,
        logger: deps.logger,
      }),
    });

  const router = Router();

  // --- M1.4 sub-routers (all behind requireAuth via the /api mount; the
  // admin-only gate lives inside adminUsers + the settings PUT) ---
  // Push (web push subscriptions, vapid key, test send).
  router.use(
    '/push',
    createPushRouter({
      config,
      logger: deps.logger,
      ...(deps.usersRepo !== undefined && { usersRepo: deps.usersRepo }),
      ...(deps.pushService !== undefined && { pushService: deps.pushService }),
    }),
  );
  // Outbound MMS media (POST /api/media/presign + /confirm) - the browser
  // uploads the original DIRECTLY to S3 via a presigned POST, then confirm
  // validates/transcodes it into a Twilio-deliverable rendition the send route
  // later presigns. Replaces the busboy through-EC2 /media/uploads endpoint.
  router.use(
    '/media',
    createMmsMediaRouter({
      config,
      logger: deps.logger,
      ...(mediaStore !== undefined && { mediaStore }),
    }),
  );
  // Email attachment media (POST /api/email-media/presign + /confirm) - a
  // DISTINCT pair from /media above (review F1): it stores documents VERBATIM
  // (no transcode/planMmsMedia), on the EMAIL_ATTACHMENT_TYPES allowlist with a
  // 25 MB cap. The email send route resolves these keys straight to attachments.
  router.use(
    '/email-media',
    createEmailMediaRouter({
      config,
      logger: deps.logger,
      ...(mediaStore !== undefined && { mediaStore }),
    }),
  );
  // Founder settings (GET requireAuth, PUT requireRole admin).
  router.use(
    '/settings',
    createSettingsRouter({
      logger: deps.logger,
      ...(deps.settingsRepo !== undefined && { settingsRepo: deps.settingsRepo }),
      auditRepo: audit,
    }),
  );
  // Self cell verification + self view (Voice Phase 1, spec §7) — mounted at
  // /users BEFORE the admin router so the literal `me` segment is owned here
  // (requireAuth only; a VA verifies their OWN cell) and is never captured as a
  // :userId by the admin router's requireRole('admin') routes below.
  router.use(
    '/users',
    createUsersMeRouter({
      config,
      logger: deps.logger,
      adapter,
      ...(deps.usersRepo !== undefined && { usersRepo: deps.usersRepo }),
      // verify-start registers the code SMS's SID as a system send (syssid#)
      // so /status receipts for it never trip the unknown-SID ERROR backstop.
      messagesRepo: messages,
    }),
  );
  // Admin user-management (requireRole admin on every route) + the inbound-voice-
  // line assignment (spec §6).
  router.use(
    '/users',
    createAdminUsersRouter({
      logger: deps.logger,
      ...(deps.usersRepo !== undefined && { usersRepo: deps.usersRepo }),
      auditRepo: audit,
    }),
  );
  // Group text numbers - admin-only READ-ONLY pool-number inventory
  // (GET /api/pool-numbers; requireRole admin inside the router). Reads the pool
  // repo (listByState) + each number's byPoolNumber group history; the retire
  // block mirrors services/poolNumbers.ts retireEligible.
  router.use(
    '/pool-numbers',
    createPoolNumbersAdminRouter({
      logger: deps.logger,
      poolNumbersRepo: poolNumbers,
      conversationsRepo: conversations,
      ...(deps.poolNumbersNow !== undefined && { now: deps.poolNumbersNow }),
    }),
  );
  // System Status (M1.4; requireRole admin on every route). Go-live flags +
  // CloudWatch alarms/errors, degrading gracefully when AWS is unreachable.
  router.use(
    '/system',
    createSystemRouter({
      config,
      logger: deps.logger,
      ...(deps.systemStatusService !== undefined && {
        systemStatusService: deps.systemStatusService,
      }),
    }),
  );
  // Contact triage + CRUD (requireAuth — VAs triage; propagates conversation
  // type and emits conversation.updated so connected inboxes update live).
  router.use(
    '/contacts',
    createContactsRouter({
      logger: deps.logger,
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      conversationsRepo: conversations,
      // BE5/C5: GET /:id/media aggregates a contact's MMS attachments.
      messagesRepo: messages,
      auditRepo: audit,
      // BE2: emit `number_added` on a successful POST /:id/phones.
      activityEventsRepo: activityEvents,
      // BE4: serve GET /:id/listings-sent.
      listingSendsRepo: listingSends,
      // listing-response-tour-chip: derive the per-row tour chip (byTenant GSI).
      toursRepo: tours,
      // Task 4: vocabulary auto-suggest.
      ...(deps.contactVocabularyRepo !== undefined && { vocabularyRepo: deps.contactVocabularyRepo }),
      // Voucher sync (placement-deadline-model §6): a voucher_expiration_date edit
      // upserts/retires the voucher deadline on the tenant's active placements.
      ...(deps.placementsRepo !== undefined && { placementsRepo: deps.placementsRepo }),
      placementDeadlinesRepo: placementDeadlines,
      // conversation-fact-extraction (T8): a human field edit clears AI provenance
      // + supersedes any pending suggestion for that field (best-effort).
      extractionRepo: extraction,
      // Triage re-extraction hook: a flip to tenant schedules an immediate
      // 'triage' run (gated by the same kill switch as the other schedule sites).
      aiExtractionEnabled: config.aiExtractionEnabled,
      events,
    }),
  );
  // BE2/C2 person-centric merged timeline. Mounted at /contacts too (its only
  // path is GET /:contactId/timeline — a distinct segment from the contacts
  // router's routes, so the two never collide; both sit behind the same auth).
  router.use(
    '/contacts',
    createContactTimelineRouter({
      logger: deps.logger,
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      conversationsRepo: conversations,
      messagesRepo: messages,
      activityEventsRepo: activityEvents,
      // WS3 Task 3.2: a landlord's owned-property lifecycle interleave reads the
      // shared audit trail (the units byLandlord GSI is forwarded below for the
      // gather and shared by the interleave). Forward the RESOLVED `audit` local
      // (same rationale as the gather repos below) so prod/e2e read a real repo.
      auditRepo: audit,
      // Task 4 "Upcoming" gather: forward the five scheduled-send repos so the
      // timeline can project pending tour reminders + placement nudges. Forward the
      // RESOLVED locals (each `deps.X ?? create…` above), NOT `deps.X` — the router
      // only runs the gather when ALL five are present, and the production
      // composition root (index.ts) passes NO `api` deps, so forwarding `deps.X`
      // here left them undefined and the gather permanently off in prod/e2e. The
      // locals default-construct real repos (best-effort/try-caught in the router),
      // while tests injecting fakes still win through the `??`.
      toursRepo: tours,
      tourRemindersRepo: tourReminders,
      placementNudgesRepo: placementNudges,
      placementsRepo: placements,
      unitsRepo: units,
      config,
    }),
  );
  // Outbound masked calling (Voice Phase 1, spec §5) — mounted at /contacts so it
  // owns POST /contacts/:contactId/call (a distinct segment from the contacts CRUD
  // routes above; requireAuth via the /api mount — VAs place calls, no admin gate).
  router.use(
    '/contacts',
    createVoiceCallRouter({
      config,
      logger: deps.logger,
      adapter,
      conversationsRepo: conversations,
      messagesRepo: messages,
      events,
      ...(deps.usersRepo !== undefined && { usersRepo: deps.usersRepo }),
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
    }),
  );
  // Units CRUD (M1.5; requireAuth — VAs maintain properties, no admin gate).
  router.use(
    '/units',
    createUnitsRouter({
      logger: deps.logger,
      ...(deps.unitsRepo !== undefined && { unitsRepo: deps.unitsRepo }),
      auditRepo: audit,
      // BE3: POST/DELETE /:id/contacts resolve a roster contact's name/company.
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      // BE4: GET /:id/recipients (the "Sent to tenants" recipients read).
      listingSendsRepo: listingSends,
      // listing-response-tour-chip: derive the per-row tour chip (byUnit GSI).
      toursRepo: tours,
      // FIX 3: GET /:id/placements lists the unit's placements (tenant-name enriched).
      ...(deps.placementsRepo !== undefined && { placementsRepo: deps.placementsRepo }),
      // unit-photos: presign/confirm direct-upload + display resolution
      // (presign-per-read).
      ...(mediaStore !== undefined && { mediaStore }),
    }),
  );
  // Tours CRUD (Tours feature; requireAuth — VAs schedule tours, no admin gate).
  router.use(
    '/tours',
    createToursRouter({
      config,
      logger: deps.logger,
      ...(deps.toursRepo !== undefined && { toursRepo: deps.toursRepo }),
      ...(deps.tourRemindersRepo !== undefined && { tourRemindersRepo: deps.tourRemindersRepo }),
      ...(deps.toursNow !== undefined && { now: deps.toursNow }),
      // Relay provisioning deps (Task 5 — POST /api/tours/:tourId/relay).
      conversationsRepo: conversations,
      auditRepo: audit,
      ...(deps.poolNumbersService !== undefined && { poolNumbersService: deps.poolNumbersService }),
      // Relay auto-membership: resolve [tenant, unit's landlord] from contacts + units.
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      ...(deps.unitsRepo !== undefined && { unitsRepo: deps.unitsRepo }),
      // tour_took_place milestone on the toured transition (Post-Tour & Application).
      activityEventsRepo: activityEvents,
      events,
    }),
  );
  // Tour reminders read endpoint (scheduled-message-visibility). Mounted at
  // /tours too — its only path is GET /:tourId/reminders, a DISTINCT segment
  // from the tours router's routes above (GET /:tourId matches a single
  // segment, never /:tourId/reminders), so the two never collide.
  router.use(
    '/tours',
    createTourRemindersRouter({
      config,
      logger: deps.logger,
      ...(deps.toursRepo !== undefined && { toursRepo: deps.toursRepo }),
      ...(deps.tourRemindersRepo !== undefined && { tourRemindersRepo: deps.tourRemindersRepo }),
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      conversationsRepo: conversations,
      // PATCH cancel/restore emits scheduled.updated on this bus.
      events,
    }),
  );
  // Relay groups (M1.7; requireAuth — VAs run relay threads, no admin gate).
  // Mounted at '/' so it owns /relay-groups AND the relay sub-routes on
  // /conversations/:id (/members, /close). The relay router's
  // /conversations/:id/* paths are DISTINCT segments from the 1:1 thread
  // routes below, so there is no collision; relay routes are matched first.
  router.use(
    '/',
    createRelayGroupsRouter({
      config,
      logger: deps.logger,
      conversationsRepo: conversations,
      ...(deps.contactsRepoForRelay !== undefined && { contactsRepo: deps.contactsRepoForRelay }),
      ...(deps.contactsRepo !== undefined &&
        deps.contactsRepoForRelay === undefined && { contactsRepo: deps.contactsRepo }),
      auditRepo: audit,
      // Close sends the relay.group_closed final message via sendRelayAnnouncement
      // (persist + per-member legs FROM the pool number) BEFORE the status flip.
      messagesRepo: messages,
      adapter,
      ...(deps.settingsRepo !== undefined && { settingsRepo: deps.settingsRepo }),
      // BE2: emit added_to_group_text / removed_from_group_text on membership.
      activityEventsRepo: activityEvents,
      ...(deps.poolNumbersService !== undefined && { poolNumbersService: deps.poolNumbersService }),
      // The group thread's "Upcoming" bucket (GET /conversations/:id/scheduled)
      // resolves the owner tour + its pending reminder rungs.
      ...(deps.toursRepo !== undefined && { toursRepo: deps.toursRepo }),
      ...(deps.tourRemindersRepo !== undefined && { tourRemindersRepo: deps.tourRemindersRepo }),
      events,
    }),
  );
  // Share-broadcasts (M1.8a; requireAuth — VAs run share broadcasts, no admin
  // gate). Mounted at '/' so it owns /broadcasts + the /broadcasts/:id sub-paths.
  router.use(
    '/',
    createBroadcastsRouter({
      config,
      logger: deps.logger,
      ...(deps.broadcastsRepo !== undefined && { broadcastsRepo: deps.broadcastsRepo }),
      ...(deps.unitsRepo !== undefined && { unitsRepo: deps.unitsRepo }),
      // Send-by-explicit-selection re-fences each contactId (opt-out/unreachable
      // /type) — inject the same contactsRepo tests use; default kicks in here.
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      ...(deps.audienceResolutionService !== undefined && {
        audienceResolutionService: deps.audienceResolutionService,
      }),
      auditRepo: audit,
      events,
    }),
  );
  // Placements + boards (M1.10; requireAuth — VAs run the boards, no admin gate).
  // Gets the relay-provisioning deps too (M1.10c: POST /placements/:id/relay derives
  // the roster from the placement + reuses the shared provisioning primitive).
  router.use(
    '/placements',
    createPlacementsRouter({
      config,
      logger: deps.logger,
      ...(deps.placementsRepo !== undefined && { placementsRepo: deps.placementsRepo }),
      placementDeadlinesRepo: placementDeadlines,
      conversationsRepo: conversations,
      ...(deps.unitsRepo !== undefined && { unitsRepo: deps.unitsRepo }),
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      ...(deps.poolNumbersService !== undefined && { poolNumbersService: deps.poolNumbersService }),
      // Post-Tour conversion (POST /placements/from-tour): read/finalize the
      // source tour + cancel its pending reminder rows on convert.
      ...(deps.toursRepo !== undefined && { toursRepo: deps.toursRepo }),
      ...(deps.tourRemindersRepo !== undefined && { tourRemindersRepo: deps.tourRemindersRepo }),
      auditRepo: audit,
      // BE2: emit placement_opened/placement_closed/stage_changed/tour_* milestones.
      activityEventsRepo: activityEvents,
      events,
    }),
  );
  // Placement nudges read + cancel/restore (placement-detail-hub). Mounted at
  // /placements too — its only paths are /:placementId/nudges*, DISTINCT segments
  // from the placements CRUD router's /:placementId routes above (a single-
  // segment match never captures /:placementId/nudges), so the two never
  // collide. Shares the process placements/units repos + nudge repo + bus.
  router.use(
    '/placements',
    createPlacementNudgesRouter({
      logger: deps.logger,
      ...(deps.placementsRepo !== undefined && { placementsRepo: deps.placementsRepo }),
      placementNudgesRepo: placementNudges,
      ...(deps.unitsRepo !== undefined && { unitsRepo: deps.unitsRepo }),
      // PATCH cancel/restore emits scheduled.updated on this bus.
      events,
    }),
  );
  // Status-model transitions (requireAuth via the /api mount). Mounted at '/' so
  // it owns the distinct sub-paths /placements/:id/transition, /placements/:id/history,
  // /contacts/:id/tenant-status, /units/:id/listing-status — all distinct
  // segments from the placements/contacts/units CRUD routers above, so no collision.
  // EVERY status/stage write routes through the ONE transition service here.
  router.use(
    '/',
    createStatusTransitionRouter({
      logger: deps.logger,
      ...(deps.placementsRepo !== undefined && { placementsRepo: deps.placementsRepo }),
      placementDeadlinesRepo: placementDeadlines,
      ...(deps.unitsRepo !== undefined && { unitsRepo: deps.unitsRepo }),
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      auditRepo: audit,
      activityEventsRepo: activityEvents,
      events,
      // Post-Tour & Application (Task 5): arm the stage nudge ladder from the ONE
      // transition choke point. (The lost-move relay-close hook was removed -
      // relay-number-lifecycle spec 4.1: nothing auto-closes a relay group.)
      armStageNudge: (placement, toStage, nowIso) =>
        armNudgeForStage(placement, toStage, nowIso, {
          placementNudgesRepo: placementNudges,
          // Task 6: best-effort scheduled.updated so the timeline's "Upcoming"
          // section refetches live when a nudge is armed/canceled on a stage move.
          events,
          ...(deps.logger !== undefined && { logger: deps.logger }),
        }),
    }),
  );
  // conversation-fact-extraction (T8) review API (requireAuth via the /api mount).
  // Its paths (/contacts/:id/suggestions[...]) are distinct segments from every
  // router above, so no collision. Accept 'status' routes through the SAME ONE
  // transition service construction the status-transition router uses.
  router.use(
    '/',
    createSuggestionsRouter({
      logger: deps.logger,
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      extractionRepo: extraction,
      auditRepo: audit,
      activityEventsRepo: activityEvents,
      events,
      ...(deps.placementsRepo !== undefined && { placementsRepo: deps.placementsRepo }),
      placementDeadlinesRepo: placementDeadlines,
      ...(deps.unitsRepo !== undefined && { unitsRepo: deps.unitsRepo }),
    }),
  );
  // BE6/C7 Today action-queue (requireAuth via the /api mount). A read-only
  // aggregation over placements/conversations/contacts — its only path is GET /
  // (i.e. GET /api/today), a distinct segment from every router above. Shares the
  // process conversations repo; placements/contacts default to the real repos
  // unless injected (tests pass the world fakes).
  router.use(
    '/today',
    createTodayRouter({
      logger: deps.logger,
      conversationsRepo: conversations,
      ...(deps.placementsRepo !== undefined && { placementsRepo: deps.placementsRepo }),
      placementDeadlinesRepo: placementDeadlines,
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      ...(deps.toursRepo !== undefined && { toursRepo: deps.toursRepo }),
      // conversation-fact-extraction (T9): the ai_suggestions group reads pending
      // suggestions from the SAME store the review API + PATCH clear-hook share.
      extractionRepo: extraction,
    }),
  );
  // C8/BE7 Inbox feed (requireAuth via the /api mount). A read-only,
  // contact-aggregated lens over conversations/contacts/messages/placements -
  // its only path is GET / (GET /api/inbox), a distinct segment from every
  // router above. Shares the process conversations + messages repos; placements/
  // contacts default to the real repos unless injected (tests pass the
  // world fakes).
  router.use(
    '/inbox',
    createInboxRouter({
      logger: deps.logger,
      conversationsRepo: conversations,
      messagesRepo: messages,
      events,
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      ...(deps.placementsRepo !== undefined && { placementsRepo: deps.placementsRepo }),
    }),
  );
  // Unmatched-email triage (email-channel B3; requireAuth via the /api mount -
  // VAs triage the side-door, no admin gate). List/detail + read/link/create-
  // contact/spam/release/dismiss; every mutation emits unmatched_email.updated
  // on this bus. The link flows re-ingest the stored raw mail through the REAL
  // ingestion service (default-constructed inside the router over the shared
  // repos below; 503 when INBOUND_MAIL_BUCKET is unset).
  router.use(
    '/unmatched-email',
    createUnmatchedEmailRouter({
      config,
      logger: deps.logger,
      ...(deps.unmatchedEmailRepo !== undefined && {
        unmatchedEmailRepo: deps.unmatchedEmailRepo,
      }),
      contactsRepo: contacts,
      auditRepo: audit,
      conversationsRepo: conversations,
      messagesRepo: messages,
      extractionRepo: extraction,
      ...(mediaStore !== undefined && { mediaStore }),
      events,
    }),
  );

  // Outbound MMS presign TTL (design Sec 4): 1 hour. A generous margin over
  // Twilio's fetch-at-processing window, still short-lived exposure. Presigned
  // per attempt (send / each relay leg / retry) and NEVER persisted as truth.
  const PRESIGN_TTL_SECONDS = 3600;

  // POST /api/conversations/:conversationId/messages  { body?, mediaUrls?, attachmentKeys? }
  // A manual human send (automated sends come from jobs, not this route).
  //
  // FIX 2: a relay_group thread is NOT a 1:1 send — the 1:1 wrapper would text
  // participant_phone (the pool number). The team-send branch below persists
  // ONE outbound message and fans it out to ALL members FROM the pool number
  // via relay.fanOut, returning the same outcome shape as the 1:1 path.
  //
  // Per-user spend fence (2026-07-02 hardening): every request here is a real
  // SMS, so the send POST — and ONLY the send POST (not reads, not mark-read,
  // not retry) — sits behind a sliding-window per-user limiter. ONE instance,
  // created with the router (per-request creation would reset the window).
  const manualSendLimiter = createUserRateLimit({
    routeKey: 'manual_send',
    max: config.rateLimitManualSendPerMin,
    windowMs: 60_000,
    logger: log,
  });
  router.post('/conversations/:conversationId/messages', manualSendLimiter, async (req, res) => {
    // NOTE: with a middleware ahead of the handler, Express's typings no longer
    // narrow req.params from the path literal — coerce like voiceApi.ts does.
    const conversationId = String(req.params['conversationId'] ?? '');
    mergeContext({ conversationId });
    const payload = (req.body ?? {}) as {
      body?: unknown;
      mediaUrls?: unknown;
      attachmentKeys?: unknown;
      attachmentOriginalKeys?: unknown;
    };

    const body = typeof payload.body === 'string' && payload.body.length > 0 ? payload.body : undefined;
    // Legacy raw mediaUrls: the INTERNAL/e2e seam (the dashboard never uses it).
    // Kept so raw provider-URL sends and the retry-raw fallback still work.
    const mediaUrls =
      Array.isArray(payload.mediaUrls) &&
      payload.mediaUrls.length > 0 &&
      payload.mediaUrls.every((u): u is string => typeof u === 'string')
        ? payload.mediaUrls
        : undefined;
    // Outbound MMS (design Sec 4): the dashboard uploads via presign/confirm
    // then sends the returned rendition keys here. Reject a non-string-array
    // outright. `attachmentOriginalKeys` (optional, index-aligned) carries the
    // pristine originals confirm returned (RCS-forward, spec Sec 5).
    const attachmentKeys =
      Array.isArray(payload.attachmentKeys) &&
      payload.attachmentKeys.length > 0 &&
      payload.attachmentKeys.every((k): k is string => typeof k === 'string')
        ? payload.attachmentKeys
        : undefined;
    const attachmentOriginalKeys =
      Array.isArray(payload.attachmentOriginalKeys) &&
      payload.attachmentOriginalKeys.length > 0 &&
      payload.attachmentOriginalKeys.every((k): k is string => typeof k === 'string')
        ? payload.attachmentOriginalKeys
        : undefined;
    if (body === undefined && mediaUrls === undefined && attachmentKeys === undefined) {
      res.status(400).json({ error: 'body, attachmentKeys, or mediaUrls is required' });
      return;
    }

    // Validate + resolve uploaded attachments to durable MediaAttachment records
    // (HeadObject each, deliverable-type guard, total-size cap). Presign happens
    // per attempt below (1:1 now; relay per leg in the fan-out).
    let attachments: MediaAttachment[] | undefined;
    if (attachmentKeys !== undefined) {
      const resolved = await resolveAttachmentKeys(attachmentKeys, attachmentOriginalKeys, mediaStore);
      if (!resolved.ok) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }
      attachments = resolved.attachments;
    }

    // Relay branch: fetch the conversation to decide. A miss falls through to
    // the 1:1 path (sendMessage throws ConversationNotFoundError → 404), so the
    // existing behavior for unknown ids is unchanged. Relay carries the DURABLE
    // attachments onto the hub message; the fan-out re-presigns per leg (never
    // the presigned URLs here - they would expire before a long roster/retry).
    const conversation = await conversations.getById(conversationId);
    if (conversation?.type === 'relay_group') {
      await sendRelayTeamMessage(req, res, conversation, body, mediaUrls, attachments);
      return;
    }

    // 1:1: presign each durable key FRESH (per-attempt rule) into the adapter
    // mediaUrls; merge any legacy raw mediaUrls behind them. Presigned URLs are
    // bearer tokens - never logged here (s3Key/count only).
    let outboundMediaUrls = mediaUrls;
    if (attachments !== undefined && mediaStore) {
      const presigned = await Promise.all(
        attachments.map((a) => mediaStore.presign(renditionFor('mms', a).s3Key, PRESIGN_TTL_SECONDS)),
      );
      outboundMediaUrls = [...presigned, ...(mediaUrls ?? [])];
      log.info(
        { conversationId, attachmentCount: attachments.length, s3Keys: attachments.map((a) => a.s3Key) },
        'outbound send: presigned attachments',
      );
    }

    try {
      const outcome = await sendMessage({
        conversationId,
        ...(body !== undefined && { body }),
        ...(outboundMediaUrls !== undefined && { mediaUrls: outboundMediaUrls }),
        ...(attachments !== undefined && { attachments }),
        automated: false,
      });
      res.status(201).json(outcome);
    } catch (err) {
      if (err instanceof SendRefusedError) {
        res.status(REFUSAL_STATUS[err.code]).json({ error: err.code });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler.
    }
  });

  // POST /api/conversations/:conversationId/email  { to, cc?, subject, body, attachmentKeys? }
  // Email-channel v1 (A5): compose + send an email in the thread. The recipient
  // contact is resolved by the To address (the service re-validates it is one of
  // that contact's emails). 202 { message } on success; typed refusals map via
  // EMAIL_REFUSAL_STATUS (ADJ-6: email_sending_disabled is 409, NOT 503). Shares
  // the manual-send per-user fence (an email is a real send).
  router.post('/conversations/:conversationId/email', manualSendLimiter, async (req, res) => {
    const conversationId = String(req.params['conversationId'] ?? '');
    mergeContext({ conversationId });
    const user = (req as AuthedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const payload = (req.body ?? {}) as {
      to?: unknown;
      cc?: unknown;
      subject?: unknown;
      body?: unknown;
      attachments?: unknown;
      attachmentKeys?: unknown;
    };
    const to = typeof payload.to === 'string' ? payload.to : '';
    const subject = typeof payload.subject === 'string' ? payload.subject : '';
    const body = typeof payload.body === 'string' ? payload.body : '';
    if (to.trim() === '' || subject.trim() === '' || body.trim() === '') {
      res.status(400).json({ error: 'to, subject, and body are required' });
      return;
    }
    const cc =
      Array.isArray(payload.cc) && payload.cc.every((c): c is string => typeof c === 'string')
        ? payload.cc
        : undefined;
    // Attachments: prefer the {key, filename?} shape (carries the original filename
    // to the MIME part + timeline gallery); accept the legacy attachmentKeys
    // string[] for back-compat. Both normalize to a single `attachments` list.
    const attachments = ((): { key: string; filename?: string }[] | undefined => {
      if (Array.isArray(payload.attachments)) {
        const mapped = payload.attachments
          .filter(
            (a): a is { key: string; filename?: unknown } =>
              typeof a === 'object' && a !== null && typeof (a as { key?: unknown }).key === 'string',
          )
          .map((a) => ({ key: a.key, ...(typeof a.filename === 'string' && { filename: a.filename }) }));
        return mapped.length > 0 ? mapped : undefined;
      }
      if (
        Array.isArray(payload.attachmentKeys) &&
        payload.attachmentKeys.length > 0 &&
        payload.attachmentKeys.every((k): k is string => typeof k === 'string')
      ) {
        return payload.attachmentKeys.map((key) => ({ key }));
      }
      return undefined;
    })();

    // Resolve the recipient contact by address (the service re-validates on-file).
    const contact = await contacts.findByEmail(normalizeEmailAddress(to));
    // Sender display name: the session user has no `name` field, so the From
    // line ("<name> at Housing Choice") must come from the users table; fall
    // back to the session identity (email) if the lookup fails or is empty.
    const senderRecord = await usersForEmail.findById(user.userId).catch(() => undefined);

    try {
      const outcome = await sendEmail({
        conversationId,
        contactId: contact?.contactId ?? '',
        to,
        ...(cc !== undefined && { cc }),
        subject,
        body,
        ...(attachments !== undefined && { attachments }),
        sentByUserId: user.userId,
        sentByName: displayNameOf(senderRecord ?? user),
      });
      res.status(202).json({ message: outcome });
    } catch (err) {
      if (err instanceof EmailSendRefusedError) {
        res.status(EMAIL_REFUSAL_STATUS[err.code]).json({ error: err.code });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler.
    }
  });

  // POST /api/conversations/:conversationId/messages/:providerSid/retry
  // Re-send a FAILED outbound message (the dashboard Retry button). The server
  // re-reads the original by its provider SID (so the body AND media resend
  // correctly — the client never holds provider media URLs) and stamps the new
  // message with `retry_of` so the contact timeline collapses the stale failed
  // bubble. A manual human send: automated:false (never breaker-metered) — so it
  // escapes the per-conversation breaker. It fires a real SMS, and because a
  // successful retry mints a NEW SID and never clears the original's `failed`
  // status, the same failed SID stays retryable indefinitely. Front it with the
  // SAME `manualSendLimiter` instance as the send route so retries + sends share
  // the ONE per-user manual-send budget (30/min) — a stuck Retry loop can't
  // machine-gun texts (spec §1), and no client gets 30 sends + 30 retries.
  router.post('/conversations/:conversationId/messages/:providerSid/retry', manualSendLimiter, async (req, res) => {
    // Middleware ahead of the handler defeats Express's path-literal param typing —
    // coerce (matches the send route above).
    const conversationId = String(req.params['conversationId'] ?? '');
    const providerSid = String(req.params['providerSid'] ?? '');
    mergeContext({ conversationId });

    const original = await messages.getByProviderSid(providerSid);
    if (!original || original.conversationId !== conversationId) {
      res.status(404).json({ error: 'message_not_found' });
      return;
    }
    if (original.direction !== 'outbound') {
      res.status(400).json({ error: 'not_outbound' });
      return;
    }
    // Email is NOT retryable through this route (email-channel v1): it re-sends via
    // the SMS sendMessage path, which would text the email body to participant_phone.
    // A failed email carries provider_sid = hc-<uuid>@<domain>, direction outbound,
    // delivery_status failed - so it would otherwise pass every check below. Refuse
    // it up front (re-compose to resend an email; there is no email-retry route yet).
    if (original.type === 'email') {
      res.status(409).json({ error: 'not_retryable' });
      return;
    }
    // Only a FAILED/UNDELIVERED send is retryable — refuse re-sending a message
    // that already went out (idempotency: no accidental double-text on a delivered
    // or in-flight message).
    if (original.delivery_status !== 'failed' && original.delivery_status !== 'undelivered') {
      res.status(409).json({ error: 'not_failed' });
      return;
    }

    // PRESIGN PER ATTEMPT (design Sec 5 - the Cameron rule): a retry is a NEW
    // provider create + fetch. Presigned URLs are short-lived bearer tokens, so
    // replaying the original's stored mediaUrls verbatim would hand Twilio an
    // EXPIRED token 24h later. When the original carries media_attachments (the
    // durable s3Keys), re-presign each FRESH and send those (the new message
    // persists these fresh URLs + media_attachments via sendMessage). Only a
    // message with NO media_attachments (the raw e2e/internal seam) falls back
    // to replaying its raw mediaUrls.
    const originalAttachments = mediaAttachmentsOf(original);
    let retryMediaUrls: string[] | undefined;
    let retryAttachments: MediaAttachment[] | undefined;
    if (originalAttachments.length > 0) {
      if (mediaStore) {
        retryMediaUrls = await Promise.all(
          originalAttachments.map((a) => mediaStore.presign(a.s3Key, PRESIGN_TTL_SECONDS)),
        );
        retryAttachments = originalAttachments;
        log.info(
          {
            conversationId,
            providerSid,
            attachmentCount: originalAttachments.length,
            s3Keys: originalAttachments.map((a) => a.s3Key),
          },
          'retry: re-presigned attachments fresh (never replaying stored URLs)',
        );
      } else {
        // Degenerate no-MEDIA_BUCKET config: NEVER replay the stored presigned
        // URLs (an expired bearer token). Retry the text only rather than ship an
        // expired token. Log IDs/keys/count, never a URL.
        log.warn(
          {
            conversationId,
            providerSid,
            attachmentCount: originalAttachments.length,
            s3Keys: originalAttachments.map((a) => a.s3Key),
          },
          'retry: attachments present but no MediaStore - retrying body only, media dropped (never replay stale URLs)',
        );
      }
    } else if (original.mediaUrls !== undefined) {
      retryMediaUrls = original.mediaUrls;
    }

    try {
      const outcome = await sendMessage({
        conversationId,
        ...(original.body !== undefined && { body: original.body }),
        ...(retryMediaUrls !== undefined && { mediaUrls: retryMediaUrls }),
        ...(retryAttachments !== undefined && { attachments: retryAttachments }),
        automated: false,
        // Carry the original author through (a retried AI message stays 'ai').
        author: original.author === 'ai' ? 'ai' : 'teammate',
        // Lineage: the new message supersedes the failed one in the timeline.
        retryOf: original.tsMsgId,
      });
      res.status(201).json(outcome);
    } catch (err) {
      if (err instanceof SendRefusedError) {
        res.status(REFUSAL_STATUS[err.code]).json({ error: err.code });
        return;
      }
      throw err;
    }
  });

  /**
   * FIX 2 — team send into a relay group. Persists the outbound message ONCE on
   * the relay thread (author 'teammate'), seeds delivery_recipients to 'queued'
   * for ALL current members, then enqueues relay.fanOut to send to every member
   * FROM the pool number (no member is the sender → none is excluded; the
   * per-recipient prefix is the neutral team label, never a phone). Returns the
   * same { conversationId, providerSid, tsMsgId, status } shape as the 1:1 send.
   */
  async function sendRelayTeamMessage(
    req: import('express').Request,
    res: import('express').Response,
    conversation: ConversationItem,
    bodyText: string | undefined,
    mediaUrlList: string[] | undefined,
    attachments: MediaAttachment[] | undefined,
  ): Promise<void> {
    const conversationId = conversation.conversationId;
    if (conversation.status !== 'open') {
      res.status(409).json({ error: 'relay_closed' });
      return;
    }
    const poolNumber = conversation.pool_number;
    if (typeof poolNumber !== 'string' || poolNumber.length === 0) {
      // An open relay always carries a pool number; missing one is an anomaly.
      log.error({ conversationId }, 'relay team send: open relay has no pool number — refusing');
      res.status(409).json({ error: 'relay_closed' });
      return;
    }

    // Seed every current member's delivery slot to 'queued' (member key =
    // contactId else phone#<E164>, the shared convention) directly on the
    // SOURCE message at append time. The fan-out's setRecipientDelivery is a
    // CHILD-ONLY SET (DynamoDB forbids seeding a map and a child in one
    // expression), so the parent delivery_recipients map must exist before the
    // first per-recipient write — appending it whole here guarantees that.
    const roster = conversation.participants ?? [];
    const deliveryRecipients: Record<string, RelayRecipientDelivery> = {};
    for (const member of roster) {
      deliveryRecipients[relayMemberKey(member)] = { status: 'queued' };
    }

    // Persist the source message ONCE (the relayed message is stored once;
    // fan-out only updates delivery_recipients). No provider send happens here —
    // the per-recipient sends are the fan-out's job — so the SID/ts are
    // synthesized for the source item's key. A team message has no member
    // sender, so relay_sender_key is the TEAM sentinel.
    const providerTs = new Date().toISOString();
    const providerSid = `team-${randomUUID()}`;
    const appended = await messages.append({
      conversationId,
      providerSid,
      providerTs,
      type:
        (mediaUrlList !== undefined && mediaUrlList.length > 0) ||
        (attachments !== undefined && attachments.length > 0)
          ? 'mms'
          : 'sms',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'queued',
      relaySenderKey: TEAM_SENDER_KEY,
      deliveryRecipients,
      ...(bodyText !== undefined && { body: bodyText }),
      ...(mediaUrlList !== undefined && { mediaUrls: mediaUrlList }),
      // Persist the DURABLE attachment keys on the hub message so relay.fanOut
      // can re-presign PER LEG (design Sec 7) - the presigned URLs are never
      // stored here (they would expire before a paced fan-out / retry).
      ...(attachments !== undefined && attachments.length > 0 && { mediaAttachments: attachments }),
    });

    // Fan out to ALL members FROM the pool number. TEAM_SENDER_KEY matches no
    // member, so none is excluded; the neutral team label is the prefix.
    try {
      await enqueueImmediate(RELAY_FANOUT_JOB, {
        relayConversationId: conversationId,
        sourceTsMsgId: appended.tsMsgId,
        senderKey: TEAM_SENDER_KEY,
        senderNameOverride: TEAM_SENDER_LABEL,
      });
    } catch (err) {
      log.error({ err, conversationId }, 'relay team send: fan-out enqueue failed — message persisted, not relayed');
    }

    // Inbox touch + audit + SSE — mirror the 1:1 send's tail (FIX 5: attribute
    // the audit to the acting user).
    let touched: ConversationItem | undefined;
    try {
      touched = await conversations.touchLastActivity(conversationId, bodyText, providerTs);
    } catch (err) {
      log.error({ err, conversationId }, 'relay team send: touchLastActivity failed — inbox stale');
    }
    await audit.append(`conversations#${conversationId}`, 'message_sent', {
      actor: (req as AuthedRequest).user?.userId,
      author: 'teammate',
      relay: true,
      memberCount: roster.length,
    });

    events.emit('message.persisted', {
      conversationId,
      tsMsgId: appended.tsMsgId,
      direction: 'outbound',
      deliveryStatus: 'queued',
    });
    if (touched) events.emit('conversation.updated', toConversationUpdatedEvent(touched));

    log.info(
      { conversationId, memberCount: roster.length, actor: (req as AuthedRequest).user?.userId },
      'relay team message persisted + fanned out',
    );
    res.status(201).json({
      conversationId,
      providerSid,
      tsMsgId: appended.tsMsgId,
      status: 'queued',
    });
  }

  // GET /api/conversations?status=open&limit=50&cursor=...
  // THE inbox (M1.2): ONE DynamoDB Query on the byLastActivity GSI,
  // descending by last_activity_at — never a Scan (listByLastActivity).
  router.get('/conversations', async (req, res) => {
    const rawStatus = req.query['status'];
    const status =
      typeof rawStatus === 'string' && rawStatus.length > 0 ? rawStatus : 'open';
    if (!CONVERSATION_STATUSES.has(status)) {
      res.status(400).json({
        error: `status must be one of: ${[...CONVERSATION_STATUSES].join(', ')}`,
      });
      return;
    }

    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }

    let exclusiveStartKey: Record<string, unknown> | undefined;
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined) {
      exclusiveStartKey = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : undefined;
      if (exclusiveStartKey === undefined) {
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
    }

    const page = await conversations.listByLastActivity({
      status,
      limit,
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
    });
    res.json({
      conversations: page.items.map(toConversationSummary),
      nextCursor:
        page.lastEvaluatedKey !== undefined ? encodeCursor(page.lastEvaluatedKey) : null,
    });
  });

  // GET /api/conversations/:conversationId — one thread header.
  router.get('/conversations/:conversationId', async (req, res) => {
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    const conversation = await conversations.getById(conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'conversation_not_found' });
      return;
    }
    res.json({ conversation });
  });

  // GET /api/conversations/:conversationId/messages?limit=50&before=...
  // Newest-first page of the timeline; ?before= pages backwards (exclusive
  // tsMsgId bound, from the oldest item the client has).
  router.get('/conversations/:conversationId/messages', async (req, res) => {
    const { conversationId } = req.params;
    mergeContext({ conversationId });

    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }
    const rawBefore = req.query['before'];
    const before = typeof rawBefore === 'string' && rawBefore.length > 0 ? rawBefore : undefined;

    const page = await messages.listByConversation(conversationId, {
      limit,
      ...(before !== undefined && { before }),
    });
    res.json({ messages: page });
  });

  // GET /api/calls/:callId — resolve a call (M1.9a). `callId` is the Twilio
  // CallSid (== the call message's provider_sid); getByProviderSid resolves it
  // via the SID pointer, exactly like the status-callback path. Returns
  // { call, conversation } so the dashboard /quick-reply/:callId seam can map a
  // callId → its conversation (and render the masked call entry). PII (doc §9):
  // the call carries call_party_label (a role/name) — never a raw counterpart
  // phone beyond what the conversation already exposes; logs stay IDs-only.
  router.get('/calls/:callId', async (req, res) => {
    const { callId } = req.params;
    const call = await messages.getByProviderSid(callId);
    if (!call || call.type !== 'call') {
      res.status(404).json({ error: 'call_not_found' });
      return;
    }
    mergeContext({ conversationId: call.conversationId });
    const conversation = await conversations.getById(call.conversationId);
    if (!conversation) {
      // The call entry points at a conversation that no longer exists — surface
      // the call alone rather than a hard 404 (the timeline item is still real).
      log.warn({ callSid: callId }, 'GET /api/calls: call found but its conversation is missing');
      res.json({ call, conversation: null });
      return;
    }
    res.json({ call, conversation });
  });

  // GET /api/calls/:callId/recording — stream the founder-bridge recording back
  // to the dashboard for playback (M1.9c). AUTH-ONLY (this router sits behind
  // requireAuth + session) — recordings are PII (doc §9) and NEVER public.
  // Resolve the call by CallSid (== provider_sid); if it carries a
  // recording_s3_key, STREAM the S3 object through (streams-only, no whole-body
  // buffering) so the audio never transits a public/presigned URL — the bytes
  // stay behind the session gate. 404 when the call/recording does not exist (or
  // MEDIA_BUCKET is unconfigured). PII: no recording content in any log line.
  router.get('/calls/:callId/recording', async (req, res) => {
    const { callId } = req.params;
    const call = await messages.getByProviderSid(callId);
    if (!call || call.type !== 'call') {
      res.status(404).json({ error: 'call_not_found' });
      return;
    }
    mergeContext({ conversationId: call.conversationId });
    const key = call.recording_s3_key;
    if (typeof key !== 'string' || key.length === 0) {
      res.status(404).json({ error: 'recording_not_found' });
      return;
    }
    if (!mediaStore) {
      // No store configured (MEDIA_BUCKET unset) — the key cannot be served.
      log.warn({ callSid: callId }, 'recording requested but no media store configured');
      res.status(404).json({ error: 'recording_not_found' });
      return;
    }
    const object = await mediaStore.getStream(key);
    if (!object) {
      // The key is recorded on the call but the object is gone (lifecycle/
      // deletion) — 404 rather than a hanging stream.
      log.warn({ callSid: callId }, 'recording key present but object not found in the media store');
      res.status(404).json({ error: 'recording_not_found' });
      return;
    }
    res.setHeader('Content-Type', object.contentType ?? 'audio/mpeg');
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', String(object.contentLength));
    }
    // nosniff is already set app-wide; the recording is audio, never executable.
    log.info({ callSid: callId }, 'streaming founder-bridge recording to the dashboard');
    object.body.on('error', (err) => {
      log.error({ err, callSid: callId }, 'recording stream errored mid-flight');
      res.destroy(err);
    });
    object.body.pipe(res);
  });

  // GET /api/messages/:providerSid/media/:idx — stream a mirrored inbound MMS
  // attachment back to the dashboard for inline <img> display. AUTH-ONLY (this
  // router is behind requireAuth) — MMS media is PII (IDs, personal photos/docs),
  // so it is NEVER public/presigned; the bytes stay behind the session gate, the
  // same posture as the call-recording endpoint above. The S3 key is read from
  // the message's STORED media_attachments[idx].s3Key (never client input → no
  // path traversal); :idx only selects which attachment. 404 for a missing
  // message / out-of-range idx / unmirrored media (MEDIA_BUCKET unset) / absent.
  router.get('/messages/:providerSid/media/:idx', async (req, res) => {
    const { providerSid } = req.params;
    const idx = Number(req.params['idx']);
    if (!Number.isInteger(idx) || idx < 0) {
      res.status(400).json({ error: 'invalid_media_index' });
      return;
    }
    const message = await messages.getByProviderSid(providerSid);
    if (!message) {
      res.status(404).json({ error: 'message_not_found' });
      return;
    }
    mergeContext({ conversationId: message.conversationId });
    // Prefer the cohesive media_attachments record; fall back to legacy
    // media_s3_keys (octet-stream → served as a download) for pre-migration data.
    const attachments = mediaAttachmentsOf(message);
    const key = attachments[idx]?.s3Key;
    if (typeof key !== 'string' || key.length === 0) {
      res.status(404).json({ error: 'media_not_found' });
      return;
    }
    if (!mediaStore) {
      log.warn({ providerSid }, 'media requested but no media store configured');
      res.status(404).json({ error: 'media_not_found' });
      return;
    }
    const object = await mediaStore.getStream(key);
    if (!object) {
      log.warn({ providerSid, mediaIndex: idx }, 'media key present but object not found in the store');
      res.status(404).json({ error: 'media_not_found' });
      return;
    }
    // XSS HARDENING (the stored Content-Type is the MMS sender's, attacker-
    // controlled): serve INLINE only for allowlisted raster images; anything
    // else (text/html, image/svg+xml, application/*, absent) is forced to an
    // octet-stream ATTACHMENT so the browser downloads rather than renders it —
    // a malicious type/body can't run script same-origin when the attachment
    // link is opened top-level. Belt-and-braces: a restrictive CSP (no script,
    // sandboxed) + nosniff on THIS response neuter execution even if a renderer
    // is reached. nosniff also stops the browser sniffing octet-stream → html.
    const stored = object.contentType;
    const inline = isInlineMediaType(stored);
    res.setHeader('Content-Type', inline ? stored! : 'application/octet-stream');
    if (!inline) {
      res.setHeader('Content-Disposition', `attachment; filename="attachment-${idx}"`);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', String(object.contentLength));
    }
    // Immutable per (MessageSid, idx); private so only this session's browser caches it.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    log.info({ providerSid, mediaIndex: idx, inline }, 'streaming inbound MMS media to the dashboard');
    object.body.on('error', (err) => {
      log.error({ err, providerSid, mediaIndex: idx }, 'media stream errored mid-flight');
      res.destroy(err);
    });
    object.body.pipe(res);
  });

  // POST /api/conversations/:conversationId/read — zero the unread counter
  // (the operator opened the thread). Returns the updated conversation.
  router.post('/conversations/:conversationId/read', async (req, res) => {
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    try {
      const conversation = await conversations.resetUnread(conversationId);
      // SSE (M1.2): other connected dashboards drop their unread badge for
      // this thread live (same event shape as every inbox-row change).
      events.emit('conversation.updated', toConversationUpdatedEvent(conversation));
      res.json({ conversation });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      throw err;
    }
  });

  // GET /api/events — the live-update SSE stream (M1.2).
  //
  // SINGLE-INSTANCE ASSUMPTION: this stream is fed by the in-process bus in
  // lib/events.ts — valid because the one app process serves both the
  // mutation paths and this stream. The DynamoDB-streams upgrade path lives
  // there if that ever changes.
  //
  // Streaming safety: the locked middleware chain (app.ts) has NO
  // compression or response-buffering middleware — correlation → request
  // logger → origin secret → body parsers all pass the response through
  // untouched, so res.write() flushes straight to the socket. The headers
  // below keep CloudFront (and any future proxy) from buffering or
  // transforming the stream; a periodic 'heartbeat' event keeps it from
  // idling out AND lets the client observe liveness (see the heartbeat
  // interval below for why it is a named event, not an SSE comment).
  //
  // Connection cap (SSE_MAX_CONNECTIONS, default 50): each stream holds a
  // socket + heartbeat timer + bus listener pair forever — unbounded
  // accepts would let one misbehaving client exhaust the single t4g.small.
  // Beyond the cap → 503 (clients retry/poll); a close frees its slot.
  let sseConnections = 0;
  router.get('/events', (req, res) => {
    if (sseConnections >= config.sseMaxConnections) {
      log.warn(
        { sseConnections, sseMaxConnections: config.sseMaxConnections },
        'sse connection cap reached — rejecting new stream with 503',
      );
      res.status(503).json({ error: 'too many event streams' });
      return;
    }
    sseConnections += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Immediate comment frame: confirms the stream to the client and pushes
    // the headers through any intermediary right away.
    res.write(': connected\n\n');

    const writeEvent = (event: string, payload: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const onConversationUpdated = (payload: ConversationUpdatedEvent): void => {
      writeEvent('conversation.updated', payload);
    };
    const onMessagePersisted = (payload: MessagePersistedEvent): void => {
      writeEvent('message.persisted', payload);
    };
    const onBroadcastUpdated = (payload: BroadcastUpdatedEvent): void => {
      writeEvent('broadcast.updated', payload);
    };
    const onPlacementUpdated = (payload: PlacementUpdatedEvent): void => {
      writeEvent('placement.updated', payload);
    };
    const onScheduledUpdated = (payload: ScheduledUpdatedEvent): void => {
      writeEvent('scheduled.updated', payload);
    };
    const onTourUpdated = (payload: TourUpdatedEvent): void => {
      writeEvent('tour.updated', payload);
    };
    const onSuggestionUpdated = (payload: SuggestionUpdatedEvent): void => {
      writeEvent('suggestion.updated', payload);
    };
    events.on('conversation.updated', onConversationUpdated);
    events.on('message.persisted', onMessagePersisted);
    events.on('broadcast.updated', onBroadcastUpdated);
    events.on('placement.updated', onPlacementUpdated);
    events.on('scheduled.updated', onScheduledUpdated);
    events.on('tour.updated', onTourUpdated);
    events.on('suggestion.updated', onSuggestionUpdated);

    // Heartbeat as a REAL named event, not an SSE comment: the browser
    // EventSource API cannot observe comment frames (': ...') by spec, so a
    // comment heartbeat cannot prove liveness to the client. A half-open
    // connection (laptop sleep/wake, network switch, proxy drop without RST)
    // would then sit readyState=OPEN with no events and no error, silently
    // dead. Emitting 'heartbeat' with a timestamp lets the client watchdog
    // detect staleness and reconnect. Interval/cleanup are unchanged.
    const heartbeat = setInterval(() => {
      writeEvent('heartbeat', { at: new Date().toISOString() });
    }, sseHeartbeatMs);
    // Never keep the process alive for an idle stream.
    heartbeat.unref();

    log.info({ sse: 'connected' }, 'sse client connected');

    // Disconnect cleanup. The close event fires outside this request's
    // AsyncLocalStorage context (socket teardown), so re-enter the captured
    // context — otherwise the disconnect line would be an orphan log and
    // trip the orphan-log alarm.
    const ctx = getContext() ?? {};
    res.on('close', () => {
      sseConnections -= 1; // free the cap slot ('close' fires exactly once)
      clearInterval(heartbeat);
      events.off('conversation.updated', onConversationUpdated);
      events.off('message.persisted', onMessagePersisted);
      events.off('broadcast.updated', onBroadcastUpdated);
      events.off('placement.updated', onPlacementUpdated);
      events.off('scheduled.updated', onScheduledUpdated);
      events.off('tour.updated', onTourUpdated);
      events.off('suggestion.updated', onSuggestionUpdated);
      runWithContext(ctx, () => {
        log.info({ sse: 'disconnected' }, 'sse client disconnected');
      });
      res.end();
    });
  });

  return router;
}
