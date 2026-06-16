import type { APIRequestContext } from '@playwright/test';

export interface OutboxMessage {
  id: string;
  to: string;
  from?: string;
  body?: string;
  providerSid: string;
  status: string;
  createdAt: string;
}

/**
 * @deprecated Outbound-only proof-of-send. Prefer e2e/fixtures/fakeTwilio.ts
 * (`listThreads`), which captures both directions + delivery status via the
 * fake-twilio control API. Kept for the three pre-existing specs only.
 */
// Queries /__dev/outbox (proxied to the app via :5173). request.baseURL is the
// Playwright baseURL (http://localhost:5173).
export async function getOutbox(
  request: APIRequestContext,
  opts: { to?: string; since?: string } = {},
): Promise<OutboxMessage[]> {
  const qs = new URLSearchParams();
  if (opts.to) qs.set('to', opts.to);
  if (opts.since) qs.set('since', opts.since);
  const res = await request.get(`/__dev/outbox${qs.toString() ? `?${qs}` : ''}`);
  if (!res.ok()) throw new Error(`/__dev/outbox failed: ${res.status()}`);
  return (await res.json()).messages as OutboxMessage[];
}
