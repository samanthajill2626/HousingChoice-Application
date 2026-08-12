// fake-twilio/src/engine/conversationsEngine.ts
//
// The Twilio Conversations emulation - the RAIL behind a native group text.
// Green-field: nothing in this repo emulated Conversations before S8.
//
// WHAT IT MODELS, and why each piece is load-bearing:
//
//  * THE PARTICIPANT SHAPE. The business number is its OWN participant carrying
//    ONLY a projected address; each member is a SEPARATE participant carrying
//    ONLY an address. Combining them on one participant is Twilio's `50407
//    Invalid messaging binding address`, which reads like a bad phone number and
//    is not one - it cost an hour live. Modelling the shape faithfully is what
//    makes the adapter's REAL request shape the thing that gets exercised.
//
//  * NO CLASSIC STATUS CALLBACKS on a fan-out leg (spec 16.2, proven live).
//    Delivery state arrives SOLELY as `onDeliveryUpdated`. Firing classic
//    callbacks too would manufacture the "status callback for unknown provider
//    SID" ERROR the reply-all e2e exists to prove absent.
//
//  * ONE WEBHOOK, BOTH EVENT KINDS (spec 16.1). Twilio permits exactly one
//    PostWebhookUrl per service and a service-scoped config SILENCES the
//    account-global scope, so `onDeliveryUpdated` and `onMessageAdded` both go
//    to POST /webhooks/twilio/conversations. There is NO account-global webhook
//    and the fake deliberately does not emulate one.
//
//  * SIGNED, FORM-ENCODED (A28). Every dispatch goes through
//    `dispatcher.post(path, params)`, which signs exactly as Twilio does and
//    carries `x-origin-verify` - so the new route's signature validation is
//    exercised for real, not bypassed.
//
//  * OUR OWN POSTS PRODUCE NO onMessageAdded ECHO unless the caller asks. The
//    adapter deliberately omits `X-Twilio-Webhook-Enabled`, and that omission is
//    what keeps our own sends out of the guardrail cross-check's input. The fake
//    honours the header so the contract is modelled rather than assumed.
//
//  * AN OPTED-OUT PARTICIPANT IS SKIPPED ENTIRELY (live QA round 2). This fake
//    used to fan out to every member and let a spec ARM a 21610 for the
//    opted-out one - which flattered the app, because real Twilio does no such
//    thing. Verified against the Messages API after a member sent STOP: there is
//    NO message record for that leg at all. The Conversations layer does not
//    create the leg, does not attempt delivery, does not emit a 21610, and
//    therefore never sends a delivery receipt for that participant. A fake that
//    produces a receipt where production produces silence hides exactly the
//    defect that silence causes (a slot stuck `queued` forever, and a FALSE
//    "receipts silent" alarm on every later send), so it now skips them.
//    SCOPE, deliberately: this models the CONVERSATIONS rail only. Nothing here
//    changes 1:1 or relay fan-out behavior, which are separately reviewed
//    surfaces with their own specs.
import type { Clock } from './clock.js';
import type { EventHub } from './eventHub.js';
import type { Dispatcher, FakeTwilioEngine } from './engine.js';
import { ConversationsStore, DuplicateUniqueNameError } from './conversationsStore.js';
import type { ConversationRecord } from './conversationsStore.js';
import {
  buildConversationsDeliveryParams,
  buildConversationsMessageAddedParams,
} from './signer.js';
import { plannedTransitions, stepDelayMs } from './delivery.js';
import type { ConversationSnapshot, DeliveryState } from './types.js';

/** The ONE route both Conversations event kinds are delivered to (spec 16.1). */
export const CONVERSATIONS_WEBHOOK_PATH = '/webhooks/twilio/conversations';

export interface ConversationsEngineDeps {
  clock: Clock;
  dispatcher: Dispatcher;
  hub: EventHub;
  /** The messaging engine - fan-out legs land in the fake phones' 1:1 threads. */
  messaging: FakeTwilioEngine;
  store?: ConversationsStore;
  /** Starting value for the CH/MB/IM counter. Pin it in tests. */
  sidSeqStart?: number;
}

export interface CreateConversationInput {
  uniqueName?: string;
  friendlyName?: string;
  messagingServiceSid?: string;
  /** Bulk-create participants, as `{ messaging_binding: {...} }` objects. */
  participants?: { address?: string; projectedAddress?: string }[];
}

export interface PostMessageInput {
  author?: string;
  body?: string;
  /** True only when the caller set `X-Twilio-Webhook-Enabled` (we never do). */
  webhookEnabled?: boolean;
}

