// Twilio Programmable Voice webhooks (M1.9a Change Order 1, doc §7.1 v2.17):
//   POST /webhooks/twilio/voice              — inbound call entry point
//   POST /webhooks/twilio/voice/whisper      — callee-leg whisper + press-1 gate
//   POST /webhooks/twilio/voice/whisper-gate — the press-1/press-0/timeout gate
//   POST /webhooks/twilio/voice/status       — call status callback (forward-only)
//
// All four are signature-gated identically to the SMS handlers (the same
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
// PII (doc §9): NEVER log a real caller's phone/name, and NEVER speak/announce
// or persist a raw counterpart phone — IDs/SIDs/CallSid/role-labels/counts only.
import { Router } from 'express';
import twilio from 'twilio';
import { mergeContext } from '../../lib/context.js';
import { loadConfig, type AppConfig } from '../../lib/config.js';
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
  type ConversationType,
} from '../../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  type CallOutcome,
  type CallStatus,
  type MessageAuthor,
  type MessagesRepo,
} from '../../repos/messagesRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../../repos/settingsRepo.js';
import { createUsersRepo, type UserItem, type UsersRepo } from '../../repos/usersRepo.js';
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
 * Author of the call entry = the INITIATOR's role (same honesty rule as the
 * messaging paths: only a reviewed tenant/landlord contact claims a role;
 * everything else is `unknown`).
 */
function authorForContact(contact: ContactItem | undefined): MessageAuthor {
  return contact?.type === 'landlord' || contact?.type === 'tenant' ? contact.type : 'unknown';
}

/** The 1:1 conversation type for a (reviewed) contact — mirrors the SMS path. */
function conversationTypeFor(contact: ContactItem | undefined): ConversationType {
  switch (contact?.type) {
    case 'landlord':
      return 'landlord_1to1';
    case 'tenant':
      return 'tenant_1to1';
    default:
      return 'unknown_1to1';
  }
}

/**
 * A MASKED, abbreviated display name from a contact's resolved fields for the
 * founder-bridge — "First L." (initial-only surname keeps the founder-facing
 * label terse and a touch more private), else just "First", else undefined.
 * HONEST: never invents a name. PII (doc §9): the NAME is founder-facing
 * context (fine in a push/label to the founder); the raw PHONE is NEVER used.
 */
function contactShortName(contact: ContactItem | undefined): string | undefined {
  const first = typeof contact?.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact?.lastName === 'string' ? contact.lastName.trim() : '';
  if (first.length === 0 && last.length === 0) return undefined;
  if (first.length === 0) return last; // surname only
  if (last.length === 0) return first; // given name only
  return `${first} ${last.charAt(0)}.`;
}

/** The masked ROLE word for the caller's reviewed contact type, else undefined. */
function roleWordForContact(contact: ContactItem | undefined): string | undefined {
  if (contact?.type === 'tenant') return 'Tenant';
  if (contact?.type === 'landlord') return 'Landlord';
  return undefined;
}

/**
 * The MASKED caller label for the founder-bridge timeline entry + the pushes:
 * the contact's role + abbreviated name when known ("Tenant (Jane D.)"), the
 * role alone, the name alone, else "Unknown caller". NEVER the raw From (PII,
 * doc §9). Distinct from the relay maskedPartyLabel() (which labels a roster
 * MEMBER by its cached display name); the founder-bridge labels the CALLER by
 * the freshly-resolved contact.
 */
