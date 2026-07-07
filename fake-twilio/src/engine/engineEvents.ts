// fake-twilio/src/engine/engineEvents.ts
//
// The EngineEvent union — a live engine state-change, streamed to the fake-phones
// UI over SSE. Both engines (messaging + the Phase 5 CallEngine) emit through the
// shared EventHub, so the union lives here, decoupled from any single engine.
import type { GroupSnapshot, Persona, ThreadMessage } from './types.js';
import type { CallState } from './voiceTypes.js';

export type EngineEvent =
  // ---- messaging (SMS/MMS) variants ----
  | { type: 'message.appended'; partyNumber: string; message: ThreadMessage }
  | { type: 'message.updated'; partyNumber: string; message: ThreadMessage }
  | { type: 'persona.added'; persona: Persona }
  // Relay-group inference: emitted on EVERY group mutation (creation, burst
  // append, inbound, roster change, delivery-slot advance), carrying the whole
  // recomputed group — the web replaces-or-appends by poolNumber. The web
  // package hand-mirrors this variant AND must list 'group.updated' in its SSE
  // EVENT_TYPES allowlist, or the frame is silently dropped.
  | { type: 'group.updated'; group: GroupSnapshot }
  | { type: 'reset' }
  // ---- voice (call) variants ----
  | { type: 'call.placed'; call: CallState }
  | { type: 'call.whisper'; call: CallState }
  | { type: 'call.answered'; call: CallState }
  | { type: 'call.completed'; call: CallState }
  | { type: 'call.recording'; call: CallState }
  | { type: 'call.transcript'; call: CallState };

export type EngineListener = (event: EngineEvent) => void;
