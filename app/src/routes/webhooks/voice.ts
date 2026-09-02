// Twilio Programmable Voice webhooks (M1.9a Change Order 1, doc §7.1 v2.17):
//   POST /webhooks/twilio/voice              — inbound call entry point
//   POST /webhooks/twilio/voice/whisper      — callee-leg whisper + press-1 gate
//   POST /webhooks/twilio/voice/whisper-gate — the press-1/timeout gate
//   POST /webhooks/twilio/voice/status       — call status callback (forward-only)
//   POST /webhooks/twilio/voice/recording    — recordingStatusCallback (M1.9c)
//   POST /webhooks/twilio/voice/intelligence - Voice Intelligence completion webhook (JSON)
//
// All are signature-gated identically to the SMS handlers (the same
// twilioSignatureMiddleware over the parsed form params; query params are part
// of the URL Twilio signs, so they are covered by the same HMAC).
//
// MASKED (pool-number) CALLING — the M1.9a path: a relay group (M1.7) has a
// pool_number + participants[]. When a member calls the pool number, we bridge
// them to the OTHER member(s) with the POOL NUMBER as caller ID (NEVER the real
// caller's number), after a whisper + press-1 gate on the callee leg (blocks
// carrier voicemail). Masked calls are NEVER recorded /
// transcribed (record="do-not-record") — they produce a metadata-only `call`
// timeline entry (who→whom by ROLE, when, duration, answered/missed).
//
// FOUNDER-BRIDGE RECORDING + VOICE INTELLIGENCE TRANSCRIPTION - the M1.9c path
// (CO1, v2.17) + voice-transcription: the founder-bridge call (M1.9b,
// masked:false) RECORDS. The recordingStatusCallback fetches the recording media
// (authenticated, SSRF-guarded) + streams it to S3, stamps
// recording_s3_key/duration on the `call` entity, and requests a Voice
// Intelligence transcript (inline create + reconcile fallback). The VI completion
// webhook (POST /voice/intelligence, JSON) fetches the sentences and persists a
// VERBATIM transcript (NO AI / structured extraction - Phase 2). ONLY the
// founder-bridge (non-masked) records/transcribes; the masked relay <Dial> STAYS
// do-not-record.
//
// PII (doc §9): NEVER log a real caller's phone/name, and NEVER speak/announce
// or persist a raw counterpart phone — IDs/SIDs/CallSid/role-labels/counts only.
// A recording/transcript IS sensitive: store in S3 / the call entity, NEVER in
// logs (RecordingUrl content + transcript text never appear in any log line).
import { Router } from 'express';
import twilio from 'twilio';
import { createMediaStore, type MediaStore } from '../../adapters/mediaStore.js';
import {
  createMessagingAdapter,
  MediaFetchRefusedError,
  type MessagingAdapter,
} from '../../adapters/messaging.js';
import { mergeContext } from '../../lib/context.js';
import { loadConfig, type AppConfig } from '../../lib/config.js';
import { formatPhoneForDisplay, normalizeToE164 } from '../../lib/phone.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../../lib/events.js';
import { callPreview } from '../../lib/callPreview.js';
import { contactDisplayName } from '../../lib/contactName.js';
import { logger as defaultLogger, type Logger } from '../../lib/logger.js';
import { resolveMessage } from '../../messages/index.js';
import {
  twilioSignatureMiddleware,
  twilioJsonSignatureMiddleware,
} from '../../middleware/twilioSignature.js';
import {
  createContactsRepo,
  isDeleted,
  type ContactItem,
  type ContactsRepo,
} from '../../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  relayMemberKey,
  type CallStatus,
  type CallStatusUpdate,
  type MessageItem,
  type MessagesRepo,
} from '../../repos/messagesRepo.js';
import { createExtractionRepo, type ExtractionRepo } from '../../repos/extractionRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../../repos/settingsRepo.js';
import { createUsersRepo, type UserItem, type UsersRepo } from '../../repos/usersRepo.js';
import {
  authorForContact,
  conversationTypeFor,
  contactShortName,
  maskedCallerLabel,
  roleWordForContact,
  shortNameFromFull,
  UNKNOWN_CALLER_LABEL,
} from '../../lib/voiceMasking.js';
import type { AuditRepo } from '../../repos/auditRepo.js';
import { createContactCapture } from '../../services/contactCapture.js';
import { createOurNumberKind } from '../../services/ourNumberKind.js';
import { resolveRelayInbound } from '../../services/relayInboundResolution.js';
import { createPushService, type PushService } from '../../services/pushService.js';
import { persistViTranscript } from '../../services/voiceTranscripts.js';
import { enqueue, enqueueImmediate } from '../../jobs/jobs.js';
import { MISSED_CALL_AUTOTEXT_JOB } from '../../jobs/missedCallAutoText.js';
import {
  CREATE_VOICE_TRANSCRIPT_JOB,
  RECONCILE_VOICE_TRANSCRIPT_JOB,
} from '../../jobs/voiceTranscript.js';

const { VoiceResponse } = twilio.twiml;

/** The webhook form fields this module reads (all optional strings). */
type WebhookParams = Record<string, string | undefined>;

function asParams(body: unknown): WebhookParams {
  return (typeof body === 'object' && body !== null ? body : {}) as WebhookParams;
}

/**
 * A neutral, masked party label for a participant: the NON-DELETED CONTACT's
 * masked name ("First L.", lib/voiceMasking) when the contact is readable, else
 * the stored roster name put through the same mask, else the role
 * ("Tenant"/"Landlord"), else the generic "the other party". NEVER the raw phone
 * (PII, doc section 9), and never an unmasked full name: this label is PERSISTED
 * as call_party_label AND spoken to the callee as the whisper's caller name.
 * Contact-first since 2026-09-01 (the roster name is a creation-time snapshot).
 * `role` comes from the reviewed contact type (honesty rule - only
 * tenant/landlord claim a role).
 *
 * The isDeleted guard is the same rung lib/participantNames.ts withLiveNames
 * enforces: a soft-deleted contact supplies NO name. getById returns deleted
 * rows unchanged, so the refusal has to happen here. It guards the NAME rung
 * only - the role rungs below never checked deletion and still do not.
 */
function maskedPartyLabel(member: ConversationParticipant | undefined, contact: ContactItem | undefined): string {
  const masked =
    (contact !== undefined && !isDeleted(contact) ? contactShortName(contact) : undefined) ??
    shortNameFromFull(member?.name);
  if (masked !== undefined) return masked;
  if (contact?.type === 'tenant') return 'Tenant';
  if (contact?.type === 'landlord') return 'Landlord';
  return 'the other party';
}

/**
 * The MASKED caller/contact label + the honesty-rule role/author/conversation-
 * type mapping now live in lib/voiceMasking.ts (shared with the OUTBOUND
 * originate path) - imported above. `maskedPartyLabel` above stays local: it
 * labels a relay ROSTER MEMBER, resolving the live contact first and masking
 * the stored roster name only as the fallback rung (a relay-only concern).
 */

/**
 * The PUSH-ONLY caller label (log-hygiene spec section 7; operator ruling D4
 * 2026-08-16 + the role-word amendment 2026-08-25): staff-facing pushes carry
 * FULL caller identity like a native phone app - lock-screen privacy is the
 * DEVICE's job, and a push lands on a staff member's OWN authenticated device.
 * The ROLE word is KEPT (load-bearing context on an incoming call); the identity
 * half is the message pushes' naming chain plus a terminal fallback so the label
 * is never empty and never undefined. Nothing here carries LESS than the masked
 * label it replaced: a nameless known caller now reads "Tenant - (555) 017-7777"
 * where it used to read "Tenant".
 *
 * NOT a guardrail break: PHASE1_CHANGE_ORDER_2 item 5 forbids the real caller's
 * number on the founder-bridge DIAL LEG (caller ID stays the business number),
 * and doc section 9 keeps identity out of logs and stored records - both
 * unchanged. The STORED call_party_label, the spoken whisper, thread rendering,
 * and the outbound originate path all keep the MASKED posture
 * (lib/voiceMasking.ts); this label exists ONLY in the ephemeral push payload
 * and is never logged. Exported for direct unit tests.
 */
export function pushCallerIdentity(
  contact: ContactItem | undefined,
  conversation: ConversationItem | undefined,
  phone: string | undefined,
): string {
  const identity =
    contactDisplayName(contact) ??
    // The EMPTY-STRING guard is load-bearing and is inlined exactly as the
    // message-push site inlines it (there is no named helper for it in the
    // repo): a stored empty display name would be SELECTED by a bare `??`.
    (typeof conversation?.participant_display_name === 'string' &&
    conversation.participant_display_name.length > 0
      ? conversation.participant_display_name
      : undefined) ??
    formatPhoneForDisplay(phone) ??
    // TERMINAL rung, guarded the same way: participant_phone can be '' (email
    // participants), and a bare `?? phone` would select it and emit an empty
    // body. formatPhoneForDisplay returns the input unchanged for a
    // non-NANP/unparseable number, so this rung only carries the odd shapes.
    (typeof phone === 'string' && phone.length > 0 ? phone : undefined);
  const role = roleWordForContact(contact);
  if (role !== undefined && identity !== undefined) return `${role} - ${identity}`;
  return role ?? identity ?? UNKNOWN_CALLER_LABEL;
}

/**
 * The one routing-decision SEAM before any dial (v2.17). Ring-through RULES are
 * DEFERRED — this is hardcoded to "bridge live" today. Inject the real rules
 * (do-not-disturb windows, per-placement routing, etc.) HERE later; the masked
 * bridge below is gated on this returning 'bridge'.
 *
 * // SEAM: ring-through rules deferred (v2.17) — inject the routing decision here later.
 */
function decideRouting(relay: ConversationItem, caller: ConversationParticipant): 'bridge' {
  // Inputs are intentionally unused until the deferred rules land — referenced
  // here so the seam signature stays meaningful (and lint-clean).
  void relay;
  void caller;
  return 'bridge';
}

/**
 * Founder call-triage routing-decision SEAM (M1.9b / v2.17). Ring-through RULES
 * are DEFERRED — this is hardcoded to "ring the founder" today. Inject the real
 * rules HERE later (do-not-disturb windows, per-placement routing, round-robin
 * across teammates, voicemail-only hours, etc.); the founder-bridge below is
 * gated on this returning 'ring-founder'.
 *
 * // SEAM: ring-through rules deferred (v2.17) — inject the routing decision here later.
 */
function decideFounderRouting(
  conversation: ConversationItem,
  callerContact: ContactItem | undefined,
): 'ring-founder' {
  // Inputs are intentionally unused until the deferred rules land — referenced
  // so the seam signature stays meaningful (and lint-clean).
  void conversation;
  void callerContact;
  return 'ring-founder';
}

/**
 * Map Twilio's CallStatus (top-level OR a Dial child's DialCallStatus) onto our
 * CallStatus machine. Identity for the lifecycle values; the Dial child
 * statuses ('answered'/'no-answer'/'busy'/'failed'/'canceled'/'completed') fold
 * onto the same set.
 */
function mapCallStatus(raw: string | undefined): CallStatus | undefined {
  switch (raw) {
    case 'ringing':
      return 'ringing';
    case 'in-progress':
    case 'answered':
      return 'in-progress';
    case 'completed':
      return 'completed';
    case 'no-answer':
      return 'no-answer';
    case 'busy':
      return 'busy';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return undefined;
  }
}

/**
 * LOAD-BEARING founder call-triage timing fallback (M1.9b / CO2 §7.1): the
 * pre-ring <Pause> seconds when the OrgSettings value is somehow missing/invalid.
 * The pause is now founder-editable on OrgSettings (CO2: founder-editable values
 * live in the settings record, NOT Parameter Store); this is the last-ditch
 * default so triage timing never breaks on a malformed/absent setting.
 */
const PRE_RING_PAUSE_FALLBACK_SECONDS = 2;
/** Same sane bound the Settings PUT validates (routes/settings.ts). */
const MAX_PRE_RING_PAUSE_SECONDS = 10;

/**
 * Seconds the founder-bridge <Dial> RINGS before giving up and offering OUR
 * voicemail. Twilio's default is 30 - LONGER than typical US carrier voicemail
 * pickup (~25-30s), so a ring-through let the holder's CARRIER voicemail
 * answer the bridge leg; the press-1 whisper then played ~14s to an answering
 * machine while the caller heard silence, and the caller hung up right as our
 * <Record> was delivered (observed live on prod 2026-08-16, call CA19ba...).
 * 20s reliably expires BEFORE carrier voicemail, so a ring-through goes: pause
 * (2-5s) + <=20s ring -> our voicemail prompt, with no dead-air window. A
 * DECLINE can still divert to carrier voicemail on some carriers (decline !=
 * busy) - the whisper gate already refuses that (no keypress -> hang up ->
 * voicemail), this timeout just removes the ring-through case entirely.
 */
const FOUNDER_BRIDGE_RING_TIMEOUT_SECONDS = 20;

/**
 * Queue lifetime for the pre-ring push. A pre-ring alert describes a ~30s
 * moment; Android defers even high-urgency pushes while dozing and then
 * flushes the backlog, and an unexpired pre-ring arrived MINUTES after its
 * call ended (observed 2026-08-16) - pure noise, and it made delivery look
 * broken. Better dropped than stale. missed_call/voicemail deliberately have
 * NO TTL: for those, late is better than never.
 */
const PRE_RING_PUSH_TTL_SECONDS = 60;

/** Voicemail ceiling (spec 4.1: "records up to a 2-minute message"). */
const VOICEMAIL_MAX_LENGTH_SECONDS = 120;
/**
 * Seconds of SILENCE that end a voicemail. Twilio's default is 5, which is too
 * aggressive for a prompt that says "leave a message after the tone": the clock
 * starts when <Record> does, so a caller who waits for the tone and pauses to
 * collect their thoughts gets cut off with nothing captured. 10s tolerates a
 * normal hesitation while still hanging up promptly on a caller who says
 * nothing. `maxLength` remains the actual length cap.
 */
const VOICEMAIL_SILENCE_TIMEOUT_SECONDS = 10;

/**
 * Clamp the founder-editable pre-ring pause to a sane whole-second range,
 * falling back to the default for anything non-integer / out of range. Defensive
 * twin of the route-level validation (a hand-written DynamoDB item could still
 * carry a bad value) so the TwiML <Pause length> is always valid.
 */
function clampPreRingPauseSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_PRE_RING_PAUSE_SECONDS) {
    return PRE_RING_PAUSE_FALLBACK_SECONDS;
  }
  return value;
}

export interface TwilioVoiceWebhookDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Twilio adapter (M1.9c: authed recording-media fetch); real adapter by default. */
  adapter?: MessagingAdapter;
  /**
   * S3 media store (M1.9c: mirror the founder-bridge recording). Undefined when
   * MEDIA_BUCKET is unset (local loop) — the recording callback then logs +
   * skips the mirror (the call entity stays recording-less, never a crash).
   */
  mediaStore?: MediaStore;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
  /** Audit trail (contact auto-capture appends contact_auto_captured). */
  auditRepo?: AuditRepo;
  /** Founder-editable templates (M1.9b: missed-call quick-replies); real repo by default. */
  settingsRepo?: SettingsRepo;
  /** Team lookup (M1.9b: resolve the founder = admin user(s)); real repo by default. */
  usersRepo?: UsersRepo;
  /** Web Push dispatch (M1.9b: pre-ring + missed-call pushes); real service by default. */
  pushService?: PushService;
  /** SSE live-update bus (M1.2); the process singleton by default. */
  events?: EventBus;
  /** Fact-extraction repo (voice-extraction T2): the VI completion webhook
   * schedules a run on a fresh transcript save. Injectable in tests; the real
   * repo by default. */
  extractionRepo?: ExtractionRepo;
}

export function createTwilioVoiceRouter(deps: TwilioVoiceWebhookDeps = {}): Router {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });
  // MEDIA_BUCKET unset (local loop) → createMediaStore returns undefined; the
  // recording callback logs + skips the mirror rather than crashing.
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const extraction = deps.extractionRepo ?? createExtractionRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const pushService =
    deps.pushService ?? createPushService({ config, logger: deps.logger, usersRepo: users });
  const events = deps.events ?? appEvents;
  // Contact auto-capture (inbound-call-skips-contact-capture): the SAME
  // idempotent, race-safe service the SMS webhook runs, so an unknown CALLER
  // also gets a needs_review stub + a participants link (source 'inbound_call'
  // stamps capture_source/consent to match the channel).
  const captureContact = createContactCapture({
    contactsRepo: contacts,
    conversationsRepo: conversations,
    auditRepo: deps.auditRepo,
    logger: deps.logger,
  });
  const ourNumberKind = createOurNumberKind({ config, conversations });
  const baseUrl = config.publicBaseUrl ?? '';
  // Founder-bridge caller ID: ALWAYS a number we own (the business number),
  // NEVER the real caller's From (the M1.9b guardrail).
  const businessCallerId = config.businessPhoneNumber;

  // Boot readiness signal (PII-safe — booleans only, never the cell itself):
  // inbound call-triage bridges to the assigned inbound-voice-line HOLDER's
  // verified cell — that holder is RUNTIME DATA (a user record), not boot config,
  // so it can't be checked at startup. What IS boot config is the business number
  // used as caller ID; without it every inbound business call degrades to the
  // "text us" fallback (see handleFounderTriage). Log it so a missing
  // BUSINESS_PHONE_NUMBER is obvious without a live test call.
  log.info(
    { hasBusinessNumber: businessCallerId !== undefined },
    `voice: business number ${
      businessCallerId !== undefined ? 'configured' : 'NOT configured (BUSINESS_PHONE_NUMBER)'
    }; inbound bridges to the assigned inbound-voice-line holder's verified cell`,
  );

  const router = Router();
  const verifySignature = twilioSignatureMiddleware({
    authToken: config.twilioAuthToken,
    publicBaseUrl: config.publicBaseUrl,
    nodeEnv: config.nodeEnv,
    logger: log,
  });
  // The JSON-body sibling for the Voice Intelligence completion webhook (spec
  // 3.3): same auth token + base URL, but validates the bodySHA256 scheme over
  // the raw JSON body instead of parsed form params.
  const verifyJsonSignature = twilioJsonSignatureMiddleware({
    authToken: config.twilioAuthToken,
    publicBaseUrl: config.publicBaseUrl,
    nodeEnv: config.nodeEnv,
    logger: log,
  });

  /** Send a TwiML document (text/xml), matching the SMS handler's content type. */
  function sendTwiml(res: import('express').Response, twiml: { toString(): string }): void {
    res.type('text/xml').send(twiml.toString());
  }

  /** A terse masked <Say> + hangup (refusals: closed thread, removed member). */
  function maskedSayHangup(message: string): InstanceType<typeof VoiceResponse> {
    const vr = new VoiceResponse();
    vr.say(message);
    vr.hangup();
    return vr;
  }

  /**
   * INBOX ACTIVITY for a call row (inbound-calls-invisible-in-inbox): stamp
   * `last_activity_at` + the call preview on the conversation - the SAME
   * touchLastActivity the text/email writers use, so the thread re-sorts and
   * re-previews in the inbox - and, when `unread`, bump `unread_count` (+ the
   * sparse byUnread flag) FIRST so the touch's ALL_NEW snapshot carries the
   * count into `conversation.updated`. Only an inbound MISS and a voicemail are
   * unread (operator decision 2026-08-03); ring/answered/outbound re-sort as
   * already-read. Best-effort: a failure logs and never 5xxs a webhook (the
   * call row is already persisted; the inbox is merely stale). Callers emit
   * `conversation.updated` from the returned item AFTER their
   * `message.persisted`, matching the SMS webhook's order - and the unread
   * write lands BEFORE `message.persisted` on purpose: a staff member viewing
   * the contact re-marks read on that event, so the increment must already be
   * visible or the miss would stay unread behind their back.
   */
  async function stampCallActivity(
    conversationId: string,
    preview: string,
    ts: string,
    unread: boolean,
    callSid: string,
  ): Promise<ConversationItem | undefined> {
    try {
      if (unread) await conversations.incrementUnread(conversationId);
      return await conversations.touchLastActivity(conversationId, preview, ts);
    } catch (err) {
      log.error(
        { err, callSid, conversationId, unread },
        'voice: touchLastActivity/unread failed - call row persisted, inbox stale',
      );
      return undefined;
    }
  }

  // ---------------------------------------------------------------------
  // Inbound voice — POST /voice. Mirrors the SMS inbound handler's shape:
  // missing-fields guard → echo guard → route by To.
  // ---------------------------------------------------------------------
  router.post('/', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const { CallSid, From, To } = params;
    if (!CallSid || !From) {
      log.warn(
        { hasCallSid: Boolean(CallSid), hasFrom: Boolean(From) },
        'twilio inbound voice webhook missing CallSid/From — rejected',
      );
      res.status(400).json({ error: 'bad request' });
      return;
    }

    // (1) Echo/loop guard (doc §7.1 defense 1, mirrored for voice): From being
    // one of OUR numbers — including a pool number — means this is our own
    // outbound leg projected back. Answer with an empty <Response/> and drop:
    // never bridge, never persist. (Our masked bridge dials FROM the pool
    // number, so a misconfigured loop would otherwise re-enter here.)
    const kind = await ourNumberKind(From);
    if (kind === 'business') {
      log.info({ callSid: CallSid }, 'twilio voice echo (From is our number) — dropped');
      sendTwiml(res, new VoiceResponse());
      return;
    }
    if (kind === 'pool') {
      log.info({ callSid: CallSid }, 'twilio voice echo (From is a pool number) — dropped');
      sendTwiml(res, new VoiceResponse());
      return;
    }

    // (2) Route by To. A pool number -> the masked relay-group bridge. A pool
    // number fronts MANY participant-disjoint groups (relay-number-lifecycle),
    // so the group is resolved on the (To, From) PAIR by the shared ladder in
    // services/relayInboundResolution.ts - the same policy object the SMS
    // webhook consumes, extracted so the two channels cannot drift. Routing on
    // To alone via getByPoolNumber judged every caller against ONE arbitrary
    // open roster and refused legitimate members of the number's other groups
    // (prod incident 2026-08-22/23).
    if (To !== undefined && To.length > 0) {
      const groups = await conversations.getAllByPoolNumber(To);
      const resolution = resolveRelayInbound(groups, From);
      if (resolution !== undefined && resolution.kind !== 'all_closed_non_member') {
        if (resolution.kind === 'open_member' && resolution.violatingOpenMatchIds) {
          log.error(
            {
              callSid: CallSid,
              matchCount: resolution.violatingOpenMatchIds.length,
              conversationIds: resolution.violatingOpenMatchIds,
            },
            'multiple OPEN relay groups on one pool number match the caller (burn invariant violated) - routing to the newest',
          );
        }
        // open_member -> bridge. closed_member -> the closed-thread refusal,
        // filed in the caller's OWN dead thread. non_member_open -> the
        // non-member refusal, filed on the newest open group for the record.
        // handleMaskedInbound derives each outcome from the group it is handed.
        await handleMaskedInbound(res, resolution.group, { CallSid, From });
        return;
      }
      // undefined (To fronts no relay groups at all) or all_closed_non_member
      // (AF-5: never bury a stranger, a second phone, or a member calling from
      // a NEW phone in a dead group transcript) -> fall through to founder
      // call-triage below, the voice analogue of the SMS 1:1 intake path.
    }

    // (3) To is the business number (config.businessPhoneNumber) or unknown → FOUNDER
    // CALL-TRIAGE (M1.9b / CO2 §7.1). Pre-ring push to the founder ~preRingPause
    // seconds AHEAD of the ring, then bridge the call to the founder's cell with
    // the BUSINESS number as caller ID (never the real caller's) via the same
    // whisper + press-1 accept gate as the masked bridge. Missed → missed-call
    // push + zero-tap auto-text (the /voice/status handler below). The
    // main-business-number → landlord-by-unit (primary_contact) masked
    // path stays M1.10 (needs the unit↔placement linkage).
    // NOTE (contact-rosters spec 2026-08-04 section 12): when this path is
    // built it must consult the THREAD roster, not the unit scalar.
    // TODO(voice-business-number-roster): resolve callees through the shared
    // roster resolver (docs/issues/voice-business-number-roster.md).
    await handleFounderTriage(res, { CallSid, From });
  });

  /**
   * FOUNDER CALL-TRIAGE (M1.9b): an inbound call to a BUSINESS number (not a
   * pool number). Resolve the caller's 1:1 conversation for masked context,
   * persist a (NON-masked — this is a founder-bridge, not a masked relay) `call`
   * entry CallSid-idempotently, send the pre-ring push to the founder (admin
   * user(s)) BEFORE returning TwiML, then return a <Pause> + <Dial> that bridges
   * to the founder's cell (callerId = the business number) behind the whisper +
   * press-1 gate. The founder-bridge RECORDS (M1.9c) — recording media is mirrored
   * to S3 by the /voice/recording callback (the masked relay <Dial> stays
   * do-not-record).
   */
  async function handleFounderTriage(
    res: import('express').Response,
    call: { CallSid: string; From: string },
  ): Promise<void> {
    const { CallSid, From } = call;

    // Voice Phase 1 (spec §6): the dialed cell is the INBOUND-VOICE-LINE holder's
    // VERIFIED cell — ONLY that. There is no env-var fallback: if no holder is
    // assigned (or the holder's cell is unverified) we DO NOT bridge. Resolving
    // the holder is best-effort — a users-table read hiccup is treated as "no
    // holder" and flows into the error + text-us path below.
    let holder: UserItem | undefined;
    try {
      holder = await users.getInboundVoiceLineHolder();
    } catch (err) {
      log.error({ err, callSid: CallSid }, 'inbound voice: resolving the inbound-voice-line holder failed — treating as no holder configured');
    }
    const holderCell =
      holder !== undefined &&
      typeof holder.cell_verified_at === 'string' && holder.cell_verified_at.length > 0 &&
      typeof holder.cell === 'string' && holder.cell.length > 0
        ? holder.cell
        : undefined;

    // No business number to use as caller ID, or no verified holder to dial → we
    // CANNOT bridge (no target, or would leak the caller's From). This is an
    // OPERATOR MISCONFIGURATION, not a normal degrade: emit an ERROR (pino ≥50 →
    // the hc-<env>-error-logs alarm fires, so ops is notified) and answer the
    // caller with the graceful text-us greeting. NEVER a 5xx (Twilio would retry
    // the webhook forever) and NEVER a raw number in the log (PII, §9).
    if (businessCallerId === undefined || holderCell === undefined) {
      log.error(
        {
          callSid: CallSid,
          hasBusinessNumber: businessCallerId !== undefined,
          hasVerifiedHolder: holderCell !== undefined,
        },
        'inbound voice: NO inbound-voice-line holder with a verified cell is configured — inbound call NOT bridged. Assign an inbound voice line in Settings > Team (the user must verify their cell first).',
      );
      sendTwiml(
        res,
        maskedSayHangup(resolveMessage('voice.greeting_no_holder')),
      );
      return;
    }
    // Past the guard: the dialed cell is the holder's verified cell (narrowed to
    // a defined string — there is no env-var fallback).
    const dialedCell = holderCell;

    // SELF-CALL GUARD: the caller IS the dialed cell (the holder dialing the
    // business line, or a test placed from their own phone). Bridging them to
    // their own number is nonsensical, and with answerOnBridge it leaves the
    // caller leg unanswered → a VoIP client can loop on it. Refuse to bridge — a
    // brief greeting + hangup, no self-dial, no bogus call entry/push. (The
    // masked relay path's equivalent protection is its CALLEE FILTER - callees
    // are `participants` minus From - so a member can never be dialed back on
    // the number they are calling from.)
    if (From === dialedCell) {
      log.info({ callSid: CallSid }, 'founder triage: caller is the dialed cell — not bridging to self');
      sendTwiml(
        res,
        maskedSayHangup(resolveMessage('voice.self_call')),
      );
      return;
    }

    // Resolve the caller's 1:1 conversation for masked context (role/name +
    // the conversationId the pushes + auto-text key on). conversationTypeFor
    // mirrors the SMS path's honesty rule (unknown until a human reviews).
    const callerContact = await contacts.findByPhone(From);

    // Spec §3.2 rationale, applied to VOICE: a customer-initiated inbound call
    // confers consent (same basis as inbound_text — they reached out to us), so a
    // follow-up text isn't JIT-gated. Idempotent — only when consent_method is
    // absent (never overwrites a web_form/verbal/staff-attested record) — and
    // best-effort: a stamp failure must never block the bridge.
    if (callerContact && !callerContact.consent_method) {
      try {
        await contacts.update(callerContact.contactId, {
          consent_method: 'inbound_call',
          consent_at: new Date().toISOString(),
        });
      } catch (err) {
        log.warn({ err, callSid: CallSid }, 'inbound voice: consent stamp failed (best-effort) — bridging anyway');
      }
    }

    const conversation = await conversations.createOrGetByParticipantPhone(
      From,
      conversationTypeFor(callerContact),
    );
    mergeContext({ conversationId: conversation.conversationId });

    // Contact auto-capture (M1.2 parity for VOICE — inbound-call-skips-contact-
    // capture): an unknown caller gets a needs_review stub + the conversation's
    // participants link, exactly like an unknown texter — that record is what
    // puts the caller on Today's triage queue, in Contacts ▸ Unknown, and behind
    // the Inbox row's contact deep-link. Idempotent + race-safe (the service's
    // conditional claims), so redelivered webhooks are no-ops. BEST-EFFORT: a
    // capture failure must never block the bridge (the call itself comes first).
    try {
      await captureContact(conversation, callerContact, 'inbound_call');
    } catch (err) {
      log.error(
        { err, callSid: CallSid, conversationId: conversation.conversationId },
        'inbound voice: contact auto-capture failed (best-effort) — bridging anyway',
      );
    }

    // Routing-decision SEAM (v2.17): hardcoded 'ring-founder' today.
    const decision = decideFounderRouting(conversation, callerContact);
    /* c8 ignore next 5 */
    if (decision !== 'ring-founder') {
      // Unreachable today (decideFounderRouting only returns 'ring-founder') —
      // the shape the deferred ring-through rules will use to refuse a bridge.
      sendTwiml(res, maskedSayHangup(resolveMessage('voice.founder_refuse')));
      return;
    }

    // The MASKED caller label (role + abbreviated name, else "Unknown caller")
    // — used for the timeline entry AND the pushes. NEVER the raw From (PII).
    const callerLabel = maskedCallerLabel(callerContact);

    // Persist the founder-bridge `call` entry ONCE (CallSid-idempotent). This is
    // NOT a masked relay — masked:false (a founder-bridge). author = caller's
    // reviewed role/unknown; call_party_label = the masked caller label.
    // recording_s3_key/transcript are populated LATER by the recording +
    // transcription callbacks (M1.9c) — unset at ring time. A redelivered /voice
    // webhook dedupes here → no double-write, and the pre-ring push still fires
    // (it is idempotent at the founder's device).
    const startedAt = new Date().toISOString();
    try {
      const appended = await messages.append({
        conversationId: conversation.conversationId,
        providerSid: CallSid,
        providerTs: startedAt,
        type: 'call',
        direction: 'inbound',
        author: authorForContact(callerContact),
        deliveryStatus: 'delivered',
        callStatus: 'ringing',
        startedAt,
        masked: false,
        callPartyLabel: callerLabel,
        // Source-attributed channel roles (voice-extraction Layer 1). Twilio
        // dual-channel <Dial>: the PARENT call is channel 1, the dialed child is
        // channel 2 (https://www.twilio.com/docs/voice/twiml/dial). Here the
        // parent is the INBOUND caller (client called us) and the child is the
        // dialed staff cell -> { "1":"client", "2":"staff" }. OPPOSITE the
        // outbound originate bridge, where WE ring the staff cell as the parent.
        transcriptChannelRoles: { '1': 'client', '2': 'staff' },
      });
      if (!appended.deduped) {
        // INBOX: deliberately NO conversation stamp at ring time. The thread is
        // stamped from the <Dial action> summary (/voice/status) with the real
        // outcome. A caller who abandons during the ring produces no Dial
        // summary (docs/issues/voice-caller-abandon-no-dial-summary.md), and a
        // ring-time "Incoming call" stamp would then sit at the top of the
        // inbox forever, already-read, for a call the summary never closed.
        events.emit('message.persisted', {
          conversationId: conversation.conversationId,
          tsMsgId: appended.tsMsgId,
          direction: 'inbound',
          deliveryStatus: 'delivered',
        });
      }
    } catch (err) {
      // Never 5xx a webhook on a persist failure — bridge regardless (a
      // redelivery dedupes at the append).
      log.error({ err, callSid: CallSid }, 'founder triage: persisting the call entry failed — bridging anyway');
    }

    // PRE-RING push to the founder (admin user(s)) — FIRED, but NOT awaited
    // (FIX 2). The push backend (a DynamoDB founder scan + sequential per-device
    // web-push POSTs) can be slow; awaiting it here would add dead air before the
    // TwiML and risk the ~15s Twilio webhook timeout. We START it now (so it
    // still goes out ahead of the ring) but return the bridge TwiML immediately;
    // the <Pause length=preRingPause> below remains the intended head start so
    // the push lands AHEAD of the cell ringing. sendPreRingPush is already fully
    // error-trapped internally, so the extra .catch is belt-and-braces (an
    // unexpected throw can never become an unhandled rejection). PII (doc §9):
    // the identity rides the ephemeral payload ONLY and never a log line; the
    // send never blocks or fails the bridge.
    // The push (holder's own device) carries the caller's ROLE + FULL identity
    // via pushCallerIdentity (D4 + the 2026-08-25 role-word amendment); the
    // stored entry above keeps the masked callerLabel, and logs stay masked.
    // Voice Phase 1 (spec §6): the pre-ring targets the HOLDER (the user whose
    // cell is ringing), not all admins. By here holderCell is defined (the
    // no-holder path returned above), so `holder` is defined too — the guard is
    // belt-and-braces to keep the type narrow.
    if (holder !== undefined) {
      const holderUserId = holder.userId;
      void sendPreRingPush(
        holderUserId,
        conversation.conversationId,
        CallSid,
        pushCallerIdentity(callerContact, conversation, From),
      ).catch((err: unknown) => {
        log.error({ err, callSid: CallSid }, 'founder triage: pre-ring push failed (fire-and-forget)');
      });
    }

    // Build the founder-bridge TwiML. callerId is ALWAYS the business number,
    // NEVER From (the guardrail). The <Pause> is what makes the push land first.
    // The founder-leg whisper announces the caller (masked) + press-1 to accept
    // (blocks the founder's carrier voicemail from silently "answering"). The
    // <Dial action> + per-leg statusCallback report MISSED/answered to
    // /voice/status.
    //
    // M1.9c RECORDING: the founder-bridge (non-masked) call RECORDS. We use
    // 'record-from-answer-dual' — recording starts only when the bridge is
    // ANSWERED (no dead-air/whisper-gate audio before the press-1 accept), and
    // DUAL channel keeps caller + founder on separate tracks (cleaner for the
    // verbatim transcript later). The recordingStatusCallback fires once on
    // 'completed' → /voice/recording mirrors the media to S3. This applies to
    // the founder-bridge ONLY; the masked relay <Dial> stays do-not-record.
    // The pre-ring pause is now founder-editable on OrgSettings (CO2: founder-
    // editable values live in the settings record, NOT Parameter Store). One
    // GetItem on the TwiML path — cheap, and the read is defended (a fetch
    // failure or a malformed value falls back to the default; triage timing
    // must never crash the bridge).
    let preRingPauseSeconds = PRE_RING_PAUSE_FALLBACK_SECONDS;
    try {
      const orgSettings = await settings.getOrgSettings();
      preRingPauseSeconds = clampPreRingPauseSeconds(orgSettings.preRingPauseSeconds);
    } catch (err) {
      log.warn(
        { err, callSid: CallSid, fallback: PRE_RING_PAUSE_FALLBACK_SECONDS },
        'founder triage: reading pre-ring pause from settings failed — using the default',
      );
    }

    const vr = new VoiceResponse();
    vr.pause({ length: preRingPauseSeconds });
    const dial = vr.dial({
      callerId: businessCallerId,
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${baseUrl}/webhooks/twilio/voice/recording`,
      recordingStatusCallbackEvent: ['completed'],
      recordingStatusCallbackMethod: 'POST',
      answerOnBridge: true,
      // Ring shorter than carrier voicemail's pickup - see the constant's note.
      timeout: FOUNDER_BRIDGE_RING_TIMEOUT_SECONDS,
      action: `${baseUrl}/webhooks/twilio/voice/status`,
      method: 'POST',
    });
    // The whisper context rides the query string (stateless; covered by the
    // HMAC since Twilio signs the full URL). leg=founder selects the founder
    // whisper copy; callerLabel is a ROLE/name, never a phone.
    const whisperUrl =
      `${baseUrl}/webhooks/twilio/voice/whisper` +
      `?callerLabel=${encodeURIComponent(callerLabel)}` +
      `&conversationId=${encodeURIComponent(conversation.conversationId)}` +
      `&parentCallSid=${encodeURIComponent(CallSid)}` +
      `&leg=founder`;
    dial.number(
      {
        url: whisperUrl,
        statusCallback: `${baseUrl}/webhooks/twilio/voice/status`,
        // (FIX 1) Only 'ringing' — a harmless transitional hint. The TERMINAL
        // bridge outcome (answered/missed) is reported AUTHORITATIVELY by the
        // <Dial action> summary above (DialCallStatus/DialCallDuration). We do
        // NOT subscribe the per-leg 'answered'/'completed' here: those describe
        // the founder LEG / whisper answer, not whether the bridge connected, so
        // letting them through would misclassify a missed call as answered.
        statusCallbackEvent: ['ringing'],
        statusCallbackMethod: 'POST',
      },
      dialedCell,
    );
    log.info(
      { callSid: CallSid, callerIdIsBusiness: true, masked: false, recording: true, preRingPauseSeconds, hasHolder: holder !== undefined },
      'founder triage: pre-ring push sent, bridging to the inbound-line cell (callerId = business number, record-from-answer-dual, whisper+gate)',
    );
    sendTwiml(res, vr);
  }

  /**
   * The set of founder (admin) users to notify — resolved fresh per call.
   * SCALE NOTE (accepted): usersRepo.listByRole('admin') SCANs the (tiny,
   * bounded) users table on the call path. Acceptable at the current team size;
   * revisit with a byRole GSI if the users table grows (see usersRepo.listByRole).
   */
  async function resolveFounders(): Promise<UserItem[]> {
    try {
      return await users.listByRole('admin');
    } catch (err) {
      // A lookup failure must never break the bridge — log + push to nobody.
      log.error({ err }, 'founder triage: resolving admin users failed — no push sent');
      return [];
    }
  }

  /**
   * Send the PRE-RING push to the inbound-voice-line HOLDER (the user whose cell
   * is ringing - spec section 6). kind 'pre_ring'; the body is the caller's ROLE
   * + FULL identity from pushCallerIdentity (operator ruling D4 2026-08-16 + the
   * role-word amendment 2026-08-25), e.g. "Tenant - Jane Doe". That identity is
   * PUSH-ONLY: it never reaches a log line, the stored call_party_label, or the
   * dial caller ID (PII, doc section 9).
   * Best-effort: a push failure never blocks the bridge.
   */
  async function sendPreRingPush(
    holderUserId: string,
    conversationId: string,
    callSid: string,
    callerLabel: string,
  ): Promise<void> {
    // Payload shape the service worker expects (dashboard/public/sw.js):
    // { title, body, kind, callId, conversationId } — pre_ring carries no
    // actions (the holder is about to be rung; the actions are on the missed
    // push). The deep link is the conversation (sw.js routes pre_ring by
    // conversationId since it isn't a missed_call).
    const payload = {
      title: 'Incoming call',
      body: `Incoming call — ${callerLabel}`,
      kind: 'pre_ring' as const,
      callId: callSid,
      conversationId,
    };
    try {
      await pushService.sendToUser(holderUserId, {
        kind: 'pre_ring',
        payload,
        // Short queue lifetime: a pre-ring delivered after its call is over is
        // noise, not information (see PRE_RING_PUSH_TTL_SECONDS).
        ttlSeconds: PRE_RING_PUSH_TTL_SECONDS,
      });
    } catch (err) {
      log.warn({ err, callSid, userId: holderUserId }, 'founder triage: pre-ring push failed — continuing');
    }
  }

  /**
   * The MASKED bridge: To is a relay pool number. Identify the caller (the
   * member whose phone == From) and the callee(s) (the OTHER members). Persist a
   * metadata-only `call` entry (masked, CallSid-idempotent), then return TwiML
   * that <Dial>s the OTHER member(s) FROM the pool number with a whisper +
   * press-1 gate on the callee leg. The bridged-leg caller ID is ALWAYS the
   * pool number, NEVER From.
   */
  async function handleMaskedInbound(
    res: import('express').Response,
    relay: ConversationItem,
    call: { CallSid: string; From: string },
  ): Promise<void> {
    const { CallSid, From } = call;
    mergeContext({ conversationId: relay.conversationId });
    const poolNumber = relay.pool_number;
    const roster = relay.participants ?? [];
    const caller = roster.find((m) => m.phone === From);
    const callees = roster.filter((m) => m.phone !== From);
    const isClosed = relay.status !== 'open';

    // Refusal cases: a CLOSED thread, a caller who is NOT a current participant
    // (removed mid-placement), an open relay missing its pool number (anomaly),
    // or a relay with no other member to bridge to. In every case: a brief
    // masked <Say> + hangup (NO bridge, NO number leak), and persist a
    // metadata-only call entry flagged accordingly so the timeline is honest.
    if (isClosed || !caller || typeof poolNumber !== 'string' || poolNumber.length === 0 || callees.length === 0) {
      const reason = isClosed
        ? 'closed_thread'
        : !caller
          ? 'non_member'
          : callees.length === 0
            ? 'no_callee'
            : 'no_pool_number';
      // Author honesty: a known caller's role, else unknown.
      const callerContact = caller?.contactId ? await contacts.getById(caller.contactId) : undefined;
      const startedAt = new Date().toISOString();
      let relayExternalCallerPhone: string | undefined;
      let relayExternalCallerContactId: string | undefined;
      if (reason === 'non_member') {
        relayExternalCallerPhone = normalizeToE164(From);
        if (relayExternalCallerPhone !== undefined) {
          try {
            const matched = await contacts.findByPhone(relayExternalCallerPhone);
            if (matched !== undefined && !isDeleted(matched)) {
              relayExternalCallerContactId = matched.contactId;
            }
          } catch {
            log.warn(
              { callSid: CallSid },
              'masked non-member caller lookup failed; persisting phone-only refusal metadata',
            );
          }
        }
      }
      try {
        const appended = await messages.append({
          conversationId: relay.conversationId,
          providerSid: CallSid,
          providerTs: startedAt,
          type: 'call',
          direction: 'inbound',
          author: authorForContact(callerContact),
          deliveryStatus: 'delivered',
          callStatus: 'no-answer',
          callOutcome: 'missed',
          startedAt,
          masked: true,
          ...(caller !== undefined && { relaySenderKey: relayMemberKey(caller) }),
          // No counterpart label on a refusal (no bridge happened); record why.
          callPartyLabel: reason === 'closed_thread' ? 'Closed thread' : 'Not connected',
          ...(isClosed && { receivedOnClosedThread: true }),
          ...(reason === 'non_member' && {
            relayRefusalReason: 'non_member' as const,
            ...(relayExternalCallerPhone !== undefined && { relayExternalCallerPhone }),
            ...(relayExternalCallerContactId !== undefined && { relayExternalCallerContactId }),
          }),
        });
        if (!appended.deduped) {
          events.emit('message.persisted', {
            conversationId: relay.conversationId,
            tsMsgId: appended.tsMsgId,
            direction: 'inbound',
            deliveryStatus: 'delivered',
          });
        }
      } catch (err) {
        // Never 5xx a webhook on a persist failure — answer with the masked
        // refusal regardless (a redelivery dedupes at the append).
        log.error({ err, callSid: CallSid, reason }, 'masked call refusal: persisting the call entry failed');
      }
      log.info({ callSid: CallSid, reason, masked: true }, 'masked inbound call refused — no bridge');
      sendTwiml(
        res,
        maskedSayHangup(resolveMessage('voice.thread_closed')),
      );
      return;
    }

    // Routing-decision SEAM (v2.17): hardcoded 'bridge' today.
    const decision = decideRouting(relay, caller);
    /* c8 ignore next 4 */
    if (decision !== 'bridge') {
      // Unreachable today (decideRouting only returns 'bridge') — the shape the
      // deferred ring-through rules will use to refuse a bridge.
      sendTwiml(res, maskedSayHangup(resolveMessage('voice.masked_refuse')));
      return;
    }

    // Label the counterpart by ROLE/name for the timeline — NEVER the phone.
    // For a 2-party relay this is the single callee; for a larger group we label
    // the first callee + a count (still no phones).
    const firstCallee = callees[0];
    const firstCalleeContact = firstCallee?.contactId
      ? await contacts.getById(firstCallee.contactId)
      : undefined;
    const calleeLabel =
      callees.length > 1
        ? `${maskedPartyLabel(firstCallee, firstCalleeContact)} +${callees.length - 1}`
        : maskedPartyLabel(firstCallee, firstCalleeContact);

    // The whisper announces the CALLER by role (so the callee knows who is
    // connecting) — never the caller's phone.
    const callerContact = caller.contactId ? await contacts.getById(caller.contactId) : undefined;
    const callerLabel = maskedPartyLabel(caller, callerContact);

    // Persist the metadata-only call entry ONCE (CallSid-idempotent). author =
    // caller role; call_party_label = the callee role/name (the counterpart).
    // masked=true; recording_s3_key/transcript stay UNPOPULATED (asserted in
    // tests). A redelivered /voice webhook dedupes here → no double-write.
    const startedAt = new Date().toISOString();
    try {
      const appended = await messages.append({
        conversationId: relay.conversationId,
        providerSid: CallSid,
        providerTs: startedAt,
        type: 'call',
        direction: 'inbound',
        author: authorForContact(callerContact),
        deliveryStatus: 'delivered',
        callStatus: 'ringing',
        startedAt,
        masked: true,
        relaySenderKey: relayMemberKey(caller),
        callPartyLabel: calleeLabel,
      });
      if (!appended.deduped) {
        events.emit('message.persisted', {
          conversationId: relay.conversationId,
          tsMsgId: appended.tsMsgId,
          direction: 'inbound',
          deliveryStatus: 'delivered',
        });
      }
    } catch (err) {
      log.error({ err, callSid: CallSid }, 'masked call: persisting the call entry failed — bridging anyway');
    }

    // Build the bridge TwiML. callerId MUST be the pool number — NEVER From.
    // record="do-not-record": masked calls are NEVER recorded/transcribed. The
    // <Dial action> reports the dial outcome to /voice/status; each <Number>
    // carries the whisper url (press-1 gate runs on the CALLEE leg) + its own
    // statusCallback so a per-leg answered/completed also reaches /voice/status.
    const vr = new VoiceResponse();
    const dial = vr.dial({
      callerId: poolNumber,
      record: 'do-not-record',
      answerOnBridge: true,
      action: `${baseUrl}/webhooks/twilio/voice/status`,
      method: 'POST',
    });
    // The whisper context rides the query string (stateless; covered by the
    // HMAC since Twilio signs the full URL). callerLabel is a ROLE/name, never a
    // phone. conversationId + the original CallSid let the gate/team-escape and
    // status routes correlate without server state.
    const whisperUrl =
      `${baseUrl}/webhooks/twilio/voice/whisper` +
      `?callerLabel=${encodeURIComponent(callerLabel)}` +
      `&conversationId=${encodeURIComponent(relay.conversationId)}` +
      `&parentCallSid=${encodeURIComponent(CallSid)}`;
    for (const callee of callees) {
      // THE ROSTER IS THE ROUTING (contact-rosters D10): every callee is dialed
      // on the number stored on their participant row. There is no per-property
      // substitution - a leg moves only when the roster moves, which is exactly
      // what the People card edits.
      const dialPhone = callee.phone;
      dial.number(
        {
          url: whisperUrl,
          statusCallback: `${baseUrl}/webhooks/twilio/voice/status`,
          // (FIX 1) Only 'ringing' — the TERMINAL bridge outcome + duration come
          // AUTHORITATIVELY from the <Dial action> summary (DialCallStatus/
          // DialCallDuration), never the per-leg child callback (whose
          // CallDuration is the callee LEG / whisper, not the bridged call).
          statusCallbackEvent: ['ringing'],
          statusCallbackMethod: 'POST',
        },
        dialPhone,
      );
    }
    log.info(
      {
        callSid: CallSid,
        calleeCount: callees.length,
        masked: true,
        callerIdIsPool: true,
      },
      'masked inbound call bridged (callerId = pool number, do-not-record, whisper+gate)',
    );
    sendTwiml(res, vr);
  }

  /**
   * Resolve the OUTBOUND target from an opaque conversationId (spec §5/§6): the
   * conversation's participant_phone is the target number, and the freshly-
   * resolved contact gives the masked label. The raw target phone is NEVER read
   * from the URL — only the conversationId is. Returns undefined when the
   * conversation is missing / carries no participant phone (the caller then
   * refuses to bridge). PII: the returned label is a role/name, never a phone.
   *
   * `optedOut` carries the freshly-loaded contact's voice_opt_out (company
   * do-not-call) so the press-1 gate can RE-CHECK it at dial time — the
   * originate service already refuses pre-dial, but staff can set the flag in
   * the seconds between originate and press-1
   * (docs/issues/voice-bridge-dnc-recheck.md).
   */
  async function resolveOutboundTarget(
    conversationId: string,
  ): Promise<{ targetPhone: string; label: string; optedOut: boolean } | undefined> {
    if (conversationId.length === 0) return undefined;
    const conversation = await conversations.getById(conversationId);
    const targetPhone =
      typeof conversation?.participant_phone === 'string' && conversation.participant_phone.length > 0
        ? conversation.participant_phone
        : undefined;
    if (conversation === undefined || targetPhone === undefined) return undefined;
    const contact = await contacts.findByPhone(targetPhone);
    return {
      targetPhone,
      label: maskedCallerLabel(contact),
      optedOut: contact?.voice_opt_out === true,
    };
  }

  /**
   * D12 (spec 6.3) companion: tell any OPEN contact timeline that a gate write
   * just changed this call's lifecycle - a REFUSAL stamping it terminal, or a
   * press-1 ACCEPTANCE stamping it in-progress. Both are gate paths whose only
   * other signal would arrive at t+90s, and the timeline refetches ONLY on
   * message.persisted / conversation.updated.
   *
   * Called ONLY when `updateCallStatus` reported a real transition, and always
   * from inside its OWN swallowing try/catch, separate from the stamp's - these
   * are TwiML response paths and the call itself outranks the announcement, but
   * a failure here means the stamp COMMITTED and only the push was lost, which
   * is a different operator story from a failed write. Emits
   * `message.persisted` ONLY: the inbox row must stay exactly as it is
   * (spec 6.4), so NO stampCallActivity and NO conversation.updated. IDs only in
   * any log - never a phone.
   *
   * NO READ OF ITS OWN (fix wave 4, N-1). It takes the ROW `updateCallStatus`
   * already resolved. It used to re-read that same row by provider sid - two
   * more sequential DynamoDB round trips, AWAITED between a human pressing 1 and
   * the <Dial> that joins the two parties, with both of them silent on the line.
   * A swallowing try/catch bounds errors, not latency: overrun Twilio's
   * TwiML-fetch ceiling during a DynamoDB spike and the caller hears an
   * application error and THE BRIDGE NEVER HAPPENS. The row's own
   * conversationId is still what is emitted, so the branch whose query-string
   * conversation did not resolve is unaffected.
   *
   * INVARIANT - every field emitted here (conversationId, tsMsgId, direction,
   * delivery_status) is stamped at APPEND time and never mutated on a call row,
   * so a PRE-WRITE snapshot carries them correctly (which also closes N-2: the
   * old re-read had no ConsistentRead and could return a pre-update snapshot
   * anyway - this is the same data with known provenance). A lifecycle field
   * (call_status / call_outcome / answered_at / ended_at / call_duration) must
   * NOT be added to this payload without reconsidering provenance: `row`
   * describes the state BEFORE the stamp committed.
   */
  function announceCallStamp(row: MessageItem): void {
    // Masked Relay calls now render in their Relay Timeline, so they need this
    // same lifecycle refresh. message.persisted is intentionally the ONLY
    // event: no conversation activity stamp means no Inbox reorder, preview
    // change, or unread bump for either Relay or 1:1 calls.
    events.emit('message.persisted', {
      conversationId: row.conversationId,
      tsMsgId: row.tsMsgId,
      direction: row.direction,
      deliveryStatus: row.delivery_status,
    });
  }

  // ---------------------------------------------------------------------
  // Outbound bridge — POST /voice/outbound-bridge (Voice Phase 1, spec §5).
  // Runs on the NAVIGATOR leg when they answer the originated call. Resolves the
  // target SERVER-SIDE from ?conversationId (NEVER a phone in the URL), then
  // returns the SAME whisper + press-1 gate the founder/relay legs use — REUSING
  // /voice/whisper's machinery/copy. The gate URL carries the opaque
  // conversationId + an outbound=1 marker; on press-1 the whisper-gate's OUTBOUND
  // branch dials the target FROM the business number.
  // ---------------------------------------------------------------------
  router.post('/outbound-bridge', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const q = req.query as Record<string, string | undefined>;
    const conversationId = typeof q['conversationId'] === 'string' ? q['conversationId'] : '';
    const parentCallSid =
      typeof q['parentCallSid'] === 'string' ? q['parentCallSid'] : (params['CallSid'] ?? '');
    if (conversationId.length > 0) mergeContext({ conversationId });

    const target = await resolveOutboundTarget(conversationId);
    if (target === undefined) {
      // The conversation is gone / has no target — refuse cleanly (never a leak,
      // never a 5xx). The navigator hears a brief note + hangup.
      log.warn({ callSid: parentCallSid }, 'outbound bridge: target unresolved from conversationId — hanging up');
      // D12 (spec 6.3): no <Dial> runs on this path, so no <Dial action>
      // summary will ever arrive to close the call out. Stamp a TERMINAL
      // call_status with NO call_outcome - we know the call did not complete,
      // we do not know an outcome, and inventing one is the false attribution
      // this exists to prevent. Best-effort: the leg must end even if the write
      // fails. The row may not exist yet (originateCall appends best-effort and
      // may have failed) - updateCallStatus is a no-op there, reporting
      // transitioned:false with no row, never an error.
      if (parentCallSid.length > 0) {
        let stamp: CallStatusUpdate | undefined;
        try {
          // The refusal stamp may transition ONLY from `ringing`. `canceled` is
          // legal from `in-progress` in the forward-only machine (a genuine
          // mid-call cancel is a real thing), so the narrowing belongs to THIS
          // stamp rather than to the machine: a REDELIVERED refusal arriving
          // after press-1 already succeeded would otherwise terminate a LIVE
          // call and - terminal states being absorbing - permanently lock out
          // the authoritative <Dial action> summary. The expectation rides the
          // repo's atomic condition; a pre-read plus an if-check would lose
          // exactly the race it is meant to close.
          stamp = await messages.updateCallStatus(
            parentCallSid,
            { callStatus: 'canceled' },
            { expectedPriorCallStatuses: ['ringing'] },
          );
        } catch (err) {
          log.warn(
            { err, callSid: parentCallSid },
            'outbound bridge: stamping the refused call canceled failed (best-effort) - continuing',
          );
        }
        // The navigator may have this contact's timeline OPEN - originateCall
        // emitted message.persisted on the append that put the "Ringing..."
        // card on screen. The timeline refetches ONLY on message.persisted /
        // conversation.updated, so a silent stamp leaves that open card on the
        // stale `ringing` row, which flips to "No team answer" at t+90s - the
        // exact false attribution D12 exists to remove, on the one surface
        // anyone is watching. Emit ONLY when the stamp actually transitioned;
        // a no-op against a missing row announces nothing. Deliberately NO
        // stampCallActivity and NO conversation.updated: spec 6.4 promises the
        // inbox row is left exactly as it is. The conversationId comes off the
        // STAMPED ROW, not the query string - this branch runs precisely
        // because the query's conversation did not resolve - and it comes off
        // the row `updateCallStatus` ALREADY resolved, so the announce costs no
        // read. Its OWN catch: the announce only ever runs after the
        // conditional write COMMITTED, so folding it into the stamp's catch
        // would log "the stamp failed" for a row that is perfectly `canceled`
        // and send an operator hunting in the write path. Both stay
        // best-effort - neither may break the hangup.
        if (stamp?.transitioned === true && stamp.row !== undefined) {
          try {
            announceCallStamp(stamp.row);
          } catch (err) {
            log.warn(
              { err, callSid: parentCallSid },
              'outbound bridge: announcing the refusal stamp failed (best-effort) - the canceled stamp itself COMMITTED; only the live timeline push was lost',
            );
          }
        }
      }
      sendTwiml(
        res,
        maskedSayHangup(resolveMessage('voice.outbound_unavailable')),
      );
      return;
    }

    // The whisper + press-1 gate on the NAVIGATOR leg (mirrors /voice/whisper).
    // We build the SAME <Gather numDigits=1 timeout=8 action=<gate>> + <Hangup>
    // shape; the gate URL carries the opaque conversationId (+ outbound=1). The
    // announced label is the masked contact (role/name) — NEVER a phone.
    const gateUrl =
      `${baseUrl}/webhooks/twilio/voice/whisper-gate` +
      `?conversationId=${encodeURIComponent(conversationId)}` +
      `&parentCallSid=${encodeURIComponent(parentCallSid)}` +
      `&outbound=1`;
    const vr = new VoiceResponse();
    const gather = vr.gather({ numDigits: 1, timeout: 8, action: gateUrl, method: 'POST' });
    gather.say(resolveMessage('voice.whisper_outbound', { targetLabel: target.label }));
    // No input within the timeout → hang up (never auto-bridge — press-1 is the
    // explicit accept that blocks the navigator's carrier voicemail).
    vr.hangup();
    log.info(
      { callSid: parentCallSid, outbound: true },
      'outbound bridge: whisper played on navigator leg (press-1 to connect)',
    );
    sendTwiml(res, vr);
  });

  // ---------------------------------------------------------------------
  // Whisper — POST /voice/whisper. Runs on the CALLEE leg (the <Number url>).
  // A terse masked announcement + a press-1 gate (Gather → /voice/whisper-gate).
  // The gather carries forward the context via the gate's query string. On no
  // input the Gather falls through to <Hangup> (we do NOT auto-bridge — pressing
  // 1 is the explicit accept that blocks carrier voicemail from "answering").
  // ---------------------------------------------------------------------
  router.post('/whisper', verifySignature, (req, res) => {
    const params = asParams(req.body);
    const q = req.query as Record<string, string | undefined>;
    const callerLabel =
      typeof q['callerLabel'] === 'string' ? q['callerLabel'] : resolveMessage('voice.caller_label_default');
    const conversationId = typeof q['conversationId'] === 'string' ? q['conversationId'] : '';
    const parentCallSid = typeof q['parentCallSid'] === 'string' ? q['parentCallSid'] : (params['CallSid'] ?? '');
    // leg=founder selects the founder-bridge whisper copy (M1.9b). Both legs
    // now offer the same single choice: press-1 to accept (the gate that
    // blocks carrier voicemail).
    const isFounderLeg = q['leg'] === 'founder';
    if (conversationId.length > 0) mergeContext({ conversationId });

    // Carry leg forward to the gate so it can log which leg answered.
    const gateUrl =
      `${baseUrl}/webhooks/twilio/voice/whisper-gate` +
      `?conversationId=${encodeURIComponent(conversationId)}` +
      `&parentCallSid=${encodeURIComponent(parentCallSid)}` +
      (isFounderLeg ? '&leg=founder' : '');

    const vr = new VoiceResponse();
    const gather = vr.gather({
      numDigits: 1,
      timeout: 8,
      action: gateUrl,
      method: 'POST',
    });
    // Masked announcement: the caller's ROLE/name only — NEVER a phone (PII).
    // Press 1 to accept (gates the bridge, blocks carrier voicemail). That is
    // the ONLY offered key on both legs; anything else falls through to hangup.
    gather.say(
      isFounderLeg
        ? resolveMessage('voice.whisper_founder', { callerLabel })
        : resolveMessage('voice.whisper_relay', { callerLabel }),
    );
    // No input within the timeout → fall through to hangup so the bridge is
    // never completed to a carrier voicemail (the caller then hears no-answer).
    vr.hangup();
    log.info(
      { callSid: parentCallSid, masked: !isFounderLeg, leg: isFounderLeg ? 'founder' : 'callee' },
      'whisper played on bridged leg',
    );
    sendTwiml(res, vr);
  });

  // ---------------------------------------------------------------------
  // Whisper gate — POST /voice/whisper-gate. The press-1/timeout decision,
  // stateless (context via the query string). Runs on the CALLEE leg.
  //   Digits == '1' → empty/<Pause> TwiML → the bridge PROCEEDS (callee accepted)
  //   else          → <Hangup> the callee leg (caller hears masked no-answer,
  //                   never the carrier voicemail)
  // ---------------------------------------------------------------------
  router.post('/whisper-gate', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const q = req.query as Record<string, string | undefined>;
    const digits = params['Digits'];
    const conversationId = typeof q['conversationId'] === 'string' ? q['conversationId'] : '';
    const parentCallSid = typeof q['parentCallSid'] === 'string' ? q['parentCallSid'] : (params['CallSid'] ?? '');
    // Founder-bridge leg (M1.9b). The gate treats both legs identically now;
    // this only labels the log line. A non-accept on the founder leg still
    // falls through to hangup (→ MISSED → the status handler fires the
    // missed-call push + auto-text).
    const isFounderLeg = q['leg'] === 'founder';
    // Outbound-bridge leg (Voice Phase 1, spec §5): the navigator's press-1
    // ORIGINATES the leg to the target (a <Dial>), rather than accepting an
    // already-dialed inbound leg (a <Pause>). Marked by outbound=1 on the gate.
    const isOutboundLeg = q['outbound'] === '1';
    if (conversationId.length > 0) mergeContext({ conversationId });

    const vr = new VoiceResponse();
    if (digits === '1' && isOutboundLeg) {
      // OUTBOUND accept: resolve the target AGAIN from the opaque conversationId
      // (never from the URL — no phone in the URL), then <Dial> it FROM the
      // BUSINESS number (the masking invariant: the target sees the business
      // number, NEVER the navigator's cell). record-from-answer-dual so the
      // outbound call RECORDS like the founder-bridge; the <Dial action> reports
      // the terminal outcome to /voice/status by the PARENT (originated) CallSid.
      const target = await resolveOutboundTarget(conversationId);
      const businessCallerId = config.businessPhoneNumber;
      if (target === undefined || businessCallerId === undefined) {
        vr.hangup();
        log.warn(
          { callSid: parentCallSid, outbound: true },
          'outbound whisper gate: target/business number unresolved — hanging up',
        );
        // D12 (spec 6.3): the navigator answered and pressed 1, then the system
        // refused to dial. No <Dial> runs, so no Dial summary ever closes this
        // call out - stamp a TERMINAL call_status with NO call_outcome (see the
        // /outbound-bridge branch above). Best-effort; never breaks the hangup.
        if (parentCallSid.length > 0) {
          let stamp: CallStatusUpdate | undefined;
          try {
            // Refusal stamp: ONLY from `ringing` (see the /outbound-bridge
            // branch above). A redelivered refusal must never terminate a call
            // that press-1 already took LIVE, nor lock out its Dial summary.
            stamp = await messages.updateCallStatus(
              parentCallSid,
              { callStatus: 'canceled' },
              { expectedPriorCallStatuses: ['ringing'] },
            );
          } catch (err) {
            log.warn(
              { err, callSid: parentCallSid },
              'outbound whisper gate: stamping the refused call canceled failed (best-effort) - continuing',
            );
          }
          // Announce the stamp so an OPEN contact timeline refetches instead
          // of sitting on the stale ringing card (see the /outbound-bridge
          // branch above). Transition-gated, inbox untouched, announced from
          // the row the stamp ALREADY resolved (no extra read), and caught
          // SEPARATELY so an announce failure is never reported as a failed
          // stamp - by then the write has already committed.
          if (stamp?.transitioned === true && stamp.row !== undefined) {
            try {
              announceCallStamp(stamp.row);
            } catch (err) {
              log.warn(
                { err, callSid: parentCallSid },
                'outbound whisper gate: announcing the refusal stamp failed (best-effort) - the canceled stamp itself COMMITTED; only the live timeline push was lost',
              );
            }
          }
        }
        sendTwiml(res, vr);
        return;
      }
      // DNC RE-CHECK at dial time (docs/issues/voice-bridge-dnc-recheck.md):
      // the originate service refused voice_opt_out pre-dial, but staff can set
      // the flag in the seconds between originate and this press-1 — the flag
      // was just re-read from the contact, so honor it and hang up INSTEAD of
      // dialing. NO status callback ever arrives on this path - the leg simply
      // ends without a <Dial>, so nothing else would ever close the call out;
      // the D12 stamp below is what does. IDs-only log - never a phone.
      if (target.optedOut) {
        vr.hangup();
        log.info(
          { callSid: parentCallSid, outbound: true },
          'outbound whisper gate: target opted out mid-ring (voice_opt_out) — hanging up, not dialing',
        );
        // D12 (spec 6.3): TERMINAL call_status, NO call_outcome. On this branch
        // in particular an invented outcome would read as staff negligence when
        // the truth is that the contact is opted out of voice. Best-effort;
        // never breaks the hangup.
        if (parentCallSid.length > 0) {
          let stamp: CallStatusUpdate | undefined;
          try {
            // Refusal stamp: ONLY from `ringing` (see the /outbound-bridge
            // branch above). A redelivered refusal must never terminate a call
            // that press-1 already took LIVE, nor lock out its Dial summary.
            stamp = await messages.updateCallStatus(
              parentCallSid,
              { callStatus: 'canceled' },
              { expectedPriorCallStatuses: ['ringing'] },
            );
          } catch (err) {
            log.warn(
              { err, callSid: parentCallSid },
              'outbound whisper gate: stamping the refused call canceled failed (best-effort) - continuing',
            );
          }
          // Announce the stamp so an OPEN contact timeline refetches instead
          // of sitting on the stale ringing card (see the /outbound-bridge
          // branch above). Transition-gated, inbox untouched, announced from
          // the row the stamp ALREADY resolved (no extra read), and caught
          // SEPARATELY so an announce failure is never reported as a failed
          // stamp - by then the write has already committed.
          if (stamp?.transitioned === true && stamp.row !== undefined) {
            try {
              announceCallStamp(stamp.row);
            } catch (err) {
              log.warn(
                { err, callSid: parentCallSid },
                'outbound whisper gate: announcing the refusal stamp failed (best-effort) - the canceled stamp itself COMMITTED; only the live timeline push was lost',
              );
            }
          }
        }
        sendTwiml(res, vr);
        return;
      }
      // Mark the bridge accepted NOW (press-1 is the authoritative "answered"
      // signal, same as the inbound legs). Best-effort.
      if (parentCallSid.length > 0) {
        let stamp: CallStatusUpdate | undefined;
        try {
          stamp = await messages.updateCallStatus(parentCallSid, {
            callStatus: 'in-progress',
            answeredAt: new Date().toISOString(),
          });
        } catch (err) {
          log.warn(
            { err, callSid: parentCallSid },
            'outbound whisper gate: marking the bridge accepted failed (best-effort) — continuing',
          );
        }
        // The ACCEPTANCE half of the same live-surface problem the refusal
        // announcements solve. The navigator who originated this call is
        // looking at the "Ringing..." card originateCall emitted, and the
        // timeline refetches ONLY on message.persisted / conversation.updated
        // - so a silent accept leaves that card on the stale `ringing` row until it
        // flips to a red "No team answer" at t+90s WHILE THEY ARE ON THE CALL.
        // Transition-gated exactly like the refusal announces (a no-op write
        // announces nothing), and message.persisted ONLY: spec 6.4 promises the
        // inbox row is left exactly as it is, so no stampCallActivity and no
        // conversation.updated. Its OWN catch, with its OWN message: by the time
        // the announce runs the accept has already COMMITTED, so logging this as
        // a failed stamp would send an operator hunting in the write path.
        // Both stay best-effort - neither may break an accepted bridge. The
        // row comes from the stamp itself: nothing may be read between press-1
        // and the <Dial> below (fix wave 4, N-1).
        if (stamp?.transitioned === true && stamp.row !== undefined) {
          try {
            announceCallStamp(stamp.row);
          } catch (err) {
            log.warn(
              { err, callSid: parentCallSid },
              'outbound whisper gate: announcing the accepted bridge failed (best-effort) - the in-progress stamp itself COMMITTED; only the live timeline push was lost',
            );
          }
        }
      }
      const dial = vr.dial({
        callerId: businessCallerId,
        record: 'record-from-answer-dual',
        recordingStatusCallback: `${baseUrl}/webhooks/twilio/voice/recording`,
        recordingStatusCallbackEvent: ['completed'],
        recordingStatusCallbackMethod: 'POST',
        answerOnBridge: true,
        action: `${baseUrl}/webhooks/twilio/voice/status`,
        method: 'POST',
      });
      // The target rides ONLY inside <Number> — never a TwiML URL. No per-leg
      // whisper on the target (the navigator already accepted).
      dial.number(target.targetPhone);
      log.info(
        { callSid: parentCallSid, gate: 'accept', outbound: true, callerIdIsBusiness: true, recording: true },
        'outbound whisper gate: accepted (1) — dialing target from the business number',
      );
      sendTwiml(res, vr);
      return;
    }
    if (digits === '1') {
      // Accept: returning <Pause> (not an empty doc) keeps the bridged leg on
      // the line so Twilio bridges it to the caller. The bridge proceeds.
      vr.pause({ length: 1 });
      // Press-1 is the AUTHORITATIVE "answered" signal — mark the call answered
      // NOW (call_status in-progress + answered_at). This, NOT the <Dial>
      // duration, is what the /status handler uses to decide answered-vs-missed:
      // a carrier voicemail answering the leg yields a non-zero Dial duration
      // but NEVER presses 1, so duration alone misclassified voicemail as
      // "answered" (the 2026-06-15 loop bug). Best-effort — a write failure must
      // never break an accepted bridge; the call simply falls back to the status
      // handler's terminal classification.
      if (parentCallSid.length > 0) {
        let stamp: CallStatusUpdate | undefined;
        try {
          stamp = await messages.updateCallStatus(parentCallSid, {
            callStatus: 'in-progress',
            answeredAt: new Date().toISOString(),
          });
        } catch (err) {
          log.warn(
            { err, callSid: parentCallSid },
            'whisper gate: marking the bridge accepted failed (best-effort) — continuing',
          );
        }
        // Announce the accept so an OPEN contact timeline refetches instead of
        // sitting on the stale ringing card and flipping it to a red "Missed"
        // at t+90s while the call is CONNECTED (see the outbound arm above).
        // Transition-gated, inbox untouched (spec 6.4: message.persisted ONLY,
        // no stampCallActivity, no conversation.updated), and caught SEPARATELY
        // so an announce failure is never reported as a failed stamp - by then
        // the write has already committed. Best-effort on both halves: neither
        // may break an accepted bridge. The row comes from the stamp itself -
        // NOTHING may be read between press-1 and the bridge (fix wave 4, N-1),
        // and this arm also serves every MASKED relay bridge, whose open Relay
        // Timeline now consumes the same lifecycle refresh.
        if (stamp?.transitioned === true && stamp.row !== undefined) {
          try {
            announceCallStamp(stamp.row);
          } catch (err) {
            log.warn(
              { err, callSid: parentCallSid },
              'whisper gate: announcing the accepted bridge failed (best-effort) - the in-progress stamp itself COMMITTED; only the live timeline push was lost',
            );
          }
        }
      }
      log.info(
        { callSid: parentCallSid, gate: 'accept', leg: isFounderLeg ? 'founder' : 'callee' },
        'whisper gate: accepted (1) — bridging',
      );
      sendTwiml(res, vr);
      return;
    }
    // Timeout, or ANY key other than the accept, on ANY leg -> hang up the
    // bridged leg so the caller hears a no-answer (the press-1 gate is exactly
    // what blocks the leg's carrier voicemail from silently "answering" the
    // bridge). '0' is not special: the team escape was removed
    // (docs/issues/press-0-team-escape-removed.md).
    vr.hangup();
    log.info(
      { callSid: parentCallSid, gate: 'hangup', leg: isFounderLeg ? 'founder' : 'callee' },
      'whisper gate: no accept — hanging up bridged leg',
    );
    sendTwiml(res, vr);
  });

  // ---------------------------------------------------------------------
  // Call status callback — POST /voice/status. TWO distinct callback shapes hit
  // this URL (both bridges wire both):
  //   (a) the <Dial action> summary — carries DialCallStatus/DialCallDuration on
  //       the PARENT CallSid. This is AUTHORITATIVE for whether the BRIDGE
  //       connected (and for how long), so it — and ONLY it — derives the
  //       terminal outcome, the bridge call_duration, answered_at, and the
  //       founder-bridge MISSED trigger (FIX 1).
  //   (b) the per-<Number statusCallback> child leg — carries ParentCallSid and
  //       NO DialCallStatus. It describes the founder/callee LEG (the whisper
  //       answer), NOT the bridge, so it MUST NOT classify answered/missed,
  //       stamp answered_at, or fire the missed trigger. (We also drop
  //       'completed'/'answered' from the per-leg statusCallbackEvent lists so
  //       Twilio reports the terminal outcome ONLY via the <Dial action> — this
  //       handler logic is the belt-and-braces guarantee.)
  // Update the `call` entry by CallSid, forward-only + idempotent: a
  // redelivered/out-of-order callback never regresses a terminal call or
  // double-counts. Emit message.persisted so the hub timeline updates live.
  // NEVER log raw numbers.
  // ---------------------------------------------------------------------
  router.post('/status', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    // NOTE (FIX 1): CallDuration (the per-leg/top-level duration) is deliberately
    // NOT read — only the <Dial action> summary's DialCallDuration is the bridge
    // duration. A child leg's CallDuration is whisper/leg seconds, not the call.
    const { CallSid, CallStatus, DialCallStatus, DialCallDuration } = params;
    // The <Number statusCallback> fires on a CHILD leg (its own CallSid) and
    // carries ParentCallSid pointing at the call entry's CallSid; the <Dial
    // action> + the call's own callback carry the call entry's CallSid directly.
    // Prefer the parent when present so every callback updates the ONE call
    // entry keyed by the original (parent) CallSid.
    const entryCallSid = params['ParentCallSid'] ?? CallSid;
    if (!entryCallSid) {
      log.warn({ hasCallSid: Boolean(CallSid) }, 'twilio voice status callback missing CallSid — rejected');
      res.status(400).json({ error: 'bad request' });
      return;
    }

    // (FIX 1) The presence of DialCallStatus is what distinguishes the two
    // shapes: a <Dial action> summary carries it; a per-leg child callback does
    // not. The <Dial action> is the BRIDGE outcome (authoritative); a per-leg
    // callback describes only the dialed LEG (whisper answer), so it can never
    // decide answered/missed for the bridge.
    const isDialSummary = DialCallStatus !== undefined;
    const rawStatus = DialCallStatus ?? CallStatus;
    const mapped = mapCallStatus(rawStatus);
    if (mapped === undefined) {
      // A status we don't model (e.g. 'queued'/'initiated') — ack so Twilio
      // stops, but make no change.
      log.info({ callSid: entryCallSid, providerStatus: rawStatus ?? null }, 'voice status callback: unmodeled status — ignored');
      sendTwiml(res, new VoiceResponse()); // valid (empty) TwiML — this URL is also the <Dial action>
      return;
    }

    const terminal = mapped !== 'ringing' && mapped !== 'in-progress';

    // (FIX 1) A per-leg child callback (no DialCallStatus) describes the dialed
    // LEG, not the bridge — it must NEVER drive the call to a TERMINAL status.
    // Doing so would not only mis-describe the bridge, it would LOCK OUT the
    // authoritative <Dial action> summary (the call-status machine is forward-
    // only and terminal-absorbing, so a premature child `completed` makes the
    // real Dial `completed` a no-op, suppressing the missed push + auto-text).
    // So we ignore a terminal per-leg callback entirely; the Dial summary owns
    // the terminal outcome. (We also drop these events at the <Number> so this
    // is belt-and-braces.)
    if (!isDialSummary && terminal) {
      log.info(
        { callSid: entryCallSid, providerStatus: rawStatus },
        'voice status callback: terminal per-leg (non-Dial) status — ignored (bridge outcome comes from the Dial summary)',
      );
      sendTwiml(res, new VoiceResponse()); // valid (empty) TwiML — this URL is also the <Dial action>
      return;
    }

    // The <Dial action> summary's DialCallDuration (informational only now — the
    // miss decision no longer keys on it). A per-leg child callback's
    // CallDuration is whisper/leg seconds, not the bridge, so it's ignored.
    const dialDurationRaw = isDialSummary ? DialCallDuration : undefined;
    const dialDuration =
      dialDurationRaw !== undefined && dialDurationRaw.length > 0 ? Number(dialDurationRaw) : undefined;
    const callDuration = dialDuration !== undefined && Number.isFinite(dialDuration) ? dialDuration : undefined;
    const now = new Date().toISOString();

    // ANSWERED-vs-MISSED is decided by whether the bridge was ACCEPTED (the
    // press-1 whisper gate stamps answered_at the instant it is; a Dial
    // in-progress callback, below, is the only other source), NOT the <Dial>
    // duration. So a TERMINAL <Dial action> summary is a MISS unless answered_at
    // is already set — regardless of DialCallStatus/duration. THIS is the
    // carrier-voicemail fix:
    // voicemail answering the founder leg yields a non-zero Dial duration with
    // NO press-1, which the old duration heuristic misread as "answered" — which
    // suppressed the missed push/auto-text AND the caller goodbye, leaving a VoIP
    // caller's leg unanswered so it auto-redialed in a loop (2026-06-15). A
    // per-leg child callback (non-terminal here) never classifies — transitional.
    let entry: MessageItem | undefined;
    let bridgeAccepted = false;
    if (isDialSummary && terminal) {
      entry = await messages.getByProviderSid(entryCallSid);
      bridgeAccepted = typeof entry?.answered_at === 'string' && entry.answered_at.length > 0;
    }
    const isMissed = isDialSummary && terminal && !bridgeAccepted;
    // A non-terminal Dial summary that reports the bridge CONNECTED
    // (in-progress / 'answered') is the OTHER valid "answered" signal alongside
    // the press-1 gate — and it's voicemail-safe: with answerOnBridge the <Dial>
    // only goes in-progress once the gate accepts, so a voicemail (which never
    // presses 1, never bridges) never produces it. Stamp answered_at so the
    // later terminal summary classifies the call answered.
    const stampAnsweredAt = isDialSummary && mapped === 'in-progress';
    const stampEndedAt = isDialSummary && terminal;
    // 'answered' as soon as the bridge connects (in-progress, even mid-call);
    // on a terminal summary, answered iff the bridge was ever accepted, else missed.
    const outcome = stampAnsweredAt
      ? 'answered'
      : isDialSummary && terminal
        ? bridgeAccepted
          ? 'answered'
          : 'missed'
        : undefined;

    // OUTBOUND SUBSTITUTION (spec 6.2, invariant I1). On an originate the
    // whisper gate stamps answered_at on the NAVIGATOR's own leg at press-1,
    // BEFORE the target's phone rings, so `bridgeAccepted` describes the
    // navigator and never the target. The <Dial action> summary DOES describe
    // the target leg, so for a TERMINAL outbound Dial summary the stored
    // outcome and duration come from `mapped` instead. Every conjunct below is
    // load-bearing:
    //   - `terminal`: on a NON-terminal ('in-progress') summary `mapped` is not
    //     'completed', so this rule would store 'missed' for a call that just
    //     bridged. (`entry` is likewise fetched only under isDialSummary &&
    //     terminal, so the two guards must stay in step.)
    //   - `type === 'call'` / `masked !== true`: mirror the preview guard below.
    //     Every masked row is inbound today (I7); restated so a future masked
    //     outbound writer cannot silently inherit this rule.
    //   - `direction === 'outbound'`: INBOUND is byte-identical to before and
    //     keeps reading `bridgeAccepted`, where press-1 IS authoritative (the
    //     whisper gate exists to block carrier voicemail, which cannot press 1).
    // An undefined `entry` (unknown CallSid) falls through to the old behavior.
    //
    // NAMED DIVERGENCE (spec 6.2): a rung-out outbound call now stores
    // call_outcome: 'missed' while THIS SAME invocation computes
    // `isMissed === false` (answered_at is set, so `bridgeAccepted` is true).
    // The two notions of "missed" now disagree inside one function. Nothing
    // changes behaviorally because every consumer of `isMissed` is
    // direction-gated: the unread rule below (`fresh.direction === 'inbound'`),
    // the missed-founder-bridge trigger below (`fresh.direction !==
    // 'outbound'`), and the TwiML voicemail offer at the tail of this handler
    // (`entry.direction !== 'outbound'`). The next reader of `isMissed` on an
    // OUTBOUND path must NOT inherit that trap - read the stored outcome.
    const outboundSubstituted =
      isDialSummary &&
      terminal &&
      entry?.type === 'call' &&
      entry?.masked !== true &&
      entry?.direction === 'outbound';
    const storedOutcome = outboundSubstituted ? (mapped === 'completed' ? 'answered' : 'missed') : outcome;
    const storedDuration = (outboundSubstituted ? mapped === 'completed' : bridgeAccepted) ? callDuration : undefined;

    // Only the transition flag is read here: this handler already holds `entry`
    // (fetched for the terminal classification above) and re-resolves `fresh`
    // for the non-terminal case, so the row the repo hands back adds nothing
    // on this path.
    const { transitioned } = await messages.updateCallStatus(entryCallSid, {
      callStatus: mapped,
      ...(storedOutcome !== undefined && { callOutcome: storedOutcome }),
      ...(stampAnsweredAt && { answeredAt: now }),
      ...(stampEndedAt && { endedAt: now }),
      // A MISS has no meaningful talk time - only record a duration when the
      // call actually connected: inbound, that is the accepted bridge; outbound,
      // it is the Dial summary reporting 'completed' (the substitution above).
      ...(storedDuration !== undefined && { callDuration: storedDuration }),
    });
    log.info(
      { callSid: entryCallSid, providerStatus: rawStatus, callStatus: mapped, isDialSummary, transitioned },
      'twilio voice status callback processed',
    );

    if (transitioned) {
      // Resolve the entry's conversation so the SSE event carries it (the hub
      // timeline re-renders the call row live). Reuse the snapshot fetched for
      // the terminal classification above; for a transition without one (a
      // non-terminal in-progress), fetch it now.
      const fresh = entry ?? (await messages.getByProviderSid(entryCallSid));
      if (fresh) {
        mergeContext({ conversationId: fresh.conversationId });
        // INBOX (inbound-calls-invisible-in-inbox): a Dial-summary transition
        // on a founder-bridge / outbound call re-stamps the thread with the
        // outcome preview ("Missed call", "Call - 12m 3s", "Outgoing call - no
        // answer", ...) and, for an INBOUND terminal MISS only, marks it
        // unread. Gated on `transitioned` (forward-only machine) so a
        // redelivered summary never double-counts, and on the Dial summary so
        // a per-leg child callback never writes. Masked relay legs are a
        // non-goal (their thread carries roster semantics, not staff unread).
        // Uses the LOCAL outcome/duration - `fresh` may be the pre-transition
        // snapshot fetched for classification.
        //
        // OUTBOUND asymmetry (adversarial r2 HIGH 1): the outbound whisper gate
        // runs on the NAVIGATOR's own leg and stamps answered_at BEFORE the
        // target's phone rings, so `bridgeAccepted`/`outcome` say "answered"
        // for every outbound call that got as far as a <Dial> - including one
        // the target never picked up. The PREVIEW therefore reads the Dial
        // summary's own status, which on an outbound leg describes the target:
        // completed = the target answered, anything else = no answer. As of
        // spec 6.2 the STORED call_outcome reads the same signal (the outbound
        // substitution above the write - it closes
        // docs/issues/outbound-call-outcome-answered-before-target-rings.md),
        // so the two agree on a terminal summary. The one-line ternary below is
        // duplicated ON PURPOSE rather than shared: it keys on `fresh` and also
        // runs on NON-terminal summaries, where `entry` - and therefore the
        // stored substitution - is undefined. (An outbound Dial in-progress
        // summary normally never transitions here - the gate already wrote
        // in-progress - and callPreview renders "in progress" from callStatus
        // regardless.)
        let touched: ConversationItem | undefined;
        if (isDialSummary && fresh.type === 'call' && fresh.masked !== true) {
          const outbound = fresh.direction === 'outbound';
          const previewOutcome = outbound ? (mapped === 'completed' ? 'answered' : 'missed') : outcome;
          const previewDuration = (outbound ? mapped === 'completed' : bridgeAccepted) ? callDuration : undefined;
          touched = await stampCallActivity(
            fresh.conversationId,
            callPreview({
              direction: fresh.direction,
              callStatus: mapped,
              ...(previewOutcome !== undefined && { callOutcome: previewOutcome }),
              ...(previewDuration !== undefined && { callDuration: previewDuration }),
            }),
            now,
            // Fail CLOSED: only an explicitly inbound miss is unread.
            isMissed && fresh.direction === 'inbound',
            entryCallSid,
          );
        }
        events.emit('message.persisted', {
          conversationId: fresh.conversationId,
          tsMsgId: fresh.tsMsgId,
          direction: fresh.direction,
          deliveryStatus: fresh.delivery_status,
        });
        if (touched) events.emit('conversation.updated', toConversationUpdatedEvent(touched));

        // MISSED FOUNDER-BRIDGE (M1.9b): a founder-bridge call (masked:false)
        // whose <Dial action> summary just transitioned it into a terminal MISS
        // → fire the missed-call push + the zero-tap auto-text. `isMissed` is
        // derived (above) ONLY from the <Dial action> summary (FIX 1: gated on
        // isDialSummary + terminal), so a per-leg child callback can NEVER fire
        // it. The block is also gated on `transitioned` (the forward-only call-
        // status write) so only the FIRST callback that moves the call into a
        // terminal miss returns true — a redelivered/stale callback never
        // re-triggers (and the auto-text job is ALSO CallSid-idempotent as a
        // second layer).
        if (isMissed && fresh.type === 'call' && fresh.masked !== true && fresh.direction !== 'outbound') {
          await onFounderBridgeMissed(entryCallSid, fresh.conversationId);
        }
      }
    }

    // /status is ALSO the <Dial action> URL (the founder/relay bridges above):
    // when the bridge ends, Twilio fetches it and drives the CALLER's onward
    // call from the TwiML we return. An empty/non-TwiML 200 here made Twilio
    // play its generic "an application error has occurred" to the caller on a
    // no-answer (the action fired with no TwiML to continue). Answer with valid
    // TwiML. On a MISS:
    //  - INBOUND founder-bridge (business line, masked:false) -> OFFER A VOICEMAIL
    //    (voice-transcription spec 4.1): a prompt + <Record> whose recording rides
    //    the EXISTING recordingStatusCallback (/voice/recording), where it is
    //    classified as a voicemail; then thanks + hangup on the Record action. The
    //    miss-time missed push + auto-text already fired above (before any message).
    //  - masked relay OR outbound miss -> today's brief goodbye + hangup (spec
    //    decision 3: voicemail is BUSINESS LINE ONLY; masked calls never record).
    // On an answered/completed bridge (or a per-leg statusCallback, whose response
    // Twilio ignores) an empty <Response/> ends the call cleanly. Never leaks the
    // caller's number (no <Number>/callerId echoed here). Identify the call with
    // `entry` (NOT `fresh`, which is scoped to the transitioned block above) - it
    // is populated for every terminal Dial summary, i.e. whenever isMissed is true;
    // the guard matches the onFounderBridgeMissed side-effect guard exactly.
    const reply = new VoiceResponse();
    if (isMissed && entry?.type === 'call' && entry.masked !== true && entry.direction !== 'outbound') {
      reply.say(resolveMessage('voice.voicemail_prompt'));
      reply.record({
        maxLength: VOICEMAIL_MAX_LENGTH_SECONDS,
        // SILENCE timeout, NOT a length cap - `maxLength` is the cap. Twilio's
        // DEFAULT IS 5s, and it starts counting the moment <Record> begins, so a
        // caller who waits for the tone and then gathers their thoughts is cut
        // off mid-thought with nothing usable captured. Observed live on prod
        // 2026-08-15: a voicemail ended at EXACTLY 5s and transcribed to an
        // empty string, while the answered-bridge recordings either side of it
        // (98s and 76s) transcribed fine - the tell that this is the record
        // path's own default and not a VI or audio problem.
        timeout: VOICEMAIL_SILENCE_TIMEOUT_SECONDS,
        playBeep: true,
        action: `${baseUrl}/webhooks/twilio/voice/voicemail-done`,
        recordingStatusCallback: `${baseUrl}/webhooks/twilio/voice/recording`,
        recordingStatusCallbackEvent: ['completed'],
      });
      // Reached only if <Record> falls through without a recording (caller hung up
      // before the beep) - the recording, if any, arrives via the callback above.
      reply.say(resolveMessage('voice.voicemail_thanks'));
      reply.hangup();
    } else if (isMissed) {
      reply.say(resolveMessage('voice.missed_call_goodbye'));
      reply.hangup();
    }
    sendTwiml(res, reply);
  });

  // ---------------------------------------------------------------------
  // Recording status callback — POST /voice/recording (M1.9c). Twilio POSTs the
  // RecordingStatusCallback here once the founder-bridge recording is
  // 'completed'. Resolve the `call` entity by CallSid; it MUST be a
  // founder-bridge (masked:false) call — a masked:true relay call (or a missing
  // entry) is logged + IGNORED, and we NEVER fetch the media for it (the masked
  // guardrail). Fetch the recording media authenticated (SSRF-guarded,
  // size-capped — the MMS path's Twilio-auth fetch) and stream it to S3 under
  // recordings/<callSid>/<recordingSid>, then stamp recording_s3_key + duration
  // (idempotent per RecordingSid: a redelivered callback never re-fetches or
  // re-stores). Emit message.persisted so the timeline shows the recording.
  // PII (doc §9): IDs/SIDs/durations only — NEVER the RecordingUrl content.
  // ---------------------------------------------------------------------
  router.post('/recording', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const { CallSid, RecordingSid, RecordingStatus, RecordingUrl, RecordingDuration } = params;
    const entryCallSid = params['ParentCallSid'] ?? CallSid;
    if (!entryCallSid || !RecordingSid) {
      log.warn(
        { hasCallSid: Boolean(entryCallSid), hasRecordingSid: Boolean(RecordingSid) },
        'twilio recording callback missing CallSid/RecordingSid — rejected',
      );
      res.status(400).json({ error: 'bad request' });
      return;
    }
    // Only act on the terminal 'completed' status (we register only that event,
    // but be defensive against a redelivered in-progress/absent).
    if (RecordingStatus !== undefined && RecordingStatus !== 'completed') {
      log.info({ callSid: entryCallSid, recordingStatus: RecordingStatus }, 'recording callback: non-completed status — ignored');
      res.status(200).end();
      return;
    }

    // Resolve the call entity by CallSid. It MUST be a founder-bridge call —
    // masked relay calls are NEVER recorded, so a masked:true entry (or a stray
    // callback for an unknown CallSid) is ignored WITHOUT fetching the media.
    const entry = await messages.getByProviderSid(entryCallSid);
    if (!entry || entry.type !== 'call') {
      log.warn({ callSid: entryCallSid, recordingSid: RecordingSid }, 'recording callback: no founder-bridge call for CallSid — ignored, no fetch');
      res.status(200).end();
      return;
    }
    if (entry.masked === true) {
      // GUARDRAIL: a masked relay call must never record — refuse even a stray
      // recording callback (never fetch the media).
      log.warn({ callSid: entryCallSid, recordingSid: RecordingSid, masked: true }, 'recording callback for a MASKED call — refused (masked calls are never recorded)');
      res.status(200).end();
      return;
    }
    mergeContext({ conversationId: entry.conversationId });

    // Idempotency layer 1: if this call already carries a recording, a
    // redelivered callback is a no-op — do NOT re-fetch the media. (Layer 2 is
    // the conditional write in setCallRecording, the authority under a race.)
    if (typeof entry.recording_s3_key === 'string' && entry.recording_s3_key.length > 0) {
      log.info({ callSid: entryCallSid, recordingSid: RecordingSid }, 'recording callback: recording already stored — no re-fetch');
      res.status(200).end();
      return;
    }

    // No media URL to fetch, or no media store configured (MEDIA_BUCKET unset,
    // local loop) → record what we can without the mirror, never a crash. PII:
    // never log the URL itself.
    if (RecordingUrl === undefined || RecordingUrl.length === 0) {
      log.warn({ callSid: entryCallSid, recordingSid: RecordingSid }, 'recording callback: no RecordingUrl — nothing to mirror');
      res.status(200).end();
      return;
    }
    if (!mediaStore) {
      const line = 'recording NOT mirrored — MEDIA_BUCKET is not configured';
      if (config.nodeEnv === 'production') log.error({ callSid: entryCallSid, recordingSid: RecordingSid }, line);
      else log.warn({ callSid: entryCallSid, recordingSid: RecordingSid }, line);
      res.status(200).end();
      return;
    }

    const recordingDuration =
      RecordingDuration !== undefined && RecordingDuration.length > 0 ? Number(RecordingDuration) : undefined;
    const duration =
      recordingDuration !== undefined && Number.isFinite(recordingDuration) ? recordingDuration : undefined;

    // Voicemail classification (voice-transcription spec 4.2): a completed
    // recording on a MISSED inbound founder-bridge call IS a voicemail (an
    // answered bridge records on an 'answered' call; the Dial summary always
    // precedes the Record verb, so the outcome is settled first). Masked calls
    // were already refused above; outbound founder-bridge misses take no voicemail.
    const isVoicemail = entry.call_outcome === 'missed' && entry.direction !== 'outbound';
    // A near-empty voicemail (caller hung up at/before the beep) is discarded -
    // not stored, outcome stays 'missed', the miss-time auto-text already fired.
    // BEFORE the claim so nothing is stored. PII: sids + duration only.
    if (isVoicemail && duration !== undefined && duration < 2) {
      log.info(
        { callSid: entryCallSid, recordingSid: RecordingSid, duration },
        'voicemail below minimum duration - discarded',
      );
      res.status(200).end();
      return;
    }
    // The S3 key is fully derivable up front (recordings/<callSid>/<recordingSid>),
    // so we can CLAIM the RecordingSid with its intended key BEFORE the fetch.
    const key = `recordings/${entryCallSid}/${RecordingSid}`;

    // (FIX 4) CLAIM-BEFORE-FETCH: win the RecordingSid with the conditional
    // setCallRecording (attribute_not_exists(recording_sid)) FIRST, then fetch +
    // put ONLY if the claim succeeded. This closes the double-fetch / orphaned-
    // S3-object race: two concurrent first-time deliveries (same or DIFFERENT
    // RecordingSids) can no longer both fetch+put — only the claim WINNER does;
    // the loser short-circuits here without touching the media or S3. (Layer-1
    // early-return above handles the common already-stored redelivery cheaply;
    // this conditional write is the authority under a true race.)
    const claimed = await messages.setCallRecording(entryCallSid, {
      recordingSid: RecordingSid,
      recordingS3Key: key,
      ...(duration !== undefined && { recordingDuration: duration }),
    });
    if (!claimed) {
      // Another callback already claimed/stored a recording for this call — do
      // NOT fetch or put (no double-fetch, no orphan).
      log.info(
        { callSid: entryCallSid, recordingSid: RecordingSid },
        'recording callback: lost the claim (already recorded) — no fetch',
      );
      res.status(200).end();
      return;
    }

    try {
      // Authenticated, SSRF-guarded (api.twilio.com), size-capped fetch — then
      // STREAM to S3 (no whole-body buffering). Same posture as the MMS mirror.
      const stream = await adapter.getRecordingStream(RecordingUrl);
      await mediaStore.put(key, stream, 'audio/mpeg');
    } catch (err) {
      // The fetch/put failed AFTER we claimed — RELEASE the claim so the call
      // entry does not keep a recording key pointing at an object that was never
      // written (and so Twilio's redelivery can re-claim + re-fetch). The
      // release is conditioned on the RecordingSid we claimed, so it never
      // clobbers a different concurrent writer. A refused (SSRF/oversize) or
      // failed fetch must never 5xx the webhook. PII: log reason class + IDs.
      const reason = err instanceof MediaFetchRefusedError ? err.reason : 'fetch_or_store_failed';
      await messages.releaseCallRecording(entryCallSid, RecordingSid);
      log.error({ callSid: entryCallSid, recordingSid: RecordingSid, reason }, 'recording mirror failed — claim released, call entry keeps no recording key');
      res.status(200).end();
      return;
    }

    log.info(
      { callSid: entryCallSid, recordingSid: RecordingSid, recordingDuration: duration, stored: true },
      'founder-bridge recording mirrored to S3',
    );
    // Voicemail outcome upgrade (spec 4.2): promote 'missed' -> 'voicemail' via a
    // CONDITIONAL write (only-if-missed) - which also makes a redelivered recording
    // callback idempotent. On the FIRST delivery (the upgrade won): stamp the
    // inbox, then emit the live update + fire the best-effort "New voicemail"
    // push (never throws; a push failure must not 5xx the callback - the
    // recording is already safe). Answered calls never match; masked already
    // refused. Note the voicemail's inbox re-flag rides this handler, i.e. it is
    // reached only once the recording is mirrored: a mirror failure returns
    // above with the miss still flagged and no voicemail preview (accepted -
    // the outcome upgrade itself has always lived behind the mirror).
    let voicemailUpgraded = false;
    let voicemailTouched: ConversationItem | undefined;
    if (isVoicemail) {
      voicemailUpgraded = await messages.upgradeCallOutcomeToVoicemail(entryCallSid);
      if (voicemailUpgraded) {
        // INBOX: a voicemail is NEW information on a call already counted as a
        // miss - re-stamp "Voicemail" and bump unread AGAIN, deliberately: if
        // staff read the miss and navigated away, the voicemail must re-flag
        // the row (the badge counts rows, so the double only shows on the
        // row's own count). Idempotent via the conditional upgrade above. The
        // stamp lands BEFORE the single message.persisted below (the ordering
        // rule in stampCallActivity's doc): the contact page re-marks read on
        // that event and must see the counter already moved.
        voicemailTouched = await stampCallActivity(
          entry.conversationId,
          callPreview({
            direction: entry.direction,
            callStatus: entry.call_status ?? 'completed',
            callOutcome: 'voicemail',
          }),
          new Date().toISOString(),
          true,
          entryCallSid,
        );
      }
    }
    // The claim succeeded AND the media is in S3 (and any voicemail upgrade +
    // inbox stamp are done) -> ONE announcement of the now-recorded call so the
    // timeline updates live, then the inbox event, then the voicemail push.
    events.emit('message.persisted', {
      conversationId: entry.conversationId,
      tsMsgId: entry.tsMsgId,
      direction: entry.direction,
      deliveryStatus: entry.delivery_status,
    });
    if (voicemailTouched) events.emit('conversation.updated', toConversationUpdatedEvent(voicemailTouched));
    if (voicemailUpgraded) {
      try {
        await sendVoicemailPush(entry.conversationId, entryCallSid);
      } catch (err) {
        log.error({ err, callSid: entryCallSid }, 'voicemail push failed');
      }
    }
    // Create leg (spec 3.2): request VI transcription now that the recording is
    // safely mirrored. Runs for EVERY non-masked founder-bridge recording (bridge
    // AND voicemail); no-op when VI is unconfigured. Masked calls already returned
    // above, so this is never reached for them.
    await requestTranscription(entryCallSid, RecordingSid);
    res.status(200).end();
  });

  // ---------------------------------------------------------------------
  // <Record action> - POST /voice/voicemail-done (voice-transcription 4.1).
  // Fires when the caller finishes the voicemail (# / timeout / hangup mid-record).
  // The voicemail audio itself arrives separately via the recordingStatusCallback
  // (/voice/recording); this route only closes the call politely. Signature-gated
  // like the other voice webhooks.
  router.post('/voicemail-done', verifySignature, (_req, res) => {
    const reply = new VoiceResponse();
    reply.say(resolveMessage('voice.voicemail_thanks'));
    reply.hangup();
    sendTwiml(res, reply);
  });

  // ---------------------------------------------------------------------
  // Voice Intelligence completion webhook - POST /voice/intelligence
  // (voice-transcription spec 3.3). Twilio POSTs a JSON body carrying ONLY a
  // transcript_sid; we trust nothing else and re-fetch the transcript + its
  // sentences from the VI API, join them, and persist via the idempotent
  // setCallTranscript seam (masked refusal + never-overwrite enforced there).
  // Signature-gated by the JSON (bodySHA256) variant. A Twilio API failure mid-
  // flow returns 500 so Twilio redelivers (the idempotent persist makes that
  // safe). PII (doc section 9): NEVER log the transcript text - lengths + sids.
  // ---------------------------------------------------------------------
  router.post('/intelligence', verifyJsonSignature, async (req, res) => {
    const transcriptSid = (req.body as { transcript_sid?: unknown } | undefined)?.transcript_sid;
    if (typeof transcriptSid !== 'string' || transcriptSid.length === 0) {
      // vi-webhook-unrecognized-event-400: Twilio sends SIGNED VI events beyond
      // the transcript-completed shape we process. Observed live on dev: these
      // arrive in Twilio's nested event envelope `{ eventType, timestamp, data }`
      // (NOT our top-level transcript_sid shape - that variant still works and
      // fast-persists), and are NOT correlated with any of our calls/transcripts
      // (no recording callback or inline create precedes them), so nothing is
      // lost by ignoring them. The signature middleware already proved the
      // sender; we ack 200 so Twilio stops retrying, and log - PII-safe - the
      // `eventType` VALUE (a bounded Twilio enum, never call content) plus the
      // top-level and `data` KEY NAMES so the event type is finally identifiable.
      // This is deliberately INFO, not WARN: it is a known, chosen-to-ignore
      // event, not an alertable fault. A shapeless (non-object) body keeps 400.
      const body: unknown = req.body;
      if (typeof body === 'object' && body !== null) {
        const obj = body as Record<string, unknown>;
        const keys = Object.keys(obj);
        // eventType is a Twilio event enum (e.g. voice_intelligence_*), safe to
        // log by value; data key NAMES only (values may carry call content).
        const eventType = typeof obj['eventType'] === 'string' ? (obj['eventType'] as string) : null;
        const dataVal = obj['data'];
        const dataKeys =
          typeof dataVal === 'object' && dataVal !== null
            ? Object.keys(dataVal as Record<string, unknown>).slice(0, 32)
            : null;
        log.info(
          {
            hasTranscriptSid: false,
            eventType,
            keyCount: keys.length,
            keys: keys.slice(0, 32),
            dataKeys,
            contentLength: req.headers['content-length'] ?? null,
          },
          'vi webhook: known non-transcript VI event (no transcript_sid) - acked and ignored',
        );
        res.status(200).end();
        return;
      }
      log.warn({ hasTranscriptSid: false }, 'vi webhook: missing transcript_sid - rejected');
      res.status(400).json({ error: 'bad request' });
      return;
    }
    try {
      await persistViTranscript(
        { adapter, messages, events, logger: log, extraction, aiExtractionEnabled: config.aiExtractionEnabled },
        transcriptSid,
      );
      res.status(200).end();
    } catch (err) {
      log.error({ err, transcriptSid }, 'vi webhook: twilio api failure - 500 for redelivery');
      res.status(500).end();
    }
  });

  /**
   * Create leg (voice-transcription spec 3.2): request VI transcription for a
   * just-mirrored founder-bridge recording. The recording is ALREADY safe, so
   * this can never lose it. No-op when VI is unconfigured. Stamps
   * transcript_status 'pending' BEFORE the inline create (so the "Transcribing..."
   * indicator is correct even while the fallback job retries) and emits SSE.
   * FAST PATH: create the VI transcript inline, then enqueue the ~10min reconcile
   * safety net. FALLBACK: on an inline CREATE failure only, enqueue the
   * createVoiceTranscript job (jobs-pipeline redelivery/DLQ); an enqueue failure
   * there is only logged - it never fails the recording callback. The two try
   * scopes are SPLIT (adjudication F1): once the create has succeeded, a
   * reconcile-enqueue failure is logged and swallowed - falling back to the
   * create job at that point would mint a DUPLICATE VI transcript for the same
   * recording (the job's idempotency guard reads the persisted transcript,
   * which async VI has not delivered yet). The completion webhook still
   * delivers the minted transcript; only that call's lost-webhook self-heal is
   * lost. NEVER called for masked calls (the masked refusal returns earlier).
   * PII (doc section 9): callSid / recordingSid / transcriptSid only.
   */
  async function requestTranscription(entryCallSid: string, recordingSid: string): Promise<void> {
    const serviceSid = config.twilioViServiceSid;
    if (serviceSid === undefined) return;
    // Idempotent stamp; emit regardless of first/repeat so the indicator shows.
    await messages.setTranscriptPending(entryCallSid);
    const fresh = await messages.getByProviderSid(entryCallSid);
    if (fresh) {
      events.emit('message.persisted', {
        conversationId: fresh.conversationId,
        tsMsgId: fresh.tsMsgId,
        direction: fresh.direction,
        deliveryStatus: fresh.delivery_status,
      });
    }
    let transcriptSid: string;
    try {
      ({ transcriptSid } = await adapter.createViTranscript({
        serviceSid,
        recordingSid,
        customerKey: entryCallSid,
      }));
    } catch (err) {
      log.warn({ err, callSid: entryCallSid, recordingSid }, 'inline vi create failed - falling back to job');
      try {
        await enqueue(CREATE_VOICE_TRANSCRIPT_JOB, { callSid: entryCallSid, recordingSid, attempt: 1 });
      } catch (enqueueErr) {
        // No VI transcript exists and no job will ever retry - the pipeline gave
        // up NOW, so close the lifecycle (spec 3.7: 'failed' when the pipeline
        // gives up; a stuck 'pending' would show "Transcribing..." forever) and
        // announce the transition live.
        log.error({ err: enqueueErr, callSid: entryCallSid }, 'vi create fallback enqueue failed');
        const stamped = await messages.setTranscriptFailed(entryCallSid);
        if (stamped) {
          const latest = await messages.getByProviderSid(entryCallSid);
          if (latest) {
            events.emit('message.persisted', {
              conversationId: latest.conversationId,
              tsMsgId: latest.tsMsgId,
              direction: latest.direction,
              deliveryStatus: latest.delivery_status,
            });
          }
        }
      }
      return;
    }
    // The create SUCCEEDED - the transcript exists at Twilio. From here on,
    // NEVER enqueue the create job (duplicate-transcript guard, F1 above).
    try {
      await enqueue(
        RECONCILE_VOICE_TRANSCRIPT_JOB,
        { callSid: entryCallSid, transcriptSid, attempt: 1 },
        { runAt: new Date(Date.now() + config.voiceTranscriptReconcileSeconds * 1000) },
      );
      log.info({ callSid: entryCallSid, transcriptSid }, 'vi transcript requested inline');
    } catch (err) {
      log.error(
        { err, callSid: entryCallSid, transcriptSid },
        'reconcile enqueue failed after successful create',
      );
    }
  }

  /**
   * Side effects when a founder-bridge call is MISSED (M1.9b): the missed-call
   * push to the founder (admin user(s)) + the zero-tap auto-text job. Called at
   * most once per CallSid (gated on the forward-only call-status transition);
   * both side effects are individually best-effort/idempotent so a failure in
   * one never blocks the other or 5xxs the webhook.
   */
  async function onFounderBridgeMissed(callSid: string, conversationId: string): Promise<void> {
    // (a) Missed-call push to the founder(s). Best-effort, masked, never throws.
    try {
      await sendMissedCallPush(conversationId, callSid);
    } catch (err) {
      log.error({ err, callSid }, 'founder triage: missed-call push failed');
    }
    // (b) Zero-tap auto-text — enqueue the throttled, opt-out-gated job. The job
    // is CallSid-idempotent (one auto-text per missed call ever), so a
    // redelivered status callback that reaches here again would only enqueue a
    // duplicate the job de-dupes. enqueueImmediate → SQS DelaySeconds 0.
    try {
      await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid, conversationId });
    } catch (err) {
      log.error({ err, callSid }, 'founder triage: missed-call auto-text enqueue failed');
    }
  }

  /**
   * Send the MISSED-CALL push to every founder (admin user). kind 'missed_call';
   * the body carries the caller's ROLE + FULL identity from pushCallerIdentity
   * (operator ruling D4 2026-08-16 + the role-word amendment 2026-08-25) - a
   * push-only label that never reaches a log line or the stored call entity;
   * actions built from settings.quickReplies (max 2). The SW deep-links a
   * missed_call tap to /quick-reply/<callId>. Best-effort.
   */
  async function sendMissedCallPush(conversationId: string, callSid: string): Promise<void> {
    const founders = await resolveFounders();
    if (founders.length === 0) {
      log.info({ callSid }, 'founder triage: no admin users to missed-call push');
      return;
    }
    // The push label is DERIVED FRESH here rather than read off the persisted
    // call entry's masked call_party_label: this push carries the role + full
    // identity, which the stored (deliberately masked) label cannot supply. The
    // caller's number is the founder-bridge conversation's participant_phone
    // (= the inbound From); relay/masked calls cannot reach this push, so that
    // phone is the real caller. The stored entry stays masked, and the number
    // never enters logs, storage, or the dial leg.
    const conversation = await conversations.getById(conversationId);
    // Best-effort contact resolve for the full name; any failure falls through
    // the chain to the number.
    let callerContact: ContactItem | undefined;
    const callerPhone = conversation?.participant_phone;
    if (typeof callerPhone === 'string' && callerPhone.length > 0) {
      try {
        callerContact = await contacts.findByPhone(callerPhone);
      } catch {
        callerContact = undefined;
      }
    }
    const callerLabel = pushCallerIdentity(callerContact, conversation, callerPhone);

    // Quick-replies → up to 2 notification actions (sw.js slices to 2 anyway).
    // The action ids (qr-0 / qr-1) index the RAW quickReplies array; the SW
    // carries the tapped one to /quick-reply as `#action=<id>`, where the sheet
    // resolves it back to this body and sends it with no further tap. A
    // settings-read failure must not block the push — fall back to no actions.
    //
    // FILTER BEFORE SLICING, and keep the RAW index. Settings validation rejects
    // '' but accepts a whitespace-only reply, and the quick-reply sheet trims
    // and drops blanks — so slicing first could ship a button titled '   ' whose
    // action id resolves to nothing on tap (a press that sends NOTHING), and
    // could spend both action slots on blanks while a real reply goes
    // unsurfaced. The index must stay the RAW one so 'qr-<n>' still names the
    // same entry the sheet indexes.
    let actions: { action: string; title: string }[] = [];
    try {
      const orgSettings = await settings.getOrgSettings();
      actions = orgSettings.quickReplies
        .map((title, i) => ({ action: `qr-${i}`, title: title.trim() }))
        .filter((a) => a.title.length > 0)
        .slice(0, 2);
    } catch (err) {
      log.warn({ err, callSid }, 'founder triage: reading quick-replies for the missed push failed — no actions');
    }

    const payload = {
      title: 'Missed call',
      body: `Missed call — ${callerLabel}`,
      kind: 'missed_call' as const,
      callId: callSid,
      conversationId,
      ...(actions.length > 0 && { actions }),
    };
    for (const founder of founders) {
      try {
        await pushService.sendToUser(founder.userId, { kind: 'missed_call', payload });
      } catch (err) {
        log.warn({ err, callSid, userId: founder.userId }, 'founder triage: missed-call push failed for a founder — continuing');
      }
    }
  }

  /**
   * Send the "New voicemail" push to every founder (admin user). Sibling of
   * sendMissedCallPush - identical posture: the caller's ROLE + FULL identity
   * from pushCallerIdentity (operator ruling D4 2026-08-16 + the role-word
   * amendment 2026-08-25), push-only and never logged or stored. kind
   * 'voicemail'; no quick-reply actions (a voicemail is read, not
   * quick-replied). Best-effort - a per-founder failure is logged and never
   * propagates (the recording is already safe).
   */
  async function sendVoicemailPush(conversationId: string, callSid: string): Promise<void> {
    const founders = await resolveFounders();
    if (founders.length === 0) {
      log.info({ callSid }, 'voicemail: no admin users to push');
      return;
    }
    // Derived fresh, exactly as sendMissedCallPush does (see its note): the
    // stored call_party_label is deliberately masked and cannot supply the full
    // identity this push carries.
    const conversation = await conversations.getById(conversationId);
    let callerContact: ContactItem | undefined;
    const callerPhone = conversation?.participant_phone;
    if (typeof callerPhone === 'string' && callerPhone.length > 0) {
      try {
        callerContact = await contacts.findByPhone(callerPhone);
      } catch {
        callerContact = undefined;
      }
    }
    const callerLabel = pushCallerIdentity(callerContact, conversation, callerPhone);
    const payload = {
      title: 'New voicemail',
      body: `New voicemail - ${callerLabel}`,
      kind: 'voicemail' as const,
      callId: callSid,
      conversationId,
    };
    for (const founder of founders) {
      try {
        await pushService.sendToUser(founder.userId, { kind: 'voicemail', payload });
      } catch (err) {
        log.warn({ err, callSid, userId: founder.userId }, 'voicemail push failed for a founder - continuing');
      }
    }
  }

  return router;
}