export interface InjectMessageAddedInput {
  conversationSid: string;
  author?: string;
  body?: string;
  /** `SMS` (carrier-sourced, what the cross-check counts) or `API`/`SDK`. */
  source?: 'SMS' | 'API' | 'SDK';
  participantSid?: string;
  /** Pin the IMxx (a redelivery test needs to repeat one). */
  messageSid?: string;
}

/**
 * Twilio's standard opt-out / opt-in keyword sets (the ones its Advanced
 * Opt-Out feature intercepts before a message ever reaches an app). Matched on
 * the WHOLE trimmed body, case-insensitively - "stop by at 5" is not a STOP,
 * and treating it as one would silently mute a persona mid-spec.
 */
const OPT_OUT_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const OPT_IN_KEYWORDS = new Set(['start', 'yes', 'unstop']);

export class ConversationsEngine {
  private readonly clock: Clock;
  private readonly dispatcher: Dispatcher;
  private readonly hub: EventHub;
  private readonly messaging: FakeTwilioEngine;
  private readonly store: ConversationsStore;
  /**
   * Addresses Twilio's own suppression list holds, built from the keywords it
   * sees on inbound traffic. Observed through the shared hub rather than in a
   * route handler, so a STOP counts whether it arrived as a 1:1 or as a carrier
   * group text - the same way one messaging service's opt-out list does.
   */
  private readonly optedOut = new Set<string>();
  private sidSeq: number;
  /** Dispatch failures, surfaced through the messaging engine's ring buffer so
   *  there is ONE place a spec looks for a rejected webhook. */
  private readonly dispatchErrors: { sid?: string; path: string; status?: number; error?: string; at: string }[] = [];

  constructor(deps: ConversationsEngineDeps) {
    this.clock = deps.clock;
    this.dispatcher = deps.dispatcher;
    this.hub = deps.hub;
    this.messaging = deps.messaging;
    this.store = deps.store ?? new ConversationsStore();
    this.sidSeq = deps.sidSeqStart ?? 10_000_000 + Math.floor(Math.random() * 80_000_000);
    // Rails are engine state, so they clear with the engine (A.9 / preflight
    // calls POST /control/reset once per suite). Subscribing to the shared hub
    // means the main reset covers this store by construction - there is no
    // second reset route to forget to call, and no stale CHxx map can leak
    // across specs.
    this.hub.subscribe((event) => {
      if (event.type === 'reset') {
        this.store.reset();
        this.optedOut.clear();
        return;
      }
      // Twilio's suppression list is fed by the keywords it sees, not by
      // anything the app tells it. Watching inbound traffic here is the same
      // relationship, and it keeps the STOP/START pair working through the
      // EXISTING control routes - no second arming API to keep in sync.
      if (event.type === 'message.appended' && event.message.direction === 'inbound') {
        this.noteKeyword(event.message.from, event.message.body);
      }
    });
  }

  private noteKeyword(address: string, body: string | undefined): void {
    const word = (body ?? '').trim().toLowerCase();
    if (OPT_OUT_KEYWORDS.has(word)) this.optedOut.add(address);
    else if (OPT_IN_KEYWORDS.has(word)) this.optedOut.delete(address);
  }

  /** Does Twilio's suppression list hold this address? (Inspection + tests.) */
  isOptedOut(address: string): boolean {
    return this.optedOut.has(address);
  }

  private mintSid(prefix: 'CH' | 'MB' | 'IM'): string {
    this.sidSeq += 1;
    return `${prefix}fake${String(this.sidSeq).padStart(8, '0')}`;
  }

  private emitUpdated(record: ConversationRecord): void {
    this.hub.emit({ type: 'conversation.updated', conversation: ConversationsStore.snapshot(record) });
  }

  // -------------------------------------------------------------------------
  // Resource operations (the REST router's whole surface)
  // -------------------------------------------------------------------------

  create(input: CreateConversationInput): ConversationRecord {
    const record = this.store.create({
      sid: this.mintSid('CH'),
      ...(input.uniqueName !== undefined && { uniqueName: input.uniqueName }),
      ...(input.friendlyName !== undefined && { friendlyName: input.friendlyName }),
      ...(input.messagingServiceSid !== undefined && {
        messagingServiceSid: input.messagingServiceSid,
      }),
      dateCreated: this.clock.nowIso(),
    });
    for (const participant of input.participants ?? []) {
      this.addParticipant(record, participant);
    }
    this.emitUpdated(record);
    return record;
  }