function maskedCallerLabel(contact: ContactItem | undefined): string {
  const role = roleWordForContact(contact);
  const name = contactShortName(contact);
  if (role !== undefined && name !== undefined) return `${role} (${name})`;
  if (role !== undefined) return role;
  if (name !== undefined) return name;
  return 'Unknown caller';
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

/** Coarse outcome from a (terminal or in-progress) call status. */
function outcomeForStatus(status: CallStatus): CallOutcome | undefined {
  switch (status) {
    case 'in-progress':
    case 'completed':
      return 'answered';
    case 'no-answer':
    case 'busy':
    case 'failed':
    case 'canceled':
      return 'missed';
    default:
      return undefined;
  }
}

/**
 * Whether a TERMINAL founder-bridge status means the founder MISSED the call
 * (M1.9b) — the trigger for the missed-call push + auto-text. True for the
 * obvious misses (no-answer/busy/failed/canceled) AND for the NO-PRESS-1 case:
 * with answerOnBridge, the founder hanging up at the whisper gate leaves the
 * <Dial> `completed` but with ZERO connected duration (the bridge to the caller
 * never formed). A `completed` WITH duration is a real answered+ended call — not
 * a miss. `callDuration` undefined on a `completed` is treated conservatively as
 * NOT a miss (we only auto-text on a clear no-connect signal).
 */
function isMissOutcome(status: CallStatus, callDuration: number | undefined): boolean {
  switch (status) {
    case 'no-answer':
    case 'busy':
    case 'failed':
    case 'canceled':
      return true;
    case 'completed':
      // No-press-1 gate-hangup: bridge never connected → duration 0.
      return callDuration === 0;
    default:
      return false;
  }
}

export interface TwilioVoiceWebhookDeps {
  config?: AppConfig;
  logger?: Logger;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
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
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
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
   * press-1 gate. Recording stays OFF (// SEAM(M1.9c)).
   */
  async function handleFounderTriage(
    res: import('express').Response,
    call: { CallSid: string; From: string },
  ): Promise<void> {
    const { CallSid, From } = call;

    // No business number to use as caller ID, or no founder cell to dial → we
    // CANNOT bridge without leaking the caller's From / having a target. Degrade
    // to a minimal masked greeting (never a 5xx, never a number leak). Operator
    // step: set OUR_PHONE_NUMBERS + FOUNDER_CELL to enable live bridging.
    const founderCell = config.founderCell;
    if (businessCallerId === undefined || founderCell === undefined) {
      log.warn(
        {
          callSid: CallSid,
          hasBusinessNumber: businessCallerId !== undefined,
          hasFounderCell: founderCell !== undefined,
        },
        'founder triage: no business caller ID / founder cell configured — minimal greeting, no bridge',
      );
      sendTwiml(
        res,
        maskedSayHangup(
          'Thank you for calling Housing Choice. Please send us a text message, and we will get back to you.',
        ),
      );
      return;
    }

    // Resolve the caller's 1:1 conversation for masked context (role/name +
    // the conversationId the pushes + auto-text key on). conversationTypeFor
    // mirrors the SMS path's honesty rule (unknown until a human reviews).
    const callerContact = await contacts.findByPhone(From);
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
    // recording_s3_key/transcript stay UNPOPULATED (// SEAM(M1.9c)). A
    // redelivered /voice webhook dedupes here → no double-write, and the
    // pre-ring push still fires (it is idempotent at the founder's device).
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

    // PRE-RING push to the founder (admin user(s)), SYNCHRONOUSLY and BEFORE the
    // <Dial> — the <Pause length=preRingPause> below buys the ~2s head start so
    // the push lands AHEAD of the cell ringing (load-bearing timing). PII (doc
    // §9): masked label only, never the raw From; push send is best-effort and
    // never blocks/fails the bridge.
    await sendPreRingPush(conversation.conversationId, CallSid, callerLabel);

    // Build the founder-bridge TwiML. callerId is ALWAYS the business number,
    // NEVER From (the guardrail). The <Pause> is what makes the push land first.
    // The founder-leg whisper announces the caller (masked) + press-1 to accept
    // (blocks the founder's carrier voicemail from silently "answering"). The
    // <Dial action> + per-leg statusCallback report MISSED/answered to
    // /voice/status. Recording stays OFF (// SEAM(M1.9c): enable record +
    // transcribe here for the founder-bridge call).
    const vr = new VoiceResponse();
    vr.pause({ length: config.preRingPauseSeconds });
    const dial = vr.dial({
      callerId: businessCallerId,
      record: 'do-not-record', // SEAM(M1.9c): enable record + transcribe here
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
        statusCallbackEvent: ['answered', 'completed'],
        statusCallbackMethod: 'POST',
      },
      founderCell,
    );
    log.info(
      { callSid: CallSid, callerIdIsBusiness: true, masked: false, preRingPauseSeconds: config.preRingPauseSeconds },
      'founder triage: pre-ring push sent, bridging to founder cell (callerId = business number, do-not-record, whisper+gate)',
    );
    sendTwiml(res, vr);
  }

  /** The set of founder (admin) users to notify — resolved fresh per call. */
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
   * Send the PRE-RING push to every founder (admin user). kind 'pre_ring';
   * the body is the MASKED caller label (e.g. "Incoming call — Tenant (Jane
   * D.)") — NEVER the raw From (PII, doc §9). Best-effort: a push failure for
   * one founder never blocks the bridge or the others.
   */
  async function sendPreRingPush(conversationId: string, callSid: string, callerLabel: string): Promise<void> {
    const founders = await resolveFounders();
    if (founders.length === 0) {
      log.info({ callSid }, 'founder triage: no admin users to pre-ring push');
      return;
    }
    // Payload shape the service worker expects (dashboard/public/sw.js):
    // { title, body, kind, callId, conversationId } — pre_ring carries no
    // actions (the founder is about to be rung; the actions are on the missed
    // push). The deep link is the conversation (sw.js routes pre_ring by
    // conversationId since it isn't a missed_call).
    const payload = {
      title: 'Incoming call',
      body: `Incoming call — ${callerLabel}`,
      kind: 'pre_ring' as const,
      callId: callSid,
      conversationId,
    };
    for (const founder of founders) {
      try {
        await pushService.sendToUser(founder.userId, { kind: 'pre_ring', payload });
      } catch (err) {
        log.warn({ err, callSid, userId: founder.userId }, 'founder triage: pre-ring push failed for a founder — continuing');
      }
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
      dial.number(
        {
          url: whisperUrl,
          statusCallback: `${baseUrl}/webhooks/twilio/voice/status`,
          statusCallbackEvent: ['answered', 'completed'],
          statusCallbackMethod: 'POST',
        },
        callee.phone,
      );
    }
    log.info(
      { callSid: CallSid, calleeCount: callees.length, masked: true, callerIdIsPool: true },
      'masked inbound call bridged (callerId = pool number, do-not-record, whisper+gate)',
    );
    sendTwiml(res, vr);
  }

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
  router.post('/whisper-gate', verifySignature, (req, res) => {
    const params = asParams(req.body);
    const q = req.query as Record<string, string | undefined>;
    const digits = params['Digits'];
    const conversationId = typeof q['conversationId'] === 'string' ? q['conversationId'] : '';
    const parentCallSid = typeof q['parentCallSid'] === 'string' ? q['parentCallSid'] : (params['CallSid'] ?? '');
    // Founder-bridge leg (M1.9b): the founder IS the team, so press-0 has no
    // team to escape to — it falls through to hangup (→ MISSED → the status
    // handler fires the missed-call push + auto-text).
    const isFounderLeg = q['leg'] === 'founder';
    if (conversationId.length > 0) mergeContext({ conversationId });

    const vr = new VoiceResponse();
    if (digits === '1') {
      // Accept: returning <Pause> (not an empty doc) keeps the bridged leg on
      // the line so Twilio bridges it to the caller. The bridge proceeds.
      vr.pause({ length: 1 });
      log.info(
        { callSid: parentCallSid, gate: 'accept', leg: isFounderLeg ? 'founder' : 'callee' },
        'whisper gate: accepted (1) — bridging',
      );
      sendTwiml(res, vr);
      return;
    }
    if (digits === '0' && !isFounderLeg) {
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
  // Call status callback — POST /voice/status. Twilio POSTs the call's lifecycle
  // (top-level CallStatus/CallDuration) AND the <Dial> action summary
  // (DialCallStatus/DialCallDuration) here. Update the `call` entry by CallSid,
  // forward-only + idempotent: a redelivered/out-of-order callback never
  // regresses a terminal call or double-counts. Emit message.persisted so the
  // hub timeline updates live. NEVER log raw numbers.
  // ---------------------------------------------------------------------
  router.post('/status', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const { CallSid, CallStatus, DialCallStatus, CallDuration, DialCallDuration } = params;
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

    // Prefer the Dial child status (the bridge outcome) when present, else the
    // top-level call status. Both fold onto our CallStatus machine.
    const rawStatus = DialCallStatus ?? CallStatus;
    const mapped = mapCallStatus(rawStatus);
    if (mapped === undefined) {
      // A status we don't model (e.g. 'queued'/'initiated') — ack so Twilio
      // stops, but make no change.
      log.info({ callSid: entryCallSid, providerStatus: rawStatus ?? null }, 'voice status callback: unmodeled status — ignored');
      res.status(200).end();
      return;
    }

    const durationRaw = DialCallDuration ?? CallDuration;
    const duration = durationRaw !== undefined && durationRaw.length > 0 ? Number(durationRaw) : undefined;
    const callDuration = duration !== undefined && Number.isFinite(duration) ? duration : undefined;
    const outcome = outcomeForStatus(mapped);
    const now = new Date().toISOString();
    const terminal = mapped !== 'ringing' && mapped !== 'in-progress';

    const transitioned = await messages.updateCallStatus(entryCallSid, {
      callStatus: mapped,
      ...(outcome !== undefined && { callOutcome: outcome }),
      ...(mapped === 'in-progress' && { answeredAt: now }),
      ...(terminal && { endedAt: now }),
      ...(callDuration !== undefined && { callDuration }),
    });
    log.info(
      { callSid: entryCallSid, providerStatus: rawStatus, callStatus: mapped, transitioned },
      'twilio voice status callback processed',
    );

    if (transitioned) {
      // Resolve the entry's conversation so the SSE event carries it (the hub
      // timeline re-renders the call row live). getByProviderSid is the same
      // SID-pointer lookup the SMS status path uses.
      const entry = await messages.getByProviderSid(entryCallSid);
      if (entry) {
        mergeContext({ conversationId: entry.conversationId });
        events.emit('message.persisted', {
          conversationId: entry.conversationId,
          tsMsgId: entry.tsMsgId,
          direction: entry.direction,
          deliveryStatus: entry.delivery_status,
        });

        // MISSED FOUNDER-BRIDGE (M1.9b): a founder-bridge call (masked:false)
        // that just transitioned into a terminal MISS → fire the missed-call
        // push + the zero-tap auto-text. Gating on `transitioned` (the
        // forward-only call-status write) is the trigger-once guard: only the
        // FIRST callback that moves the call into a terminal miss state returns
        // true, so a redelivered/stale callback never re-triggers (and the
        // auto-text job is ALSO CallSid-idempotent as a second layer).
        if (terminal && entry.type === 'call' && entry.masked !== true && isMissOutcome(mapped, callDuration)) {
          await onFounderBridgeMissed(entryCallSid, entry.conversationId);
        }
      }
    }
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
    // time); fall back to a generic label rather than ever reaching for a phone.
    const entry = await messages.getByProviderSid(callSid);
    const callerLabel =
      typeof entry?.call_party_label === 'string' && entry.call_party_label.length > 0
        ? entry.call_party_label
        : 'a caller';

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
