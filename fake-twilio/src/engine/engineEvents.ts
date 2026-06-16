// fake-twilio/src/engine/engineEvents.ts
//
// The EngineEvent union — a live engine state-change, streamed to the fake-phones
// UI over SSE. Both engines (messaging + the Phase 5 CallEngine) emit through the
// shared EventHub, so the union lives here, decoupled from any single engine.
import type { Persona, ThreadMessage } from './types.js';
import type { CallState } from './voiceTypes.js';

export type EngineEvent =
  // ---- messaging (SMS/MMS) variants ----
  | { type: 'message.appended'; partyNumber: string; message: ThreadMessage }
  | { type: 'message.updated'; partyNumber: string; message: ThreadMessage }
  | { type: 'persona.added'; persona: Persona }
  | { type: 'reset' }
  // ---- voice (call) variants ----
  | { type: 'call.placed'; call: CallState }
  | { type: 'call.whisper'; call: CallState }
  | { type: 'call.answered'; call: CallState }
  | { type: 'call.completed'; call: CallState }
  | { type: 'call.recording'; call: CallState }
  | { type: 'call.transcript'; call: CallState };

export type EngineListener = (event: EngineEvent) => void;
