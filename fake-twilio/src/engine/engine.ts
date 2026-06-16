// fake-twilio/src/engine/engine.ts
import type { Clock } from './clock.js';
import { PersonaRegistry, APP_NUMBER } from './registry.js';
import { ConversationStore } from './store.js';
import { buildInboundSmsParams, buildStatusParams, type WebhookParams } from './signer.js';
import { plannedTransitions, STEP_DELAYS_MS } from './delivery.js';
import type {
  AddAdHocInput, DeliveryProfile, Persona, SendAsPartyInput, SetDeliveryOutcomeInput, Thread, ThreadMessage,
} from './types.js';

/** The dispatcher surface the engine needs (real WebhookDispatcher in prod, stub in tests). */
export interface Dispatcher {
  post(path: string, params: WebhookParams): Promise<number>;
}

export interface FakeTwilioEngineDeps {
  clock: Clock;
  dispatcher: Dispatcher;
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

  constructor(deps: FakeTwilioEngineDeps) {
    this.clock = deps.clock;
    this.dispatcher = deps.dispatcher;
    this.appNumber = deps.appNumber ?? APP_NUMBER;
    this.registry = deps.registry ?? new PersonaRegistry();
    this.store = deps.store ?? new ConversationStore();
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
    return this.registry.addAdHoc(input);
  }
  setDeliveryOutcome(input: SetDeliveryOutcomeInput): void {
    this.nextProfile.set(input.partyNumber, input.profile);
  }
  reset(): void {
    this.store.reset();
    this.nextProfile.clear();
  }

  /** A party sends an inbound text to the app: record it + POST a signed /sms webhook. */
  async sendAsParty(input: SendAsPartyInput): Promise<string> {
    const persona = this.registry.byNumber(input.from);
    if (!persona) throw new Error(`sendAsParty: unknown party number ${input.from}`);
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
    const params = buildInboundSmsParams({
      messageSid: sid, from: input.from, to,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
    });
    await this.dispatcher.post('/webhooks/twilio/sms', params);
    return sid;
  }

  /**
   * Called by the REST impersonation route when the app sends an outbound message
   * (messages.create). Records it into the recipient's thread and schedules the
   * status-callback progression for the active delivery profile. Returns the SID.
   */
  recordOutboundFromApp(input: { to: string; from?: string; body?: string; mediaUrls?: string[] }): string {
    const hasMedia = (input.mediaUrls?.length ?? 0) > 0;
    const sid = this.mintSid(hasMedia ? 'MM' : 'SM');
    const now = this.clock.nowIso();
    const message: ThreadMessage = {
      sid, direction: 'outbound', from: input.from ?? this.appNumber, to: input.to,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.mediaUrls !== undefined && { mediaUrls: input.mediaUrls }),
      state: 'queued', createdAt: now, updatedAt: now,
    };
    this.store.append(input.to, message);

    const profile = this.nextProfile.get(input.to) ?? { kind: 'normal' as const };
    this.nextProfile.delete(input.to);
    // The create-response carries 'queued' (set on the stored message above); the
    // status-callback progression then walks every planned state, including 'queued',
    // so the app receives the full status timeline. Each state is scheduled at its
    // step delay so ManualClock.flush() (and real timers) fire them in ascending
    // order: queued (0ms) → sent (150ms) → final (350ms).
    const states = plannedTransitions(profile);
    states.forEach((state, i) => {
      this.clock.schedule(STEP_DELAYS_MS[i] ?? 350, () => {
        const updated = this.store.updateState(sid, state);
        if (updated) updated.updatedAt = this.clock.nowIso();
        const params = buildStatusParams({
          messageSid: sid, status: state,
          ...(profile.kind === 'fail' && state === (profile.failState ?? 'failed') && profile.errorCode !== undefined
            ? { errorCode: profile.errorCode }
            : {}),
        });
        void this.dispatcher.post('/webhooks/twilio/status', params);
      });
    });
    return sid;
  }
}
