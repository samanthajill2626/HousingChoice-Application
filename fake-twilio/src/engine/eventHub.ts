// fake-twilio/src/engine/eventHub.ts
//
// The shared event bus. Both the messaging engine and (Phase 5) the CallEngine emit
// through ONE EventHub, and the SSE route subscribes to it. A throwing listener
// (e.g. a dead SSE socket) must never break emit — that guarantee is load-bearing.
import type { EngineEvent, EngineListener } from './engineEvents.js';

export type { EngineListener } from './engineEvents.js';

export class EventHub {
  private readonly listeners = new Set<EngineListener>();

  /** Subscribe to live engine events; returns an unsubscribe fn. */
  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A misbehaving subscriber (e.g. a dead SSE socket) must never break the engine.
      }
    }
  }
}
