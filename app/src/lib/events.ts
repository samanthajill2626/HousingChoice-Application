// In-process typed event bus (M1.2) — the live-update spine of the
// conversation hub: mutation paths emit, the GET /api/events SSE route
// subscribes and streams to dashboards.
//
// *** SINGLE-INSTANCE ASSUMPTION (load-bearing, on purpose) ***
// The one app process on the one EC2 box serves BOTH the mutation paths
// (Twilio webhooks, /api sends, delivery callbacks) AND the SSE stream, so an
// in-process EventEmitter reaches every connected dashboard client. If the
// app ever scales past a single instance — or webhooks ever move off the
// SSE-serving process — THIS MODULE IS THE SEAM: replace the singleton with a
// consumer of the DynamoDB streams already enabled on the messages table
// (lib/tables.ts) and fan out from there. Emitters and the SSE route keep
// their contracts; only this module's internals change.
//
// PII note (doc §9): event payloads carry the denormalized inbox preview
// (already truncated by toPreview). They are DATA for authenticated dashboard
// clients — they must never be logged.
import { EventEmitter } from 'node:events';
import { logger as defaultLogger, type Logger } from './logger.js';
import type { DeliveryStatus, MessageDirection } from '../repos/messagesRepo.js';

/** An inbox row changed — re-sort/re-render one conversation summary. */
export interface ConversationUpdatedEvent {
  conversationId: string;
  last_activity_at: string;
  unread_count: number;
  /** Denormalized preview (truncated); absent when the conversation has none. */
  preview?: string;
}

/** A message landed on the timeline, or its delivery status really moved. */
export interface MessagePersistedEvent {
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection;
  deliveryStatus: DeliveryStatus;
}

export interface AppEventMap {
  'conversation.updated': ConversationUpdatedEvent;
  'message.persisted': MessagePersistedEvent;
}

export type AppEventName = keyof AppEventMap;

/** Typed wrapper over EventEmitter — payloads are checked per event name. */
export interface EventBus {
  emit<K extends AppEventName>(event: K, payload: AppEventMap[K]): void;
  on<K extends AppEventName>(event: K, listener: (payload: AppEventMap[K]) => void): void;
  off<K extends AppEventName>(event: K, listener: (payload: AppEventMap[K]) => void): void;
  /** Current listener count — disconnect-cleanup assertions in tests. */
  listenerCount(event: AppEventName): number;
}

/** Fresh isolated bus (tests); production shares the appEvents singleton. */
export function createEventBus(deps: { logger?: Logger } = {}): EventBus {
  const emitter = new EventEmitter();
  const log = deps.logger ?? defaultLogger;
  // One listener pair per connected SSE client: the default max-listeners
  // warning (10) would fire at five open dashboards. Uncapped is safe here —
  // the SSE route removes its listeners on every disconnect.
  emitter.setMaxListeners(0);
  return {
    emit(event, payload) {
      // Per-listener isolation: a throwing listener (e.g. one broken SSE
      // client's write) must never propagate into the EMITTER's caller —
      // the webhook/send pipelines — or starve the other listeners. ERROR
      // is correlated via the pino mixin (the emitter's active context);
      // the payload is never logged (it carries the preview — PII, doc §9).
      for (const listener of emitter.listeners(event)) {
        try {
          (listener as (p: AppEventMap[typeof event]) => void)(payload);
        } catch (err) {
          log.error({ err, event }, 'event bus listener threw — isolated, other listeners unaffected');
        }
      }
    },
    on(event, listener) {
      emitter.on(event, listener);
    },
    off(event, listener) {
      emitter.off(event, listener);
    },
    listenerCount(event) {
      return emitter.listenerCount(event);
    },
  };
}

/** The process-wide bus (see the single-instance assumption above). */
export const appEvents: EventBus = createEventBus();
