import { hkdfSync } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { reseed } from '../../fixtures/reseed.js';
import { planTranscribedCall } from '../../fixtures/extraction.js';

// Cross-process event bridge, end-to-end against the hermetic stack (spec
// docs/superpowers/specs/2026-07-20-event-bridge-design.md). The worker process
// forwards every bus emit to the app via authenticated POST /internal/events
// (lib/eventBridge.ts -> routes/internal.ts), which re-emits to its SSE clients -
// same event names/payloads, zero frontend change. Two proofs:
//   1. WIRE (fast): a direct authenticated POST /internal/events is delivered to
//      a BROWSER EventSource on /api/events - route auth + re-emit + SSE wire, in
//      milliseconds. The POST hits the APP origin directly (the Vite dev server
//      does NOT proxy /internal); the EventSource is same-origin via the proxy.
//   2. CROSS-PROCESS (slow, ~<=90s): a planted immediately-due extraction row is
//      claimed by the REAL worker process's next poll (60s cadence - deliberately
//      NOT lowered; see the plan's race rationale), whose suggestion.updated
//      crosses the bridge and updates an OPEN contact page with NO reload, NO tick.
//
// Accessible-name contract (shared with the extraction specs): the review chip is
// role group, name `AI suggestion for <label>`.

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const APP = process.env['E2E_APP_URL'] ?? 'http://127.0.0.1:8080';

// The hermetic stack runs the config.ts dev placeholder secrets (e2e-session.mjs
// sets neither SESSION_SECRET nor CF_ORIGIN_SECRET). The test-runner shell sees
// the same env the harness children inherit, so honor a real value if one is
// exported; otherwise fall back to the config.ts defaults. Recompute the bridge
// token EXACTLY as lib/eventBridge.ts derives it (HKDF-SHA256, empty salt, info
// label 'hc-event-bridge', 32 bytes, hex).
const ORIGIN_SECRET = process.env['CF_ORIGIN_SECRET'] ?? 'dev-placeholder-not-a-secret';
const SESSION_SECRET = process.env['SESSION_SECRET'] ?? 'dev-placeholder-session-secret';
const BRIDGE_TOKEN = Buffer.from(
  hkdfSync('sha256', SESSION_SECRET, '', 'hc-event-bridge', 32),
).toString('hex');

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

let seq = 0;
/** Per-run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  seq += 1;
  const stamp = `${Date.now()}`.slice(-5);
  return `+1555${stamp}${String(seq).padStart(2, '0')}`;
}

/** Create a fresh TENANT via the authenticated API (never touches seeded rows).
 *  `pets` pre-seeds the intake field so a nested pets suggestion chip renders -
 *  the Eligibility-intake pets row shows only when pets is set (see
 *  voice-extraction.spec.ts). Returns the new contactId + its phone. */
async function createTenant(
  request: APIRequestContext,
  firstName: string,
  opts: { pets?: string } = {},
): Promise<{ contactId: string; phone: string }> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName,
      lastName: 'Bridge',
      phone,
      ...(opts.pets !== undefined && { pets: opts.pets }),
    },
  });
  expect(res.ok(), `create tenant ${firstName}`).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  return { contactId, phone };
}

/** Resolve (create-or-get) the contact's 1:1 conversationId - the SAME phone-keyed
 *  thread an inbound from that contact lands in (voice-extraction.spec.ts). */
