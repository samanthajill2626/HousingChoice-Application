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

/** Per-step delay (ms) — seeded constants, NOT Math.random, so runs are deterministic. */
export const STEP_DELAYS_MS: Record<number, number> = { 0: 0, 1: 150, 2: 350 };
