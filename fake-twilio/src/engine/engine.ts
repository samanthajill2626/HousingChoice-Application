// fake-twilio/src/engine/engine.ts
import type { Clock } from './clock.js';
import { PersonaRegistry, APP_NUMBER } from './registry.js';
import { ConversationStore } from './store.js';
import { GroupStore } from './groups.js';
import { buildInboundSmsParams, buildStatusParams, type WebhookParams } from './signer.js';
import { plannedTransitions, stepDelayMs } from './delivery.js';
import type {
  AddAdHocInput, DeliveryProfile, DeliveryState, GroupSnapshot, Persona, SendAsPartyInput,
  SetDeliveryOutcomeInput, Thread, ThreadMessage,
} from './types.js';
import type { EventHub } from './eventHub.js';
import type { EngineEvent, EngineListener } from './engineEvents.js';
import { parseTwimlMessages } from './twimlSms.js';

// The EngineEvent union + listener type now live in ./engineEvents.js (shared by the
// messaging engine and the Phase 5 CallEngine). Re-exported here for back-compat with
// existing importers.
export type { EngineEvent, EngineListener } from './engineEvents.js';

/** The dispatcher surface the engine needs (real WebhookDispatcher in prod, stub in tests). */
export interface Dispatcher {
  post(path: string, params: WebhookParams): Promise<number>;
  /**
   * Like post, but hands back the response BODY too. The inbound-SMS dispatch
   * uses this when available to render the webhook's TwiML <Message> replies
   * as texts back to the sender - what real Twilio does, and what the fake
   * silently dropped until 2026-08-24 (every keyword confirmation was
   * invisible to the fake phones). Optional so bare status-only stubs in
   * older tests keep compiling; without it, replies are simply not rendered.
   */
  postForResponse?(path: string, params: WebhookParams): Promise<{ status: number; body: string }>;
}

/** A recorded dispatch failure (non-2xx or rejection), exposed via getDispatchErrors(). */
export interface DispatchError {
  sid?: string;
  path: string;
  status?: number;
  error?: string;
  at: string;
}

/** Modest robustness caps on the untrusted control surface (sendAsParty). */
const MAX_BODY_LEN = 10000;
const MAX_MEDIA_URLS = 25;
/** Twilio caps a group MMS at 10 handsets; the parser scans to index 32. */
const MAX_OTHER_RECIPIENTS = 32;
/** Cap on the in-engine dispatch-error ring buffer. */
const MAX_DISPATCH_ERRORS = 50;