async function ensureConversation(request: APIRequestContext, contactId: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/contacts/${contactId}/conversation`);
  expect(res.ok(), 'ensure conversation').toBeTruthy();
  return (await res.json()).conversation.conversationId as string;
}

// A clean slate once for the file; each test still uses a fresh per-run contact.
test.beforeAll(async ({ request }) => {
  await reseed(request);
});

test('wire: an authenticated /internal/events post reaches the browser SSE stream', async ({
  page,
  request,
}) => {
  await devLogin(page);

  // Open the browser EventSource on the dashboard-proxied /api/events and PARK a
  // promise that resolves on the first suggestion.updated. This evaluate returns
  // only after onopen fires - and the SSE route registers its bus listeners
  // synchronously BEFORE the response headers reach the client (api.ts), so
  // onopen proves the server-side subscriber is live. That removes the
  // subscribe-vs-emit race: the POST below cannot re-emit before this listener
  // exists.
  await page.evaluate(
    () =>
      new Promise<void>((resolveOpen, rejectOpen) => {
        const es = new EventSource('/api/events');
        const openTimer = setTimeout(
          () => rejectOpen(new Error('EventSource did not open within 10s')),
          10000,
        );
        const w = window as unknown as { __bridgeWire?: Promise<string> };
        w.__bridgeWire = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            es.close();
            reject(new Error('no suggestion.updated within 15s'));
          }, 15000);
          es.addEventListener('suggestion.updated', (e) => {
            clearTimeout(timer);
            es.close();
            resolve((e as MessageEvent).data as string);
          });
        });
        es.onopen = () => {
          clearTimeout(openTimer);
          resolveOpen();
        };
      }),
  );

  // Direct authenticated POST to the APP origin (/internal is NOT Vite-proxied):
  // both fences must pass - the CloudFront origin secret AND the HKDF bridge token.
  const post = await request.post(`${APP}/internal/events`, {
    headers: { 'x-origin-verify': ORIGIN_SECRET, 'x-bridge-token': BRIDGE_TOKEN },
    data: { name: 'suggestion.updated', payload: { contactId: 'bridge-wire-proof' } },
  });
  expect(post.status()).toBe(204);

  const raw = await page.evaluate(async () => {
    const w = window as unknown as { __bridgeWire: Promise<string> };
    return await w.__bridgeWire;
  });
  const data = JSON.parse(raw) as { contactId: string };
  expect(data.contactId).toBe('bridge-wire-proof');
});

test('wire: missing token 403s; unknown name 400s', async ({ request }) => {
  // Origin secret present, bridge token ABSENT -> dies at the token fence.
  const noToken = await request.post(`${APP}/internal/events`, {
    headers: { 'x-origin-verify': ORIGIN_SECRET },
    data: { name: 'suggestion.updated', payload: {} },
  });
  expect(noToken.status()).toBe(403);
  // Both fences pass, but the event name is not in APP_EVENT_NAMES -> 400.
  const badName = await request.post(`${APP}/internal/events`, {
    headers: { 'x-origin-verify': ORIGIN_SECRET, 'x-bridge-token': BRIDGE_TOKEN },
    data: { name: 'not.an.event', payload: {} },
  });
  expect(badName.status()).toBe(400);
});

test('cross-process: a worker-poll extraction updates an open contact page live', async ({
  page,
  request,
}) => {
  // One real 60s worker poll cycle + pipeline margin. Deliberate - see header.
  test.setTimeout(150_000);
  await devLogin(page);
  // Pre-seed pets so the Eligibility-intake pets row (and its nested review chip)
  // renders once the extraction lands.
  const { contactId } = await createTenant(page.request, 'BridgeLive', { pets: 'none' });
  const conversationId = await ensureConversation(page.request, contactId);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  await expect(
    page.locator('section').filter({ has: page.getByRole('heading', { name: 'Eligibility intake' }) }),
  ).toBeVisible();

  // Immediately-due voice extraction row: the transcript-fixture seam schedules
  // dueAt=now, so the REAL worker process claims it on its next poll. We NEVER
  // tick - the only path that can surface the chip is the worker's
  // suggestion.updated crossing the bridge to this open page's SSE stream.
  await planTranscribedCall(request, {
    conversationId,
    callSid: `CAbridge${Date.now()}`,
    sentences: [
      {
        text: 'EXTRACT:{"fields":{"pets":{"op":"suggest","value":"cat","reason":"mentioned a cat"}}}',
        mediaChannel: 1,
      },
    ],
  });

  // NO reload, NO tick: the chip appears only if the worker-side suggestion.updated
  // crossed the bridge and this open page refetched on the SSE hint.
  await expect(page.getByRole('group', { name: /AI suggestion for/i })).toBeVisible({
    timeout: 90_000,
  });
});
