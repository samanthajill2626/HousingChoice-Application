// fake-twilio/src/engine/delivery.ts
import type { DeliveryProfile, DeliveryState } from './types.js';

/**
 * The ordered status states the fake emits for an outbound message under a given
 * delivery profile. Each non-initial state becomes a status callback to the app.
 */
export function plannedTransitions(profile: DeliveryProfile): DeliveryState[] {
  switch (profile.kind) {
    case 'normal':
      return ['queued', 'sent', 'delivered'];
    case 'stall': {
      const stallAt = profile.stallAt ?? 'sent';
      const full: DeliveryState[] = ['queued', 'sent', 'delivered'];
      const idx = full.indexOf(stallAt);
      return full.slice(0, idx < 0 ? full.length : idx + 1);
    }
    case 'fail':
      return ['queued', 'sent', profile.failState ?? 'failed'];
  }
}

/**
 * Per-step delay (ms) for the status-callback progression. Strictly increasing in
 * the step index so ManualClock.flush() (and real timers) fire callbacks in planned
 * order for ANY progression length — not just the historical 3-state table. Seeded
 * (linear), NOT Math.random, so runs are deterministic.
 */
export function stepDelayMs(stepIndex: number): number {
  return stepIndex * 150;
}
