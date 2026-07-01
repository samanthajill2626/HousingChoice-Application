// Voice seam for scenario tests: wraps fake-twilio's voice CONTROL API
// (fake-twilio/src/routes/voiceControl.ts) the way fakeTwilio.ts wraps the SMS
// control API. Used by the by-phone tenant-onboarding path: the tenant places a
// call to the app's number; the app bridges to the founder; the founder does not
// answer; the app's missed-call auto-text fires.
import type { APIRequestContext } from '@playwright/test';

const FAKE_BASE = process.env.FAKE_TWILIO_URL ?? 'http://localhost:8889';

export type CallScenario = {
  answerLeg?: 'callee' | 'founder' | 'team';
  digit?: '0' | '1' | null;
  outcome?: 'answered' | 'no-answer' | 'busy';
  ringMs?: number;
  record?: boolean;
  transcript?: string;
};

export interface FakeCall {
  callSid: string;
  status: string;
  [key: string]: unknown;
}

/** Place an inbound call from `from` to the app number `to`. Returns the callSid. */
export async function placeCall(
  request: APIRequestContext,
  input: { from: string; to: string; scenario?: CallScenario },
): Promise<string> {
  const res = await request.post(`${FAKE_BASE}/control/place-call`, { data: input });
  if (!res.ok()) throw new Error(`place-call failed: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { callSid: string };
  return body.callSid;
}

export async function listCalls(request: APIRequestContext): Promise<FakeCall[]> {
  const res = await request.get(`${FAKE_BASE}/control/calls`);
  if (!res.ok()) throw new Error(`list calls failed: ${res.status()}`);
  return ((await res.json()) as { calls: FakeCall[] }).calls;
}

export async function answerLeg(
  request: APIRequestContext,
  sid: string,
  leg?: 'callee' | 'founder' | 'team',
): Promise<FakeCall> {
  const res = await request.post(`${FAKE_BASE}/control/calls/${sid}/answer`, {
    data: leg !== undefined ? { leg } : {},
  });
  if (!res.ok()) throw new Error(`answer failed: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { call: FakeCall }).call;
}

/**
 * Inject a DTMF gate digit on a paused call (POST /control/calls/:sid/press).
 * This is the step-API driver the OUTBOUND masked-call e2e uses: the app's
 * originate route places the navigator-leg call WITHOUT a scenario, so the
 * CallEngine pauses at the whisper Gather; pressing '1' here runs the whole
 * dial chain (whisper → gate accept → <Dial> the target from the business
 * number → the <Dial action> status summary → recording), exactly as a
 * navigator pressing 1 on their ringing cell would. The endpoint awaits the
 * engine's step before responding, so the returned call reflects the terminal
 * state. Returns the resulting FakeCall.
 */
export async function pressCall(
  request: APIRequestContext,
  sid: string,
  digit: '0' | '1',
): Promise<FakeCall> {
  const res = await request.post(`${FAKE_BASE}/control/calls/${sid}/press`, { data: { digit } });
  if (!res.ok()) throw new Error(`press failed: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { call: FakeCall }).call;
}

/** The single fake outbound (`kind:'outbound'`) call with the given callSid, or
 *  undefined. The app's originate route returns this exact sid (the fake mints it
 *  in Calls.json and echoes it back), so the e2e resolves the paused navigator-leg
 *  call by the callSid it got from the originate response. */
export async function findOutboundCall(
  request: APIRequestContext,
  callSid: string,
): Promise<FakeCall | undefined> {
  const calls = await listCalls(request);
  return calls.find((c) => c.callSid === callSid && c.kind === 'outbound');
}

export async function hangup(request: APIRequestContext, sid: string): Promise<FakeCall> {
  const res = await request.post(`${FAKE_BASE}/control/calls/${sid}/hangup`, { data: {} });
  if (!res.ok()) throw new Error(`hangup failed: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { call: FakeCall }).call;
}

/**
 * The diagram's "Tenant phones in → Sam ignores → [AUTO] auto-reply text" move.
 * Places the inbound call with a no-answer scenario so the founder-bridge <Dial>
 * resolves missed, which is what triggers the app's missed-call auto-text job.
 * Returns the callSid.
 *
 * `scenario: { digit: null }` models "the founder never presses the whisper gate":
 * the gate times out, the founder leg stays UNANSWERED, the <Dial action> summary
 * posts DialCallStatus=no-answer, and the app fires its missed-call auto-text. This
 * is the verified-correct shape (Task 4 conformance audit): `{ outcome: 'no-answer' }`
 * does NOT work — the scenario runner still presses '1', the app records answered_at,
 * treats the bridge as answered, and no auto-text fires.
 */
export async function tenantCallNoAnswer(
  request: APIRequestContext,
  input: { from: string; to: string },
): Promise<string> {
  return placeCall(request, {
    from: input.from,
    to: input.to,
    scenario: { digit: null },
  });
}