/** Strict E.164: a leading '+', a non-zero first digit, then 1..14 more digits. */
const E164_RE = /^\+[1-9]\d{1,14}$/;
export function isE164(s: string): boolean {
  return E164_RE.test(s);
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface FakeTwilioEngineDeps {
  clock: Clock;
  dispatcher: Dispatcher;
  /** The shared event bus — both the messaging engine and the CallEngine emit through it. */
  hub: EventHub;
  /** Defaults to APP_NUMBER. */
  appNumber?: string;
  registry?: PersonaRegistry;
  store?: ConversationStore;
  /** Starting value for the SMS/MMS SID counter. Defaults to a random HIGH base
   *  (see {@link randomSidSeqStart}) so a restarted fake never re-mints a prior
   *  process's low SIDs — which would collide with `sid#` dedup pointers still in a
   *  reused DB and cause the inbound to be DROPPED. Pin it in tests for determinism. */
  sidSeqStart?: number;
}

/** A random high base for the SID counter, in [10_000_000, 90_000_000). The
 *  counter is encoded as 32 hex digits so the fake emits provider-shaped SIDs,
 *  while the high start keeps restarted process ranges from colliding. */
function randomSidSeqStart(): number {
  return 10_000_000 + Math.floor(Math.random() * 80_000_000);
}

export class FakeTwilioEngine {
  private readonly clock: Clock;
  private readonly dispatcher: Dispatcher;
  private readonly appNumber: string;
  private readonly registry: PersonaRegistry;
  private readonly store: ConversationStore;
  /** Traffic-derived relay-group state (spec §4) — an ADDITIONAL view; pool
   *  legs still land in the recipient persona's 1:1 thread exactly as before. */
  private readonly groups = new GroupStore();
  private readonly nextProfile = new Map<string, DeliveryProfile>();
  private sidSeq: number;
  /** Cancel fns for every still-pending scheduled status callback (FIX 1). */
  private readonly pendingCancels = new Set<() => void>();
  /** Bumped on reset(); scheduled callbacks captured under an older generation no-op (FIX 1). */
  private generation = 0;
  /** Ring buffer of recent dispatch failures (FIX 2). */
  private readonly dispatchErrors: DispatchError[] = [];
  /** The shared event bus this engine emits through; the SSE endpoint subscribes to
   *  it directly. Public so the server can derive the events-router hub from the
   *  (injected-or-constructed) engine — making one hub authoritative by construction. */
  readonly hub: EventHub;

  constructor(deps: FakeTwilioEngineDeps) {
    this.clock = deps.clock;
    this.dispatcher = deps.dispatcher;
    this.hub = deps.hub;
    this.appNumber = deps.appNumber ?? APP_NUMBER;
    this.registry = deps.registry ?? new PersonaRegistry();
    this.store = deps.store ?? new ConversationStore();
    this.sidSeq = deps.sidSeqStart ?? randomSidSeqStart();
  }

  /** Subscribe to live engine events; returns an unsubscribe fn. Delegates to the
   *  shared hub (back-compat for callers that subscribe via the engine). */
  subscribe(listener: EngineListener): () => void {
    return this.hub.subscribe(listener);
  }

  private emit(event: EngineEvent): void {
    this.hub.emit(event);
  }

  private mintSid(prefix: 'SM' | 'MM'): string {
    this.sidSeq += 1;
    return `${prefix}${this.sidSeq.toString(16).padStart(32, '0')}`;
  }

  list(): Persona[] {
    return this.registry.list();
  }
  listThreads(): Thread[] {
    return this.store.listThreads();
  }
  /** Traffic-inferred relay groups (spec §4) — the `GET /control/groups` payload. */
  listGroups(): GroupSnapshot[] {
    return this.groups.listGroups();
  }
  addAdHoc(input: AddAdHocInput): Persona {
    if (input.number !== undefined) {
      const normalized = input.number.trim();
      // App-number near-miss: reject numbers that normalize to our own number, so a
      // stray '+15550009999 ' can't impersonate the app side of a thread.
      if (normalized === this.appNumber || this.registry.isAppNumber(normalized)) {
        throw new Error(`addAdHoc: ${input.number} is the app number, not a party`);
      }
      if (!isE164(normalized)) {
        throw new Error(`addAdHoc: ${input.number} is not a valid E.164 number`);
      }
      const persona = this.registry.addAdHoc({ ...input, number: normalized });
      this.emit({ type: 'persona.added', persona });
      return persona;
    }
    const persona = this.registry.addAdHoc(input);
    this.emit({ type: 'persona.added', persona });
    return persona;
  }
  setDeliveryOutcome(input: SetDeliveryOutcomeInput): void {
    const channelPrefix = input.profile.transportEvidence?.channelPrefix;
    if (channelPrefix !== undefined && channelPrefix !== 'rcs') {
      throw new TypeError('transportEvidence.channelPrefix must be rcs when supplied');
    }
    this.nextProfile.set(input.partyNumber, input.profile);
  }
  reset(): void {
    // Cancel every in-flight status-callback timer so a stale 'delivered' webhook
    // can't fire against a freshly-reseeded app (FIX 1). Bump the generation so any
    // callback that somehow still runs (e.g. RealClock race) no-ops defensively.
    this.generation += 1;
    for (const cancel of this.pendingCancels) cancel();
    this.pendingCancels.clear();
    this.store.reset();
    // Groups are traffic-derived state, so they reset with traffic (§4.4).
    // Personas persist, as before.
    this.groups.reset();
    this.nextProfile.clear();
    this.emit({ type: 'reset' });
  }

  /** Recent dispatch failures (non-2xx or rejected POSTs), newest last (FIX 2). */
  getDispatchErrors(): DispatchError[] {
    return [...this.dispatchErrors];
  }

  private recordDispatchError(e: DispatchError): void {
    this.dispatchErrors.push(e);
    if (this.dispatchErrors.length > MAX_DISPATCH_ERRORS) this.dispatchErrors.shift();
  }

  /** A party sends an inbound text to the app: record it + POST a signed /sms webhook. */
  async sendAsParty(input: SendAsPartyInput): Promise<string> {
    const persona = this.registry.byNumber(input.from);
    if (!persona) throw new Error(`sendAsParty: unknown party number ${input.from}`);
    // FIX 5: validate `to` (defaults to the app number, which is expected); only a
    // malformed explicit `to` is rejected.
    if (input.to !== undefined && !isE164(input.to)) {
      throw new Error(`sendAsParty: 'to' ${input.to} is not a valid E.164 number`);
    }
    // FIX 6: modest caps on this untrusted control surface.
    if (input.body !== undefined && input.body.length > MAX_BODY_LEN) {
      throw new Error(`sendAsParty: body exceeds ${MAX_BODY_LEN} characters`);
    }
    if (input.mediaUrls !== undefined) {
      if (input.mediaUrls.length > MAX_MEDIA_URLS) {
        throw new Error(`sendAsParty: mediaUrls exceeds ${MAX_MEDIA_URLS} entries`);
      }
      // FIX 5: every media URL must be http(s).
      for (const url of input.mediaUrls) {
        if (!isHttpUrl(url)) throw new Error(`sendAsParty: mediaUrl ${url} is not an http(s) URL`);
      }
    }
    if (input.otherRecipients !== undefined) {
      if (input.otherRecipients.length > MAX_OTHER_RECIPIENTS) {
        throw new Error(`sendAsParty: otherRecipients exceeds ${MAX_OTHER_RECIPIENTS} entries`);
      }
      for (const other of input.otherRecipients) {
        if (!isE164(other)) {
          throw new Error(`sendAsParty: otherRecipient ${other} is not a valid E.164 number`);
        }
      }
    }
    const to = input.to ?? this.appNumber;
    const hasMedia = (input.mediaUrls?.length ?? 0) > 0;
    // A28: the prefix is normally derived from media presence alone, which makes
    // the tripwire shape (MM + NumMedia=0) unproducible. An explicit override
    // wins, and is the ONLY way that shape is reachable.
    const sid = this.mintSid(input.sidShape ?? (hasMedia ? 'MM' : 'SM'));
    const now = this.clock.nowIso();
    const message: ThreadMessage = {
      sid, direction: 'inbound', from: input.from, to,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
      state: 'delivered', createdAt: now, updatedAt: now,
    };
    this.store.append(input.from, message);
    this.emit({ type: 'message.appended', partyNumber: input.from, message });
    // Relay-group inference (spec §4.1): an EXPLICIT non-app `to` is a pool
    // number — this is a member→group message. Observed BEFORE the webhook
    // dispatch so group state stays consistent with the thread append above
    // even when the app rejects the webhook (both retain the message).
    // APP_NUMBER traffic (the default `to`) never touches a group.
    if (input.to !== undefined && to !== this.appNumber) {
      const group = this.groups.observeInbound({
        poolNumber: to, from: input.from, fromLabel: persona.label, sid,
        ...(input.body !== undefined && { body: input.body }),
        ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
        atIso: now,
      });
      this.emit({ type: 'group.updated', group });
    }
    const params = buildInboundSmsParams({
      messageSid: sid, from: input.from, to,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
      ...(input.otherRecipients !== undefined && { otherRecipients: input.otherRecipients }),
      ...(input.otherRecipientsShape !== undefined && {
        otherRecipientsShape: input.otherRecipientsShape,
      }),
      ...(input.channelPrefix !== undefined && { channelPrefix: input.channelPrefix }),
      ...(input.channelMetadata !== undefined && { channelMetadata: input.channelMetadata }),
    });
    // FIX 2a: surface a rejected inbound webhook (e.g. a signing regression → non-2xx)
    // to the control-API caller instead of silently succeeding.
    //
    // postForResponse when the dispatcher has it: the response BODY is the
    // webhook's TwiML, and real Twilio renders its <Message> verbs as SMS back
    // to the sender. Discarding it left the fake phones showing a STOP with no
    // confirmation on every keyword path (1:1 keywords, closed-group
    // intercept, open-path keywords) - manual QA was half-blind.
    // See docs/issues/fake-phones-no-twiml-replies.md.
    const response =
      this.dispatcher.postForResponse !== undefined
        ? await this.dispatcher.postForResponse('/webhooks/twilio/sms', params)
        : { status: await this.dispatcher.post('/webhooks/twilio/sms', params), body: '' };
    if (response.status < 200 || response.status >= 300) {
      this.recordDispatchError({
        sid,
        path: '/webhooks/twilio/sms',
        status: response.status,
        at: this.clock.nowIso(),
      });
      throw new Error(`sendAsParty: inbound webhook returned ${response.status}`);
    }
    // Deliver each TwiML reply exactly as a real handset would receive it:
    // to the SENDER, from the number they texted (Twilio's default reply
    // addressing; the app's replies never override it). recordOutboundFromApp
    // gives the reply the full outbound treatment - thread append, live
    // events, and, for a pool-number `from`, a single-recipient leg in the
    // group transcript, which is where the operator is looking when a group
    // member texts a keyword.
    for (const reply of parseTwimlMessages(response.body)) {
      this.recordOutboundFromApp({
        to: input.from,
        from: to,
        ...(reply.body !== undefined && { body: reply.body }),
        ...(reply.mediaUrls !== undefined && { mediaUrls: reply.mediaUrls }),
      });
    }
    return sid;
  }

  // -------------------------------------------------------------------------
  // Conversations fan-out legs (native group texting)
  // -------------------------------------------------------------------------
  //
  // A Conversations-originated send reaches each handset as an ordinary carrier
  // message, so it MUST land in that persona's fake-phone thread. What it must
  // NOT do is fire a classic status callback: the S5-PRE addendum proved live
  // that Programmable Messaging status callbacks do NOT fire for
  // Conversations-originated sends (zero callbacks over a window where both legs
  // reached `delivered`). Emitting them here would be worse than cosmetic - the
  // app has no message row under the leg's SMxx, so every leg would produce the
  // "status callback for unknown provider SID" ERROR that spec 12's reply-all
  // test exists to prove ABSENT.
  //
  // Delivery state for these legs therefore arrives SOLELY as `onDeliveryUpdated`
  // events, which the ConversationsEngine schedules and dispatches.

  /**
   * Append one Conversations fan-out leg to a party's thread. Auto-registers an
   * unknown recipient exactly like `recordOutboundFromApp`, mints its own SMxx
   * (the ChannelMessageSid a receipt carries) and schedules NOTHING.
   */
  appendConversationsLeg(input: { to: string; from: string; body?: string }): string {
    if (this.registry.byNumber(input.to) === undefined) {
      try {
        this.addAdHoc({ label: input.to, role: 'unknown', number: input.to });
      } catch {
        /* app-number near-miss or non-E.164 - leave unregistered */
      }
    }
    const sid = this.mintSid('SM');
    const now = this.clock.nowIso();
    const message: ThreadMessage = {
      sid,
      direction: 'outbound',
      from: input.from,
      to: input.to,
      ...(input.body !== undefined && { body: input.body }),
      state: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    this.store.append(input.to, message);
    this.emit({ type: 'message.appended', partyNumber: input.to, message });
    return sid;
  }

  /**
   * Advance a fan-out leg's stored state (and its ErrorCode on a failure), so
   * the fake-phones UI tracks the same progression the receipts carry. No
   * webhook: the ConversationsEngine owns that half.
   */
  advanceLegState(sid: string, partyNumber: string, state: DeliveryState, errorCode?: string): void {
    const updated = this.store.updateState(sid, state);
    if (!updated) return;
    updated.updatedAt = this.clock.nowIso();
    if (errorCode !== undefined) updated.errorCode = errorCode;
    this.emit({ type: 'message.updated', partyNumber, message: updated });
  }

  /**
   * Consume the delivery profile armed for a party via
   * `POST /control/delivery-outcome`. ONE arming API serves both 1:1 sends and
   * group legs - notably the per-member 21610 a STOPped handset produces.
   */
  takeDeliveryProfile(partyNumber: string): DeliveryProfile {
    const profile = this.nextProfile.get(partyNumber) ?? { kind: 'normal' as const };
    this.nextProfile.delete(partyNumber);
    return profile;
  }

  /** Register a cancel fn so `reset()` tears down a Conversations receipt timer
   *  exactly like a status-callback timer, and report the generation it was
   *  captured under so a late callback can no-op. */
  trackPendingCancel(cancel: () => void): number {
    this.pendingCancels.add(cancel);
    return this.generation;
  }

  /** True when the generation a scheduled callback captured is still current. */
  isCurrentGeneration(generation: number): boolean {
    return generation === this.generation;
  }

  /** Drop a fired timer's cancel from the pending set (mirrors FIX 1). */
  releasePendingCancel(cancel: () => void): void {
    this.pendingCancels.delete(cancel);
  }

  /**
   * Called by the REST impersonation route when the app sends an outbound message
   * (messages.create). Records it into the recipient's thread and schedules the
   * status-callback progression for the active delivery profile. Returns the SID.
   */
  recordOutboundFromApp(input: { to: string; from?: string; body?: string; mediaUrls?: string[] }): string {
    // AUTO-REGISTER (DX, 2026-07-02): an app send to a number with NO persona
    // used to land in a thread the UI never shows (the fake-phones UI lists
    // PERSONAS) — the app reported "sent" and the message silently vanished
    // (this bit the founder-cell verify flow: the code SMS was invisible).
    // Materialize an ad-hoc persona labeled by the bare number (no invented
    // name) BEFORE appending, so persona.added reaches the UI first and the
    // send pops up live, immediately usable (read a verify code, reply, STOP).
    // Best-effort: a malformed/app-number `to` keeps the old record-only
    // behavior rather than failing the app's messages.create.
    if (this.registry.byNumber(input.to) === undefined) {
      try {
        this.addAdHoc({ label: input.to, role: 'unknown', number: input.to });
      } catch {
        /* app-number near-miss or non-E.164 — leave unregistered */
      }
    }
    // FIX 3 (defense-in-depth): the REST caller is less-trusted than the seed path;
    // drop any non-http(s) MediaUrl before storing/rendering it as an <img src> —
    // same isHttpUrl gate the inbound (sendAsParty) path enforces. Dropping (vs
    // rejecting) keeps a valid-URL message flowing and a messages.create succeeding.
    const validMediaUrls = input.mediaUrls?.filter((url) => isHttpUrl(url));
    const mediaUrls = validMediaUrls && validMediaUrls.length > 0 ? validMediaUrls : undefined;
    const hasMedia = (mediaUrls?.length ?? 0) > 0;
    const sid = this.mintSid(hasMedia ? 'MM' : 'SM');
    const now = this.clock.nowIso();
    const message: ThreadMessage = {
      sid, direction: 'outbound', from: input.from ?? this.appNumber, to: input.to,
      ...(input.body !== undefined && { body: input.body }),
      ...(mediaUrls !== undefined && { mediaUrls }),
      state: 'queued', createdAt: now, updatedAt: now,
    };
    this.store.append(input.to, message);
    this.emit({ type: 'message.appended', partyNumber: input.to, message });

    // Relay-group inference (spec §4.1): a `from` that isn't the app's business
    // number is a pool number — this leg is part of a group fan-out. Nothing
    // else in the app sends from a non-business number today; a future
    // false-positive would just create a spurious group in this dev tool
    // (accepted, spec §9 — tighten with NumberRegistry.isPool if it ever
    // bites). APP_NUMBER traffic (including the default `from`) never creates
    // or touches a group. The group transcript is an ADDITIONAL view — the
    // thread append above is unchanged.
    if (input.from !== undefined && input.from !== this.appNumber) {
      const group = this.groups.observeOutboundLeg({
        poolNumber: input.from,
        to: input.to,
        // Keep the bare-number label auto-registration produced (or the real
        // persona label when the recipient is known).
        toLabel: this.registry.byNumber(input.to)?.label ?? input.to,
        sid,
        state: message.state,
        ...(input.body !== undefined && { body: input.body }),
        ...(mediaUrls !== undefined && { mediaUrls }),
        atIso: now,
      });
      this.emit({ type: 'group.updated', group });
    }

    const profile = this.nextProfile.get(input.to) ?? { kind: 'normal' as const };
    this.nextProfile.delete(input.to);
    // The create-response carries 'queued' (set on the stored message above). Real
    // Twilio's status callbacks START at 'sent' — the 'queued' state has no callback
    // (FIX 4) — so we still STORE every planned state for the timeline but SKIP
    // emitting a callback for index 0 ('queued'). Each callback is scheduled at a
    // strictly-increasing step delay (FIX 3) so ManualClock.flush() and real timers
    // fire them in planned order regardless of progression length.
    const states = plannedTransitions(profile);
    const myGeneration = this.generation;
    states.forEach((state, i) => {
      const cancel = this.clock.schedule(stepDelayMs(i), () => {
        // FIX 1: this callback fired — drop its own cancel from the pending set.
        this.pendingCancels.delete(cancel);
        // FIX 1 (belt-and-suspenders): a reset() bumped the generation; no-op.
        if (myGeneration !== this.generation) return;
        const updated = this.store.updateState(sid, state);
        if (updated) {
          updated.updatedAt = this.clock.nowIso();
          // FIX 2: when this resolves to the profile's fail state, persist the
          // Twilio ErrorCode on the message itself (not just the status webhook)
          // so the UI can render it — set it BEFORE emitting so the event carries it.
          if (
            profile.kind === 'fail' &&
            state === (profile.failState ?? 'failed') &&
            profile.errorCode !== undefined
          ) {
            updated.errorCode = profile.errorCode;
          }
          this.emit({ type: 'message.updated', partyNumber: input.to, message: updated });
          // If this SID is a relay-group fan-out leg, advance its delivery slot
          // too, so per-recipient chips track the same status-callback flow.
          // (updated.errorCode is only ever set by the fail-state branch above,
          // so passing it through mirrors the message's own error handling.)
          const group = this.groups.updateSlotState(sid, state, updated.errorCode);
          if (group) this.emit({ type: 'group.updated', group });
        }
        // FIX 4: skip the status callback for the initial 'queued' state (index 0).
        if (i === 0) return;
        const params = buildStatusParams({
          messageSid: sid, status: state,
          from: profile.transportEvidence?.from ?? message.from,
          to: profile.transportEvidence?.to ?? message.to,
          ...(profile.transportEvidence?.channelPrefix !== undefined && {
            channelPrefix: profile.transportEvidence.channelPrefix,
          }),
          ...(profile.transportEvidence?.channelMetadata !== undefined && {
            channelMetadata: profile.transportEvidence.channelMetadata,
          }),
          ...(profile.kind === 'fail' && state === (profile.failState ?? 'failed') && profile.errorCode !== undefined
            ? { errorCode: profile.errorCode }
            : {}),
        });
        // FIX 2b/2c: never leave a status-callback dispatch unhandled. Record non-2xx
        // responses and rejections into the dispatch-error ring buffer.
        this.dispatcher
          .post('/webhooks/twilio/status', params)
          .then((dispatchStatus) => {
            if (dispatchStatus < 200 || dispatchStatus >= 300) {
              this.recordDispatchError({
                sid, path: '/webhooks/twilio/status', status: dispatchStatus, at: this.clock.nowIso(),
              });
            }
          })
          .catch((err: unknown) => {
            this.recordDispatchError({
              sid, path: '/webhooks/twilio/status',
              error: err instanceof Error ? err.message : String(err),
              at: this.clock.nowIso(),
            });
          });
      });
      this.pendingCancels.add(cancel);
    });
    return sid;
  }
}
