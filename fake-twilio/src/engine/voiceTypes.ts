// fake-twilio/src/engine/voiceTypes.ts
//
// Minimal voice types needed for the EngineEvent union to compile (Phase 4).
// Phase 5 (CallEngine) EXTENDS this file with CallScenario, the registry types,
// etc. — keep these shapes stable so Phase 5 builds on them rather than rewriting.

/** One party leg of a call (the dialed/dialing side). */
export interface CallLeg {
  phone: string;
  whisperUrl?: string;
  answered: boolean;
}

/** Masked = two legs bridged via the app number; founder = founder-cell dial-through;
 *  outbound = a plain app-initiated outbound call. */
export type CallKind = 'masked' | 'founder' | 'outbound';

/** A scripted call outcome the test/control surface injects into the CallEngine to
 *  drive a placed call deterministically (which leg answers, the DTMF gate digit,
 *  ring time, recording, and the terminal bridge outcome). All fields optional —
 *  the engine fills sensible defaults (callee answers, digit '1', answered). */
export interface CallScenario {
  answerLeg?: 'callee' | 'founder' | 'team';
  digit?: '0' | '1' | null;
  ringMs?: number;
  record?: boolean;
  transcript?: string;
  outcome?: 'answered' | 'no-answer' | 'busy';
}

export type CallStatus = 'ringing' | 'in-progress' | 'completed' | 'no-answer' | 'busy';

export interface CallState {
  callSid: string;
  from: string;
  to: string;
  kind: CallKind;
  status: CallStatus;
  /** The DTMF digit captured (e.g. a whisper accept/decline), when present. */
  digit?: string;
  legs: CallLeg[];
  recordingSid?: string;
  recordingUrl?: string;
  transcript?: string;
  /** ISO-8601 (matches ThreadMessage); the CallEngine sets these via clock.nowIso(). */
  createdAt: string;
  updatedAt: string;
}
