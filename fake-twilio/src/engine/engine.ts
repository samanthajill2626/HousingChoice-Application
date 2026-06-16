// fake-twilio/src/engine/engine.ts
import type { Clock } from './clock.js';
import { PersonaRegistry, APP_NUMBER } from './registry.js';
import { ConversationStore } from './store.js';
import { buildInboundSmsParams, buildStatusParams, type WebhookParams } from './signer.js';
import { plannedTransitions, stepDelayMs } from './delivery.js';
import type {
  AddAdHocInput, DeliveryProfile, Persona, SendAsPartyInput, SetDeliveryOutcomeInput, Thread, ThreadMessage,
} from './types.js';
import type { EventHub } from './eventHub.js';
import type { EngineEvent, EngineListener } from './engineEvents.js';

// The EngineEvent union + listener type now live in ./engineEvents.js (shared by the
// messaging engine and the Phase 5 CallEngine). Re-exported here for back-compat with
// existing importers.
export type { EngineEvent, EngineListener } from './engineEvents.js';

/** The dispatcher surface the engine needs (real WebhookDispatcher in prod, stub in tests). */
export interface Dispatcher {
  post(path: string, params: WebhookParams): Promise<number>;
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
}

export class FakeTwilioEngine {
  private readonly clock: Clock;
  private readonly dispatcher: Dispatcher;
  private readonly appNumber: string;
  private readonly registry: PersonaRegistry;
  private readonly store: ConversationStore;
  private readonly nextProfile = new Map<string, DeliveryProfile>();
  private sidSeq = 0;
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
    return `${prefix}fake${String(this.sidSeq).padStart(8, '0')}`;
  }

  list(): Persona[] {
    return this.registry.list();
  }
  listThreads(): Thread[] {
    return this.store.listThreads();
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
    const to = input.to ?? this.appNumber;
    const hasMedia = (input.mediaUrls?.length ?? 0) > 0;
    const sid = this.mintSid(hasMedia ? 'MM' : 'SM');
    const now = this.clock.nowIso();
    const message: ThreadMessage = {
      sid, direction: 'inbound', from: input.from, to,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
      state: 'delivered', createdAt: now, updatedAt: now,
    };
    this.store.append(input.from, message);
    this.emit({ type: 'message.appended', partyNumber: input.from, message });
    const params = buildInboundSmsParams({
      messageSid: sid, from: input.from, to,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
    });
    // FIX 2a: surface a rejected inbound webhook (e.g. a signing regression → non-2xx)
    // to the control-API caller instead of silently succeeding.
    const status = await this.dispatcher.post('/webhooks/twilio/sms', params);
    if (status < 200 || status >= 300) {
      this.recordDispatchError({ sid, path: '/webhooks/twilio/sms', status, at: this.clock.nowIso() });
      throw new Error(`sendAsParty: inbound webhook returned ${status}`);
    }
    return sid;
  }

  /**
   * Called by the REST impersonation route when the app sends an outbound message
   * (messages.create). Records it into the recipient's thread and schedules the
   * status-callback progression for the active delivery profile. Returns the SID.
   */
  recordOutboundFromApp(input: { to: string; from?: string; body?: string; mediaUrls?: string[] }): string {
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
        }
        // FIX 4: skip the status callback for the initial 'queued' state (index 0).
        if (i === 0) return;
        const params = buildStatusParams({
          messageSid: sid, status: state,
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
