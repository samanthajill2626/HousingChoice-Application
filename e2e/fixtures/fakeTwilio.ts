import type { APIRequestContext } from '@playwright/test';

// Control-plane helpers for the fake-twilio host (:8889). `send-as-party` makes the
// fake emit a REAL-signed inbound webhook to the app (exercising the signature
// middleware + inbound pipeline); `threads` is the proof-of-send surface for
// outbound replies + their delivery state. (Restored for the new-dashboard comms
// e2e after the legacy-only specs were removed in 40bd4f0; the control API is
// unchanged.)
const FAKE_BASE = process.env.FAKE_TWILIO_URL ?? 'http://localhost:8889';

export interface FakeThread {
  partyNumber: string;
  messages: Array<{
    sid: string;
    direction: 'inbound' | 'outbound';
    body?: string;
    state: string;
    mediaUrls?: string[];
  }>;
}

/**
 * Register an ad-hoc party persona on the fake. `send-as-party` REJECTS an
 * unregistered `from` number (`{"error":"unknown party number"}`), so a scenario
 * using a fresh, per-run-unique tenant number must register it first. Idempotent
 * from the caller's view: a duplicate registration (the fake 409s "already exists")
 * is swallowed so a tenant who calls-then-texts registers exactly once safely.
 */
export async function registerParty(
  request: APIRequestContext,
  input: { label: string; role: 'tenant' | 'landlord' | 'pm' | 'staff'; number: string },
): Promise<void> {
  const res = await request.post(`${FAKE_BASE}/control/personas/ad-hoc`, { data: input });
  if (!res.ok() && res.status() !== 409) {
    const body = await res.text();
    if (!/already exists/i.test(body)) {
      throw new Error(`register-party failed: ${res.status()} ${body}`);
    }
  }
}

export async function sendAsParty(
  request: APIRequestContext,
  input: { from: string; body?: string; to?: string },
): Promise<string> {
  const res = await request.post(`${FAKE_BASE}/control/send-as-party`, { data: input });
  if (!res.ok()) throw new Error(`send-as-party failed: ${res.status()}`);
  return (await res.json()).sid as string;
}

export async function listThreads(request: APIRequestContext): Promise<FakeThread[]> {
  const res = await request.get(`${FAKE_BASE}/control/threads`);
  if (!res.ok()) throw new Error(`threads failed: ${res.status()}`);
  return (await res.json()).threads as FakeThread[];
}

export async function resetFake(request: APIRequestContext): Promise<void> {
  await request.post(`${FAKE_BASE}/control/reset`, { data: {} });
}
