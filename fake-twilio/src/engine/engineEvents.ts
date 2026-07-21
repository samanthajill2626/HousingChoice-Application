// fake-twilio/src/engine/engineEvents.ts
//
// The EngineEvent union — a live engine state-change, streamed to the fake-phones
// UI over SSE. Both engines (messaging + the Phase 5 CallEngine) emit through the
// shared EventHub, so the union lives here, decoupled from any single engine.
import type { GroupSnapshot, Persona, ThreadMessage } from './types.js';
import type { CallState } from './voiceTypes.js';
import type { InboundEmailRecord, StoredEmail } from './mailStore.js';

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
  | { type: 'call.transcript'; call: CallState }
  // ---- email (fake-SES) variants ----
  // Emitted when the app sends an outbound email through the fake-SES REST surface
  // (mailEngine.recordOutbound), and when the fake delivers an inbound email
  // (mailEngine.sendInbound, email-channel B4). The fake-phones UI does NOT consume
  // either (no mail panel this slice), so both are intentionally ABSENT from the web
  // SSE EVENT_TYPES allowlist + web type mirror - EventSource silently drops them
  // there, by design.
  | { type: 'mail.outbound'; mail: StoredEmail }
  | { type: 'mail.inbound'; mail: InboundEmailRecord };

export type EngineListener = (event: EngineEvent) => void;
