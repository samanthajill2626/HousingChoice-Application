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
 * NOTE: whether `scenario: { outcome: 'no-answer' }` alone drives the bridge to a
 * terminal missed state on the LIVE (real-clock) e2e stack, or whether an explicit
 * `hangup(sid)` is also needed, is resolved by the Task 4 conformance audit; adjust
 * this helper to whichever the audit proves correct.
 */
export async function tenantCallNoAnswer(
  request: APIRequestContext,
  input: { from: string; to: string },
): Promise<string> {
  return placeCall(request, {
    from: input.from,
    to: input.to,
    scenario: { outcome: 'no-answer', ringMs: 1000 },
  });
}