  resolve(sidOrUniqueName: string): ConversationRecord | undefined {
    return this.store.resolve(sidOrUniqueName);
  }

  remove(sidOrUniqueName: string): boolean {
    const removed = this.store.remove(sidOrUniqueName);
    return removed;
  }

  addParticipant(
    record: ConversationRecord,
    binding: { address?: string; projectedAddress?: string },
  ): ConversationRecord['participants'][number] {
    // Faithful to Twilio: a participant carries EITHER an address OR a projected
    // address, never both. A caller that supplies both gets 50407, which is what
    // makes the adapter's careful two-participant construction meaningful.
    if (binding.address !== undefined && binding.projectedAddress !== undefined) {
      throw new InvalidMessagingBindingError(
        'Invalid messaging binding address: a participant carries either an address or a projected address, not both',
      );
    }
    if (binding.address === undefined && binding.projectedAddress === undefined) {
      throw new InvalidMessagingBindingError('Invalid messaging binding address: none supplied');
    }
    const participant = this.store.addParticipant(record, {
      sid: this.mintSid('MB'),
      ...(binding.address !== undefined && { address: binding.address }),
      ...(binding.projectedAddress !== undefined && { projectedAddress: binding.projectedAddress }),
      dateCreated: this.clock.nowIso(),
    });
    this.emitUpdated(record);
    return participant;
  }

  /**
   * Post a message into the rail: fan it out to every member's fake phone and
   * schedule the per-participant `onDeliveryUpdated` progression.
   *
   * The legs go out FROM the business number (the projected address), so the
   * relay-group INFERENCE in the messaging engine never sees them - a
   * Conversations fan-out must create ZERO relay groups, and the `from ===
   * APP_NUMBER` shape is what guarantees that structurally.
   */
  postMessage(record: ConversationRecord, input: PostMessageInput): ConversationRecord['messages'][number] {
    const sid = this.mintSid('IM');
    const now = this.clock.nowIso();
    const business = this.store.businessParticipant(record);
    const members = this.store.memberParticipants(record);
    const from = business?.projectedAddress ?? input.author ?? '';

    // SKIPPED, not failed. A participant on the suppression list gets no leg at
    // all - no carrier message, no state, and (because the progression is
    // scheduled per leg below) no `onDeliveryUpdated`, ever. That silence is the
    // live ground truth, and it is what the app has to be correct against.
    const legs = members
      .filter((member) => !this.optedOut.has(member.address!))
      .map((member) => ({
        participantSid: member.sid,
        address: member.address!,
        channelMessageSid: this.messaging.appendConversationsLeg({
          to: member.address!,
          from,
          ...(input.body !== undefined && { body: input.body }),
        }),
        state: 'queued' as DeliveryState,
      }));

    const message = {
      sid,
      ...(input.author !== undefined && { author: input.author }),
      ...(input.body !== undefined && { body: input.body }),
      index: this.store.nextIndex(record),
      source: 'API' as const,
      dateCreated: now,
      legs,
    };
    this.store.appendMessage(record, message);
    this.emitUpdated(record);

    for (const leg of legs) {
      this.scheduleDeliveryProgression(record, message.sid, leg);
    }

    // Our own posts produce NO onMessageAdded echo unless the caller opted in
    // with X-Twilio-Webhook-Enabled - the adapter deliberately does not, and
    // that omission is exactly what keeps our sends out of the cross-check's
    // input set (spec 15.1 / 16.1 item 5).
    if (input.webhookEnabled === true) {
      void this.dispatchMessageAdded({
        record,
        messageSid: sid,
        source: 'API',
        index: message.index,
        ...(input.author !== undefined && { author: input.author }),
        ...(input.body !== undefined && { body: input.body }),
        ...(business !== undefined && { participantSid: business.sid }),
      });
    }
    return message;
  }

