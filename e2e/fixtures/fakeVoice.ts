import type { APIRequestContext } from '@playwright/test';

// Voice CONTROL-API client (Phase 8) — the scripted-test surface for the
// fake-twilio CallEngine, mirroring fixtures/fakeTwilio.ts (free functions over
// an APIRequestContext, base URL from FAKE_TWILIO_URL). It drives the fake's
// voice control router (fake-twilio/src/routes/voiceControl.ts) the SAME way
// fakeTwilio.ts drives the messaging control router:
//   POST /control/place-call       {from,to,scenario?} → {callSid}
//   GET  /control/calls            → {calls: CallState[]}
//   POST /control/calls/:sid/press {digit}             → {call}
//
// Placing a call with a scenario makes the fake POST the REAL app voice webhooks
// (/webhooks/twilio/voice → whisper → gate → <Dial action> status, and for a
// recorded founder-bridge the recording + transcription callbacks), exactly as
// Twilio's voice runtime would — so the app persists/updates the `call` entity
// the specs then assert against via the app's own surface.
//
// The control API talks to the fake host DIRECTLY (its own origin, :8889), NOT
// through the Vite proxy — same as fakeTwilio.ts.
const FAKE_BASE = process.env.FAKE_TWILIO_URL ?? 'http://localhost:8889';

/** A scripted call outcome injected into the CallEngine (mirrors the fake's
 *  CallScenario in fake-twilio/src/engine/voiceTypes.ts). All fields optional —
 *  the engine fills sensible defaults (callee answers, digit '1', answered). */
export interface FakeCallScenario {
  answerLeg?: 'callee' | 'founder' | 'team';
  /** The DTMF gate digit; null models "no press" (whisper timeout → no-answer). */
  digit?: '0' | '1' | null;
  ringMs?: number;
  /** founder-bridge records; masked relay stays do-not-record. */
  record?: boolean;
  transcript?: string;
  outcome?: 'answered' | 'no-answer' | 'busy';
}

/** One party leg of a call (the dialed/dialing side). */
export interface FakeCallLeg {
  phone: string;
  whisperUrl?: string;
  answered: boolean;
}

export type FakeCallStatus = 'ringing' | 'in-progress' | 'completed' | 'no-answer' | 'busy';

/** The fake's CallState as returned by the control API (the fields the specs
 *  read; mirrors fake-twilio/src/engine/voiceTypes.ts CallState). NOTE: this is
 *  the FAKE's view of the call. The PERSISTED app-side proof (recording_s3_key /
 *  transcript / call_status) is read from the app API, NOT from here. */
export interface FakeCall {
  callSid: string;
  from: string;
  to: string;
  kind: 'masked' | 'founder' | 'outbound';
  status: FakeCallStatus;
  digit?: string;
  legs: FakeCallLeg[];
  recordingSid?: string;
  recordingUrl?: string;
  transcript?: string;
  createdAt: string;
  updatedAt: string;
}

/** Place a masked/founder call through the fake. Returns the minted callSid (==
 *  the Twilio CallSid the app persists as the `call` entry's provider_sid). With
 *  a scenario, the fake auto-runs the call on its real clock AFTER responding —
 *  the spec then polls the app surface for the resulting persisted state. */
export async function placeCall(
  request: APIRequestContext,
  input: { from: string; to: string; scenario?: FakeCallScenario },
): Promise<string> {
  const res = await request.post(`${FAKE_BASE}/control/place-call`, { data: input });
  if (!res.ok()) throw new Error(`place-call failed: ${res.status()}`);
  return (await res.json()).callSid as string;
}

/** The full call list the fake currently holds (callSid, status, legs, …). */
export async function getCalls(request: APIRequestContext): Promise<FakeCall[]> {
  const res = await request.get(`${FAKE_BASE}/control/calls`);
  if (!res.ok()) throw new Error(`calls failed: ${res.status()}`);
  return (await res.json()).calls as FakeCall[];
}

/** Find one call the fake holds by its sid (convenience over getCalls()). */
export async function getCall(request: APIRequestContext, callSid: string): Promise<FakeCall | undefined> {
  const calls = await getCalls(request);
  return calls.find((c) => c.callSid === callSid);
}

/** Inject a DTMF gate digit on a paused call, advancing it. Returns the updated
 *  call as the control API reports it. */
export async function pressDigit(
  request: APIRequestContext,
  callSid: string,
  digit: string,
): Promise<FakeCall> {
  const res = await request.post(`${FAKE_BASE}/control/calls/${callSid}/press`, { data: { digit } });
  if (!res.ok()) throw new Error(`press failed: ${res.status()}`);
  return (await res.json()).call as FakeCall;
}
