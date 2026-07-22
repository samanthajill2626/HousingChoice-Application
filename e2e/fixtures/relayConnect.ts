import {
  expect,
  request as apiRequest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { dashboardUrl, fakeUrl } from '../support/urls.js';

// Shared connect-when-ready helpers (relay number buying strategy, plan Task 12).
//
// The hermetic stack runs MESSAGING_DRIVER=twilio with the spare-buffer target
// K=0, and the seeded pool numbers are all provisioned_via 'console' (which the
// twilio-mode reuse ladder skips). So a FRESH pair with no reusable active twilio
// number lands in tier 3: the group is created CONNECTING (no pool number) and
// stays connecting until the warmed number registers. These helpers complete that
// sequence for the pre-existing relay specs, so a caller transparently ends up with
// an OPEN group carrying a pool number - exactly what those specs assumed back when
// a fresh pair provisioned immediately.
//
// The DUAL path in createGroupOpen is load-bearing: once the FIRST connecting
// group's number registers it becomes an active twilio-provisioned number, so a
// later DISJOINT group REUSES it immediately (tier 1 -> created OPEN, no warming).
// A roster that OVERLAPS an existing group's burn cannot reuse that number, so it
// lands connecting and is driven onto a SECOND number. That is precisely what keeps
// the multiplex (same number) and overlap (different number) proofs valid.

const NEXT = dashboardUrl;

/** A relay group member as POST /api/relay-groups accepts it. */
export interface RelayMember {
  phone: string;
  name: string;
  contactId?: string;
}

/** The opened-conversation subset these helpers return (always open + numbered). */
export interface RelayConversation {
  conversationId: string;
  status: string;
  pool_number: string;
}

interface RawConversation {
  conversationId: string;
  status?: string;
  pool_number?: string;
}

interface PoolNumberRow {
  number: string;
  state: string;
}

/** Fire the fake's A2P registration signal for a warming number (the Task 9 seam):
 *  the fake POSTs the Event Streams number-registration.successful batch to the
 *  app's /webhooks/twilio/events sink, which promotes warming -> active and opens
 *  the earmarked connecting group. Mirrors relay-connect-when-ready.spec.ts. */
export async function registerNumber(
  request: APIRequestContext,
  phoneNumber: string,
): Promise<void> {
  const res = await request.post(`${fakeUrl}/control/register-number`, { data: { phoneNumber } });
  expect(res.ok(), `register-number failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Run `fn` with a throwaway FOUNDER (admin) request context. The admin inventory
 *  (GET /api/pool-numbers) 403s for the VA session, and logging the caller's own
 *  `page` context in as founder would clobber its VA session, so the founder login
 *  rides its own isolated context that is disposed afterwards. Mirrors adminLogin. */
async function withFounderAdmin<T>(fn: (admin: APIRequestContext) => Promise<T>): Promise<T> {
  const admin = await apiRequest.newContext();
  try {
    const res = await admin.post(`${NEXT}/auth/dev-login`, {
      data: { email: 'founder@example.com' },
    });
    expect(res.ok(), `admin dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    const who = (await res.json()) as { role?: string };
    expect(who.role, 'founder dev-login must yield an admin session').toBe('admin');
    return await fn(admin);
  } finally {
    await admin.dispose();
  }
}

/** Poll the admin inventory until a warming number appears (the warm job buys +
 *  records it async in the worker). With K=0 and the connecting groups driven to
 *  open SEQUENTIALLY, exactly one number is warming at a time, so we take the first
 *  warming number. Mirrors pollWarmingNumber in the connect spec. */
async function pollWarmingNumber(admin: APIRequestContext): Promise<string> {
  let warming: string[] = [];
  await expect
    .poll(
      async () => {
        const res = await admin.get(`${NEXT}/api/pool-numbers`);
        expect(
          res.ok(),
          `pool-numbers admin read failed: ${res.status()} ${await res.text()}`,
        ).toBeTruthy();
        warming = ((await res.json()) as { numbers: PoolNumberRow[] }).numbers
          .filter((n) => n.state === 'warming')
          .map((n) => n.number);
        return warming.length;
      },
      { timeout: 30_000, message: 'no warming pool number ever appeared for the connecting group' },
    )
    .toBeGreaterThanOrEqual(1);
  return warming[0]!;
}

async function getConversation(
  request: APIRequestContext,
  conversationId: string,
): Promise<RawConversation> {
  const res = await request.get(`${NEXT}/api/conversations/${conversationId}`);
  expect(res.ok(), `get conversation failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { conversation: RawConversation }).conversation;
}

/** Complete the connect-when-ready sequence for a CONNECTING group: discover its
 *  warming number (founder admin context), fire the fake registration, then poll
 *  the conversation until it OPENS on that number. Returns the opened conversation.
 *  `request` is any session that can read GET /api/conversations/:id (the caller's
 *  VA context is fine). */
export async function driveConnectingGroupToOpen(
  request: APIRequestContext,
  conversationId: string,
): Promise<RelayConversation> {
  const warmed = await withFounderAdmin(async (admin) => {
    const number = await pollWarmingNumber(admin);
    await registerNumber(admin, number);
    return number;
  });
  await expect
    // 60s (not 30s): the connect-when-ready chain is multi-hop async - register ->
    // Event Streams webhook -> promote -> relay.numberReady job -> assign+open ->
    // SSE. Solo it opens in seconds, but under FULL-SUITE parallel load the shared
    // worker/queue can push it past a 30s wait (a real flake seen at 187-spec load).
    .poll(async () => (await getConversation(request, conversationId)).status, {
      timeout: 60_000,
      message: 'connecting group never opened after register-number',
    })
    .toBe('open');
  const opened = await getConversation(request, conversationId);
  expect(opened.pool_number, 'the opened group is assigned the warmed number').toBe(warmed);
  return { conversationId, status: 'open', pool_number: warmed };
}

/** Create a relay group via POST /api/relay-groups and return it OPEN with a pool
 *  number. Dual path: a tier-1 REUSE opens immediately (returned as-is); a fresh
 *  pair lands CONNECTING and is driven to open (backend register). Callers that
 *  previously relied on immediate provisioning get the same OPEN group + number. */
export async function createGroupOpen(
  page: Page,
  members: RelayMember[],
): Promise<RelayConversation> {
  const res = await page.request.post(`${NEXT}/api/relay-groups`, {
    data: {
      members: members.map((m) => ({
        phone: m.phone,
        name: m.name,
        ...(m.contactId !== undefined && { contactId: m.contactId }),
      })),
    },
  });
  expect(res.ok(), `create group failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const { conversation } = (await res.json()) as { conversation: RawConversation };
  if (conversation.status === 'open') {
    const poolNumber = conversation.pool_number ?? '';
    expect(poolNumber, 'an open (reuse) group carries a pool number').not.toBe('');
    return { conversationId: conversation.conversationId, status: 'open', pool_number: poolNumber };
  }
  expect(conversation.status, 'a fresh group is either open (reuse) or connecting').toBe(
    'connecting',
  );
  return driveConnectingGroupToOpen(page.request, conversation.conversationId);
}
