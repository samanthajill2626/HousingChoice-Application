import type { APIRequestContext } from '@playwright/test';

const FAKE_BASE = process.env.FAKE_TWILIO_URL ?? 'http://localhost:8889';

export interface FakeThread {
  partyNumber: string;
  messages: Array<{ sid: string; direction: 'inbound' | 'outbound'; body?: string; state: string }>;
}

export async function sendAsParty(request: APIRequestContext, input: { from: string; body?: string; to?: string }): Promise<string> {
  const res = await request.post(`${FAKE_BASE}/control/send-as-party`, { data: input });
  if (!res.ok()) throw new Error(`send-as-party failed: ${res.status()}`);
  return (await res.json()).sid as string;
}

export async function listThreads(request: APIRequestContext): Promise<FakeThread[]> {
  const res = await request.get(`${FAKE_BASE}/control/threads`);
  if (!res.ok()) throw new Error(`threads failed: ${res.status()}`);
  return (await res.json()).threads as FakeThread[];
}

export async function setDeliveryOutcome(
  request: APIRequestContext,
  input: { partyNumber: string; profile: { kind: 'normal' | 'stall' | 'fail'; failState?: string; errorCode?: string; stallAt?: string } },
): Promise<void> {
  const res = await request.post(`${FAKE_BASE}/control/delivery-outcome`, { data: input });
  if (!res.ok()) throw new Error(`delivery-outcome failed: ${res.status()}`);
}

export async function resetFake(request: APIRequestContext): Promise<void> {
  await request.post(`${FAKE_BASE}/control/reset`, { data: {} });
}