  /**
   * Drive one member's delivery ladder: advance the leg's stored state (so the
   * fake-phones UI tracks it) and POST an `onDeliveryUpdated` per transition.
   *
   * The armed `POST /control/delivery-outcome` profile is consumed here, which
   * is what makes the per-member 21610 simulation work through the SAME control
   * API a 1:1 send uses - no second arming route to keep in sync.
   */
  private scheduleDeliveryProgression(
    record: ConversationRecord,
    messageSid: string,
    leg: { participantSid: string; address: string; channelMessageSid: string; state: DeliveryState },
  ): void {
    const profile = this.messaging.takeDeliveryProfile(leg.address);
    const states = plannedTransitions(profile);
    states.forEach((state, i) => {
      // Index 0 is `queued`, which the leg is already seeded with and which
      // real Conversations never reports as a receipt (mirrors FIX 4).
      if (i === 0) return;
      const failState = profile.failState ?? 'failed';
      const errorCode =
        profile.kind === 'fail' && state === failState && profile.errorCode !== undefined
          ? profile.errorCode
          : undefined;
      let generation = -1;
      const cancel = this.clock.schedule(stepDelayMs(i), () => {
        this.messaging.releasePendingCancel(cancel);
        // A reset() bumped the generation while this timer was pending: no-op,
        // exactly like the status-callback path (FIX 1).
        if (!this.messaging.isCurrentGeneration(generation)) return;
        leg.state = state;
        this.messaging.advanceLegState(leg.channelMessageSid, leg.address, state, errorCode);
        this.emitUpdated(record);
        const params = buildConversationsDeliveryParams({
          conversationSid: record.sid,
          messageSid,
          participantSid: leg.participantSid,
          status: state,
          channelMessageSid: leg.channelMessageSid,
          dateCreated: this.clock.nowIso(),
          ...(errorCode !== undefined && { errorCode }),
        });
        void this.dispatch(messageSid, params);
      });
      generation = this.messaging.trackPendingCancel(cancel);
    });
  }

  /**
   * A carrier-sourced `onMessageAdded`: the shape a real inbound carrier group
   * text produces once the thread is railed. Dispatched by `sendGroupAsParty`
   * when the sender is a participant, and by the control seam for the guardrail
   * tests that need an event with no classic counterpart.
   */
  async dispatchMessageAdded(input: {
    record: ConversationRecord;
    messageSid?: string;
    author?: string;
    body?: string;
    source?: 'SMS' | 'API' | 'SDK';
    participantSid?: string;
    index?: number;
  }): Promise<string> {
    const messageSid = input.messageSid ?? this.mintSid('IM');
    const params = buildConversationsMessageAddedParams({
      conversationSid: input.record.sid,
      messageSid,
      source: input.source ?? 'SMS',
      dateCreated: this.clock.nowIso(),
      ...(input.author !== undefined && { author: input.author }),
      ...(input.body !== undefined && { body: input.body }),
      ...(input.participantSid !== undefined && { participantSid: input.participantSid }),
      ...(input.index !== undefined && { index: input.index }),
    });
    await this.dispatch(messageSid, params);
    return messageSid;
  }

  /**
   * The rail a handset is a member of, or undefined. Used by the inbound group
   * injection to decide whether a carrier group text binds to a Conversation -
   * an unrailed group thread produces no Conversations event at all, which IS
   * the coverage gap spec 8 states out loud.
   */
  railFor(address: string): ConversationRecord | undefined {
    return this.store.findByMemberAddress(address);
  }

  /** The `MBxx` of a given member on a rail (the receipt's join key). */
  participantFor(record: ConversationRecord, address: string): string | undefined {
    return record.participants.find((p) => p.address === address)?.sid;
  }

  listSnapshots(): ConversationSnapshot[] {
    return this.store.list().map((r) => ConversationsStore.snapshot(r));
  }

  getDispatchErrors(): typeof this.dispatchErrors {
    return [...this.dispatchErrors];
  }

  private async dispatch(sid: string, params: Record<string, string>): Promise<void> {
    // A28: `post` - form-encoded, X-Twilio-Signature signed, x-origin-verify.
    // Never postJson (a different signature scheme) and never postEventsBatch
    // (deliberately unsigned; that is the A2P Event Streams sink only).
    try {
      const status = await this.dispatcher.post(CONVERSATIONS_WEBHOOK_PATH, params);
      if (status < 200 || status >= 300) {
        this.recordDispatchError({
          sid,
          path: CONVERSATIONS_WEBHOOK_PATH,
          status,
          at: this.clock.nowIso(),
        });
      }
    } catch (err) {
      this.recordDispatchError({
        sid,
        path: CONVERSATIONS_WEBHOOK_PATH,
        error: err instanceof Error ? err.message : String(err),
        at: this.clock.nowIso(),
      });
    }
  }

  private recordDispatchError(e: {
    sid?: string;
    path: string;
    status?: number;
    error?: string;
    at: string;
  }): void {
    this.dispatchErrors.push(e);
    if (this.dispatchErrors.length > 50) this.dispatchErrors.shift();
  }
}

/** Twilio's 50407 - the error a wrong participant shape actually returns. */
export class InvalidMessagingBindingError extends Error {
  readonly code = 50407;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export { DuplicateUniqueNameError };
