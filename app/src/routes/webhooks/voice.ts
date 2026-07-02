// Twilio Programmable Voice webhooks (M1.9a Change Order 1, doc §7.1 v2.17):
//   POST /webhooks/twilio/voice              — inbound call entry point
//   POST /webhooks/twilio/voice/whisper      — callee-leg whisper + press-1 gate
//   POST /webhooks/twilio/voice/whisper-gate — the press-1/press-0/timeout gate
//   POST /webhooks/twilio/voice/status       — call status callback (forward-only)
//   POST /webhooks/twilio/voice/recording    — recordingStatusCallback (M1.9c)
//   POST /webhooks/twilio/voice/transcription— transcription callback (M1.9c)
//
// All are signature-gated identically to the SMS handlers (the same
// twilioSignatureMiddleware over the parsed form params; query params are part
// of the URL Twilio signs, so they are covered by the same HMAC).
//
// MASKED (pool-number) CALLING — the M1.9a path: a relay group (M1.7) has a
// pool_number + participants[]. When a member calls the pool number, we bridge
// them to the OTHER member(s) with the POOL NUMBER as caller ID (NEVER the real
// caller's number), after a whisper + press-1 gate on the callee leg (blocks
// carrier voicemail), with press-0 → team. Masked calls are NEVER recorded /
// transcribed (record="do-not-record") — they produce a metadata-only `call`
// timeline entry (who→whom by ROLE, when, duration, answered/missed).
//
// FOUNDER-BRIDGE RECORDING + TRANSCRIPTION — the M1.9c path (CO1, v2.17): the
// founder-bridge call (M1.9b, masked:false) RECORDS. The recordingStatusCallback
// fetches the recording media (authenticated, SSRF-guarded) + streams it to S3,
// then stamps recording_s3_key/duration on the `call` entity. A separate
// transcription callback persists a VERBATIM transcript (NO AI / structured
// extraction — Phase 2). ONLY the founder-bridge (non-masked) records; the
// masked relay <Dial> STAYS do-not-record.
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
import { formatPhoneForDisplay } from '../../lib/phone.js';
import { appEvents, type EventBus } from '../../lib/events.js';
import { logger as defaultLogger, type Logger } from '../../lib/logger.js';
import { twilioSignatureMiddleware } from '../../middleware/twilioSignature.js';
import {
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../../repos/conversationsRepo.js';
import { createPlacementsRepo, type PlacementsRepo } from '../../repos/placementsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../../repos/unitsRepo.js';
import {
  createMessagesRepo,
  type CallStatus,
  type MessageItem,
  type MessagesRepo,
} from '../../repos/messagesRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../../repos/settingsRepo.js';
import { createUsersRepo, type UserItem, type UsersRepo } from '../../repos/usersRepo.js';
import {
  authorForContact,
  conversationTypeFor,
  contactShortName,
  maskedCallerLabel,
  roleWordForContact,
  UNKNOWN_CALLER_LABEL,
} from '../../lib/voiceMasking.js';
import { createPushService, type PushService } from '../../services/pushService.js';
import { enqueueImmediate } from '../../jobs/jobs.js';
import { MISSED_CALL_AUTOTEXT_JOB } from '../../jobs/missedCallAutoText.js';

const { VoiceResponse } = twilio.twiml;

/** The webhook form fields this module reads (all optional strings). */
type WebhookParams = Record<string, string | undefined>;

function asParams(body: unknown): WebhookParams {
  return (typeof body === 'object' && body !== null ? body : {}) as WebhookParams;
}

/**
 * First trimmed non-empty string from a list of candidates, else undefined
 * (M1.9c: the transcription callback is lenient about WHICH field carries the
 * transcript across legacy / Voice Intelligence payload shapes).
 */
function firstNonEmptyString(candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  return undefined;
}

/**
 * A neutral, masked party label for a participant: the resolved display name
 * when one is known, else the role ("Tenant"/"Landlord"), else the generic
 * "the other party". NEVER the raw phone (PII, doc §9). `name` is the
 * roster-cached display name (resolved at member-add time); `role` comes from
 * the reviewed contact type (honesty rule — only tenant/landlord claim a role).
 */
function maskedPartyLabel(member: ConversationParticipant | undefined, contact: ContactItem | undefined): string {
  if (member?.name !== undefined && member.name.length > 0) return member.name;
  if (contact?.type === 'tenant') return 'Tenant';
  if (contact?.type === 'landlord') return 'Landlord';
  return 'the other party';
}

/**
 * The MASKED caller/contact label + the honesty-rule role/author/conversation-
 * type mapping now live in lib/voiceMasking.ts (shared with the OUTBOUND
 * originate path) — imported above. `maskedPartyLabel` below stays local (it
 * labels a roster MEMBER by its cached display name, a relay-only concern).
 */

/**
 * The PUSH-ONLY caller label. For a KNOWN caller it's the masked role/name (as
 * stored). For an UNKNOWN caller we surface the caller's formatted phone number
 * instead of a useless "Unknown caller" — the founder asked to see who's
 * calling, and a push lands on the founder's OWN authenticated device. This is
 * NOT a guardrail break: PHASE1_CHANGE_ORDER_2 item 5 forbids the real caller's
 * number on the founder-bridge DIAL LEG (caller ID stays the business number)
 * and §9 keeps it out of logs/stored records — both unchanged. The number lives
 * ONLY in this ephemeral push payload; the call entity's call_party_label, the
 * logs, and the dial caller ID all stay masked. Falls back to the masked label
 * when no number is available.
 */
function pushCallerLabel(maskedLabel: string, callerPhone: string | undefined): string {
  if (maskedLabel !== UNKNOWN_CALLER_LABEL) return maskedLabel;
  return formatPhoneForDisplay(callerPhone) ?? maskedLabel;
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
  /** M1.10d masked-call landlord-leg routing (placement -> unit.primary_voice_contact). */
  placementsRepo?: PlacementsRepo;
  unitsRepo?: UnitsRepo;
  /** Founder-editable templates (M1.9b: missed-call quick-replies); real repo by default. */
  settingsRepo?: SettingsRepo;
  /** Team lookup (M1.9b: resolve the founder = admin user(s)); real repo by default. */
  usersRepo?: UsersRepo;
  /** Web Push dispatch (M1.9b: pre-ring + missed-call pushes); real service by default. */
  pushService?: PushService;
  /** SSE live-update bus (M1.2); the process singleton by default. */
  events?: EventBus;
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
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const pushService =
    deps.pushService ?? createPushService({ config, logger: deps.logger, usersRepo: users });
  const events = deps.events ?? appEvents;
  const ourNumbers = new Set(config.ourPhoneNumbers);
  const baseUrl = config.publicBaseUrl ?? '';
  // Founder-bridge caller ID: ALWAYS a number we own (the first business
  // number), NEVER the real caller's From (the M1.9b guardrail).
  const businessCallerId = config.ourPhoneNumbers[0];

  // Boot readiness signal (PII-safe — booleans only, never the cell itself):
  // inbound call-triage bridges to the assigned inbound-voice-line HOLDER's
  // verified cell — that holder is RUNTIME DATA (a user record), not boot config,
  // so it can't be checked at startup. What IS boot config is the business number
  // used as caller ID; without it every inbound business call degrades to the
  // "text us" fallback (see handleFounderTriage). Log it so a missing
  // OUR_PHONE_NUMBERS[0] is obvious without a live test call.
  log.info(
    { hasBusinessNumber: businessCallerId !== undefined },
    `voice: business number ${
      businessCallerId !== undefined ? 'configured' : 'NOT configured (OUR_PHONE_NUMBERS[0])'
    }; inbound bridges to the assigned inbound-voice-line holder's verified cell`,
  );

  const router = Router();
  const verifySignature = twilioSignatureMiddleware({
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
    if (ourNumbers.has(From)) {
      log.info({ callSid: CallSid }, 'twilio voice echo (From is our number) — dropped');
      sendTwiml(res, new VoiceResponse());
      return;
    }
    if (await conversations.getByPoolNumber(From)) {
      log.info({ callSid: CallSid }, 'twilio voice echo (From is a pool number) — dropped');
      sendTwiml(res, new VoiceResponse());
      return;
    }

    // (2) Route by To. A pool number → the masked relay-group bridge.
    if (To !== undefined && To.length > 0) {
      const relay = await conversations.getByPoolNumber(To);
      if (relay) {
        await handleMaskedInbound(res, relay, { CallSid, From });
        return;
      }
    }

    // (3) To is a business number (ourPhoneNumbers) or unknown → FOUNDER
    // CALL-TRIAGE (M1.9b / CO2 §7.1). Pre-ring push to the founder ~preRingPause
    // seconds AHEAD of the ring, then bridge the call to the founder's cell with
    // the BUSINESS number as caller ID (never the real caller's) via the same
    // whisper + press-1 accept gate as the masked bridge. Missed → missed-call
    // push + zero-tap auto-text (the /voice/status handler below). The
    // main-business-number → landlord-by-unit (primary_voice_contact) masked
    // path stays M1.10 (needs the unit↔placement linkage).
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
        maskedSayHangup(
          'Thank you for calling Housing Choice. Please send us a text message, and we will get back to you.',
        ),
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
    // masked relay path already has the equivalent dialPhone !== From guard.)
    if (From === dialedCell) {
      log.info({ callSid: CallSid }, 'founder triage: caller is the dialed cell — not bridging to self');
      sendTwiml(
        res,
        maskedSayHangup(
          'Thanks for calling Housing Choice. Please reach us from a different line, or send a text message. Goodbye.',
        ),
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

    // Routing-decision SEAM (v2.17): hardcoded 'ring-founder' today.
    const decision = decideFounderRouting(conversation, callerContact);
    /* c8 ignore next 5 */
    if (decision !== 'ring-founder') {
      // Unreachable today (decideFounderRouting only returns 'ring-founder') —
      // the shape the deferred ring-through rules will use to refuse a bridge.
      sendTwiml(res, maskedSayHangup('Sorry, no one is available to take your call right now.'));
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
      });
      if (!appended.deduped) {
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
    // masked label only, never the raw From; the send never blocks/fails the
    // bridge.
    // The push (holder's own device) surfaces the caller's number when the
    // caller is UNKNOWN; the stored entry above keeps the masked callerLabel.
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
        pushCallerLabel(callerLabel, From),
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
   * is ringing — spec §6). kind 'pre_ring'; the body is the MASKED caller label
   * (e.g. "Incoming call — Tenant (Jane D.)") — NEVER the raw From (PII, doc §9).
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
      await pushService.sendToUser(holderUserId, { kind: 'pre_ring', payload });
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
          // No counterpart label on a refusal (no bridge happened); record why.
          callPartyLabel: reason === 'closed_thread' ? 'Closed thread' : 'Not connected',
          ...(isClosed && { receivedOnClosedThread: true }),
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
        maskedSayHangup(
          'Sorry, this Housing Choice connection is no longer available. Please send us a text message instead.',
        ),
      );
      return;
    }

    // Routing-decision SEAM (v2.17): hardcoded 'bridge' today.
    const decision = decideRouting(relay, caller);
    /* c8 ignore next 4 */
    if (decision !== 'bridge') {
      // Unreachable today (decideRouting only returns 'bridge') — the shape the
      // deferred ring-through rules will use to refuse a bridge.
      sendTwiml(res, maskedSayHangup('Sorry, this Housing Choice connection is not available right now.'));
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

    // M1.10d: for a tenant->landlord masked call on a PLACEMENT-linked relay, the
    // landlord LEG dials the unit's primary_voice_contact (the per-property
    // voice contact, §7.1) instead of the roster SMS number — resolved at CALL
    // TIME (so a changed per-unit voice contact takes effect without
    // re-rostering), with the roster number as the fallback. It substitutes ONLY
    // when the CALLER is the placement's tenant (destination = the landlord side);
    // texts are unaffected (relay fan-out always uses the roster SMS numbers).
    // Best-effort: any lookup hiccup falls back to the roster number — the
    // bridge must never crash on routing resolution.
    let landlordVoiceOverride: { landlordContactId: string; dialPhone: string } | undefined;
    try {
      const placementId = typeof relay.placementId === 'string' && relay.placementId.length > 0 ? relay.placementId : undefined;
      if (placementId !== undefined && caller.contactId) {
        const linkedPlacement = await placements.getById(placementId);
        if (linkedPlacement && caller.contactId === linkedPlacement.tenantId) {
          const unit = await units.getById(linkedPlacement.unitId);
          const voiceContactId =
            typeof unit?.primary_voice_contact === 'string' && unit.primary_voice_contact.length > 0
              ? unit.primary_voice_contact
              : undefined;
          const landlordContactId = typeof unit?.landlordId === 'string' ? unit.landlordId : undefined;
          if (voiceContactId !== undefined && landlordContactId !== undefined) {
            const voiceContact = await contacts.getById(voiceContactId);
            const dialPhone =
              typeof voiceContact?.phone === 'string' && voiceContact.phone.length > 0
                ? voiceContact.phone
                : undefined;
            // Guard a misconfig where the unit's voice contact resolves to the
            // CALLER's own number — never bridge the tenant to themselves; fall
            // back to the roster number.
            if (dialPhone !== undefined && dialPhone !== From) {
              landlordVoiceOverride = { landlordContactId, dialPhone };
            }
          }
        }
      }
    } catch (err) {
      log.error(
        { err, callSid: CallSid },
        'masked call: landlord voice-contact resolution failed — using the roster number',
      );
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
      // M1.10d: the landlord-side callee dials the unit's primary_voice_contact
      // when resolved (else the roster number). Identified by contactId so a
      // multi-member group only substitutes the actual landlord leg.
      const dialPhone =
        landlordVoiceOverride !== undefined && callee.contactId === landlordVoiceOverride.landlordContactId
          ? landlordVoiceOverride.dialPhone
          : callee.phone;
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
        landlordVoiceOverride: landlordVoiceOverride !== undefined,
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
   */
  async function resolveOutboundTarget(
    conversationId: string,
  ): Promise<{ targetPhone: string; label: string } | undefined> {
    if (conversationId.length === 0) return undefined;
    const conversation = await conversations.getById(conversationId);
    const targetPhone =
      typeof conversation?.participant_phone === 'string' && conversation.participant_phone.length > 0
        ? conversation.participant_phone
        : undefined;
    if (conversation === undefined || targetPhone === undefined) return undefined;
    const contact = await contacts.findByPhone(targetPhone);
    return { targetPhone, label: maskedCallerLabel(contact) };
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
      sendTwiml(
        res,
        maskedSayHangup('Sorry, this Housing Choice call is no longer available. Goodbye.'),
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
    gather.say(`Calling ${target.label}. Press 1 to connect.`);
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
    const callerLabel = typeof q['callerLabel'] === 'string' ? q['callerLabel'] : 'a Housing Choice contact';
    const conversationId = typeof q['conversationId'] === 'string' ? q['conversationId'] : '';
    const parentCallSid = typeof q['parentCallSid'] === 'string' ? q['parentCallSid'] : (params['CallSid'] ?? '');
    // leg=founder selects the founder-bridge whisper copy (M1.9b): the founder
    // IS the team, so there is no press-0 "reach the team" escape on her leg —
    // just press-1 to accept (the same gate that blocks carrier voicemail).
    const isFounderLeg = q['leg'] === 'founder';
    if (conversationId.length > 0) mergeContext({ conversationId });

    // Carry leg forward to the gate so it can pick the right press-0 behavior.
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
    // Press 1 to accept (gates the bridge, blocks carrier voicemail). The masked
    // (relay) leg also offers press-0 → team; the founder leg does not (she is
    // the team).
    gather.say(
      isFounderLeg
        ? `You have a Housing Choice call from ${callerLabel}. Press 1 to accept.`
        : `You have a Housing Choice call from ${callerLabel}. Press 1 to accept, or press 0 to reach the team.`,
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
  // Whisper gate — POST /voice/whisper-gate. The press-1/press-0/timeout
  // decision, stateless (context via the query string). Runs on the CALLEE leg.
  //   Digits == '1' → empty/<Pause> TwiML → the bridge PROCEEDS (callee accepted)
  //   Digits == '0' → <Dial> the team (press-0 escape)
  //   else          → <Hangup> the callee leg (caller hears masked no-answer,
  //                   never the carrier voicemail)
  // ---------------------------------------------------------------------
  router.post('/whisper-gate', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const q = req.query as Record<string, string | undefined>;
    const digits = params['Digits'];
    const conversationId = typeof q['conversationId'] === 'string' ? q['conversationId'] : '';
    const parentCallSid = typeof q['parentCallSid'] === 'string' ? q['parentCallSid'] : (params['CallSid'] ?? '');
    // Founder-bridge leg (M1.9b): the founder IS the team, so press-0 has no
    // team to escape to — it falls through to hangup (→ MISSED → the status
    // handler fires the missed-call push + auto-text).
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
      const businessCallerId = config.ourPhoneNumbers[0];
      if (target === undefined || businessCallerId === undefined) {
        vr.hangup();
        log.warn(
          { callSid: parentCallSid, outbound: true },
          'outbound whisper gate: target/business number unresolved — hanging up',
        );
        sendTwiml(res, vr);
        return;
      }
      // Mark the bridge accepted NOW (press-1 is the authoritative "answered"
      // signal, same as the inbound legs). Best-effort.
      if (parentCallSid.length > 0) {
        try {
          await messages.updateCallStatus(parentCallSid, {
            callStatus: 'in-progress',
            answeredAt: new Date().toISOString(),
          });
        } catch (err) {
          log.warn(
            { err, callSid: parentCallSid },
            'outbound whisper gate: marking the bridge accepted failed (best-effort) — continuing',
          );
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
        try {
          await messages.updateCallStatus(parentCallSid, {
            callStatus: 'in-progress',
            answeredAt: new Date().toISOString(),
          });
        } catch (err) {
          log.warn(
            { err, callSid: parentCallSid },
            'whisper gate: marking the bridge accepted failed (best-effort) — continuing',
          );
        }
      }
      log.info(
        { callSid: parentCallSid, gate: 'accept', leg: isFounderLeg ? 'founder' : 'callee' },
        'whisper gate: accepted (1) — bridging',
      );
      sendTwiml(res, vr);
      return;
    }
    if (digits === '0' && !isFounderLeg && !isOutboundLeg) {
      // Press-0 escape (masked relay only): dial the team. callerId stays a
      // number we own (the first configured business number) — NEVER the
      // original caller's From (PII).
      const teamNumbers = config.ourPhoneNumbers;
      const teamCallerId = teamNumbers[0];
      if (teamNumbers.length > 0 && teamCallerId !== undefined) {
        const dial = vr.dial({ callerId: teamCallerId, record: 'do-not-record' });
        for (const n of teamNumbers) dial.number(n);
        log.info({ callSid: parentCallSid, gate: 'team', masked: true }, 'masked whisper gate: press-0 — dialing team');
      } else {
        // No team number configured — say + hangup rather than leak/await.
        vr.say('Sorry, the team is not reachable right now. Please try again later.');
        vr.hangup();
        log.warn({ callSid: parentCallSid, gate: 'team' }, 'masked whisper gate: press-0 but no team number configured');
      }
      sendTwiml(res, vr);
      return;
    }
    // Timeout / press-0 on the founder leg / any other key → hang up the bridged
    // leg so the caller hears a no-answer (the press-1 gate is exactly what
    // blocks the leg's carrier voicemail from silently "answering" the bridge).
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

    const transitioned = await messages.updateCallStatus(entryCallSid, {
      callStatus: mapped,
      ...(outcome !== undefined && { callOutcome: outcome }),
      ...(stampAnsweredAt && { answeredAt: now }),
      ...(stampEndedAt && { endedAt: now }),
      // A MISS has no meaningful talk time — only record a duration when the
      // bridge was actually accepted.
      ...(bridgeAccepted && callDuration !== undefined && { callDuration }),
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
        events.emit('message.persisted', {
          conversationId: fresh.conversationId,
          tsMsgId: fresh.tsMsgId,
          direction: fresh.direction,
          deliveryStatus: fresh.delivery_status,
        });

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
    // TwiML: on a MISS, a brief masked goodbye — we have NO voicemail; a missed
    // bridge is handled by the missed push + auto-text — then hang up; on an
    // answered/completed bridge (or a per-leg statusCallback, whose response
    // Twilio ignores) an empty <Response/> ends the call cleanly. Never leaks
    // the caller's number (no <Number>/callerId echoed here).
    const reply = new VoiceResponse();
    if (isMissed) {
      reply.say(
        'Sorry we missed your call. Please send us a text message and we will get right back to you. Goodbye.',
      );
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

    // The claim succeeded AND the media is in S3 → announce the now-recorded
    // call so the timeline updates live.
    events.emit('message.persisted', {
      conversationId: entry.conversationId,
      tsMsgId: entry.tsMsgId,
      direction: entry.direction,
      deliveryStatus: entry.delivery_status,
    });
    log.info(
      { callSid: entryCallSid, recordingSid: RecordingSid, recordingDuration: duration, stored: true },
      'founder-bridge recording mirrored to S3',
    );
    res.status(200).end();
  });

  // ---------------------------------------------------------------------
  // Transcription callback — POST /voice/transcription (M1.9c). Persists a
  // VERBATIM transcript onto the founder-bridge `call` entity. The transcription
  // ENGINE itself is Twilio VOICE INTELLIGENCE — a paid, account-configured
  // Service (OPERATOR step; the legacy <Record transcribe> attribute is
  // deprecated and does NOT apply to <Dial> recordings). This endpoint does NOT
  // call any transcription API inline — it only PERSISTS what the engine POSTs
  // here (the transcript field populates when Voice Intelligence POSTs to this
  // callback). Lenient on the payload shape: accept TranscriptionText (legacy)
  // or a Voice Intelligence transcript body. Idempotent: an empty redelivery, or
  // one after a transcript is already saved, never overwrites. ONLY founder-
  // bridge (masked:false) calls — a masked call is refused. PII (doc §9): NEVER
  // log the transcript text — length only.
  // ---------------------------------------------------------------------
  router.post('/transcription', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const { CallSid, TranscriptionStatus } = params;
    const entryCallSid = params['ParentCallSid'] ?? CallSid;
    if (!entryCallSid) {
      log.warn({ hasCallSid: false }, 'twilio transcription callback missing CallSid — rejected');
      res.status(400).json({ error: 'bad request' });
      return;
    }
    // A failed-transcription callback carries no usable text — ack + ignore.
    if (TranscriptionStatus !== undefined && TranscriptionStatus !== 'completed') {
      log.info({ callSid: entryCallSid, transcriptionStatus: TranscriptionStatus }, 'transcription callback: non-completed status — ignored');
      res.status(200).end();
      return;
    }

    // Lenient extraction: the legacy/simple shape is TranscriptionText; a Voice
    // Intelligence callback may instead carry the transcript under a `Transcript`
    // / `transcript` field. Take the first non-empty string. NEVER log the value.
    const transcriptText = firstNonEmptyString([
      params['TranscriptionText'],
      params['Transcript'],
      params['transcript'],
      params['transcript_text'],
    ]);
    if (transcriptText === undefined) {
      log.info({ callSid: entryCallSid }, 'transcription callback: empty transcript — nothing to save');
      res.status(200).end();
      return;
    }

    // Resolve the call entity. Founder-bridge only — a masked relay call is
    // never recorded/transcribed, so refuse it.
    const entry = await messages.getByProviderSid(entryCallSid);
    if (!entry || entry.type !== 'call') {
      log.warn({ callSid: entryCallSid }, 'transcription callback: no founder-bridge call for CallSid — ignored');
      res.status(200).end();
      return;
    }
    if (entry.masked === true) {
      log.warn({ callSid: entryCallSid, masked: true }, 'transcription callback for a MASKED call — refused (masked calls are never transcribed)');
      res.status(200).end();
      return;
    }
    mergeContext({ conversationId: entry.conversationId });

    // Save VERBATIM, idempotently — a redelivery after a saved transcript loses
    // the conditional write (false), so the transcript is never overwritten/dup.
    const saved = await messages.setCallTranscript(entryCallSid, transcriptText);
    if (saved) {
      events.emit('message.persisted', {
        conversationId: entry.conversationId,
        tsMsgId: entry.tsMsgId,
        direction: entry.direction,
        deliveryStatus: entry.delivery_status,
      });
    }
    // PII: transcriptLength only — NEVER the transcript text.
    log.info({ callSid: entryCallSid, transcriptLength: transcriptText.length, saved }, 'founder-bridge transcript saved');
    res.status(200).end();
  });

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
   * masked body (the call's call_party_label, a role/name — NEVER a raw phone);
   * actions built from settings.quickReplies (max 2). The SW deep-links a
   * missed_call tap to /quick-reply/<callId>. Best-effort.
   */
  async function sendMissedCallPush(conversationId: string, callSid: string): Promise<void> {
    const founders = await resolveFounders();
    if (founders.length === 0) {
      log.info({ callSid }, 'founder triage: no admin users to missed-call push');
      return;
    }
    // The masked caller label is on the persisted call entry (set at bridge
    // time). For a KNOWN caller it's role+name and we use it as-is; for an
    // UNKNOWN caller, surface the caller's number in this push (the founder's
    // own device) via pushCallerLabel — the caller's number is the founder-
    // bridge conversation's participant_phone (= the inbound From). The stored
    // entry stays masked; the number never enters logs/storage/the dial leg.
    const entry = await messages.getByProviderSid(callSid);
    const storedLabel =
      typeof entry?.call_party_label === 'string' && entry.call_party_label.length > 0
        ? entry.call_party_label
        : UNKNOWN_CALLER_LABEL;
    const conversation = await conversations.getById(conversationId);
    const callerLabel = pushCallerLabel(storedLabel, conversation?.participant_phone);

    // Quick-replies → up to 2 notification actions (sw.js slices to 2 anyway).
    // The action ids (qr-0 / qr-1) are what the SW forwards so /quick-reply can
    // pre-select the chosen canned reply. A settings-read failure must not block
    // the push — fall back to no actions.
    let actions: { action: string; title: string }[] = [];
    try {
      const orgSettings = await settings.getOrgSettings();
      actions = orgSettings.quickReplies
        .slice(0, 2)
        .map((title, i) => ({ action: `qr-${i}`, title }));
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

  return router;
}
