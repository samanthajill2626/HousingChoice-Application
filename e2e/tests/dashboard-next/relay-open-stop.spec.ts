import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { postInboundSms, twimlMessageBody } from '../../fixtures/fakeTwilio.js';
import { getOutbox } from '../../fixtures/outbox.js';
// Single source of truth for the filed keyword-reply copy (no drift): the spec reads
// the app catalog directly, mirroring the lifecycle spec's cross-package import.
import { MESSAGE_CATALOG } from '../../../app/src/messages/catalog.js';

// Relay OPEN-PATH STOP/START round-trip (design section 3; plan Task 4). Proves the
// A2P keyword parity shipped for the OPEN relay path end-to-end against the hermetic
// stack (:5174 dashboard + app + fake-twilio): a rostered member who texts STOP to
// the group's pool number is opted out, the bare STOP is NEVER relayed to the other
// members, a subsequent group send SKIPS the opted-out member, and a later START
// resumes their delivery.
//
// OBSERVABILITY (worklist adjudication 1 / research-e2e.md):
//   - STOP/START replies ride the webhook's TwiML <Message> HTTP response, NOT the
//     outbox - so they are captured by POSTing the signed inbound OURSELVES
//     (postInboundSms) and reading the reply (twimlMessageBody). After a bare STOP
//     the outbox gains ZERO rows.
//   - Fan-out reach/skip is asserted with outbox `since`-diffs (legs go through the
//     recording send wrapper -> /__dev/outbox). "B/C received nothing new" = an empty
//     since-diff; a delivered member is a positive poll (expectOutboxIncludes).
//   - The create-time intro SMS to every member CONTAINS the substring "STOP"
//     (relay.intro compliance footer), so we NEVER assert on the bare word "STOP" in
//     the outbox: positives match a unique per-send token and the STOP confirmation
//     is matched against the filed catalog copy.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// Filed reply copy, read from the app catalog so a copy edit can never silently drift
// this spec (the same import the lifecycle spec uses for the close copy). keyword.stop
// === STOP_CONFIRMATION; welcome.sms === WELCOME_SMS (settings-resolved on the START
// path, but the hermetic seed sets no welcomeText override so the default copy is
// exactly what the world produces - proven by a2p-compliance.spec.ts).
const STOP_COPY = MESSAGE_CATALOG['keyword.stop'].default;
const WELCOME_COPY = MESSAGE_CATALOG['welcome.sms'].default;
// The relay.intro trailing opt-out footer: the settle barrier for the create-time
// intro fan-out (so the negative baseline excludes it). Substring of relay.intro.
const INTRO_NEEDLE = 'Reply STOP to opt out';

// --- Per-run-unique phones + inbound SIDs ------------------------------------
// +1 555 8XX XXXX: the "8" exchange never collides with the fake's minted pool
// numbers (+1555019xxxx) or the seeded rosters. A shared incrementing counter keeps
// every phone AND every inbound MessageSid unique across the run (unique numbers are
// also what keeps the never-reset fake + the outbox free of cross-test contamination).
let uid = 0;
function uniquePhone(): string {
  uid += 1;
  return `+15558${`${Date.now()}`.slice(-4)}${String(uid).padStart(2, '0')}`;
}
function uniqueSid(tag: string): string {
  uid += 1;
  return `SMe2e${tag}${Date.now()}${uid}`;
}

interface Member {
  phone: string;
  name: string;
  contactId?: string;
}

interface CreatedGroup {
  conversationId: string;
  pool_number: string;
}

/** Reseed the lane with the LEAN profile (a light, clean slate: this spec builds all
 *  its own data via the API). */
async function reseedLean(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Fresh dev-login via the seeded VA (session minted AFTER the reseed so its cookie
 *  epoch matches the freshly re-seeded users table). page.request then shares the
 *  authenticated context for the /api calls below. */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

/** Create a relay group via the standalone API (POST /api/relay-groups). Provisions a
 *  pool number (burn-as-claim ladder) and returns the conversation + its number. */
async function createGroup(page: Page, members: Member[]): Promise<CreatedGroup> {
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
  const { conversation } = (await res.json()) as { conversation: CreatedGroup };
  expect(typeof conversation.pool_number, 'created group carries a pool number').toBe('string');
  expect(conversation.pool_number.length).toBeGreaterThan(0);
  return conversation;
}

/** Poll the dev outbox until a message to `phone` whose body includes `needle`
 *  (optionally FROM `from`) is observed. */
async function expectOutboxIncludes(
  request: APIRequestContext,
  phone: string,
  needle: string,
  from?: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const msgs = await getOutbox(request, { to: phone });
        return msgs.some(
          (m) => (m.body ?? '').includes(needle) && (from === undefined || m.from === from),
        );
      },
      { timeout: 15_000, message: `outbox to ${phone} never carried the expected copy` },
    )
    .toBe(true);
}

test.beforeEach(async ({ request }) => {
  await reseedLean(request);
});

// Restore the lean baseline the rest of the suite expects (this file may not run last).
test.afterAll(async ({ request }) => {
  await reseedLean(request);
});

test('open-path STOP suppresses relay legs; START resumes them (A2P parity)', async ({
  page,
  request,
}) => {
  test.slow(); // four 15s outbox polls + two settles; triple the per-test budget for margin.
  await devLogin(page);

  // --- Arrange: a 3-member OPEN group on ONE pool number. Member A is a REAL contact
  //     (created on its own primary number) so its STOP sets the contact sms_opt_out
  //     flag - the robust, pre-existing fan-out gate - while B and C stay contactless
  //     {phone, name} members. ---
  const aPhone = uniquePhone();
  const madeA = await page.request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName: 'StopA', lastName: `Member${uid}`, phone: aPhone },
  });
  expect(madeA.ok(), `create contact failed: ${madeA.status()} ${await madeA.text()}`).toBeTruthy();
  const aId = ((await madeA.json()) as { contact: { contactId: string } }).contact.contactId;

  const memberA: Member = { phone: aPhone, name: 'Stop MemberA', contactId: aId };
  const memberB: Member = { phone: uniquePhone(), name: 'Stop MemberB' };
  const memberC: Member = { phone: uniquePhone(), name: 'Stop MemberC' };
  const group = await createGroup(page, [memberA, memberB, memberC]);
  const pool = group.pool_number;

  // The create-time intro fan-out is async AND its body CONTAINS "STOP" - wait for it
  // to SETTLE on B and C, THEN baseline, so the "nothing new" diff excludes the intro.
  await expectOutboxIncludes(request, memberB.phone, INTRO_NEEDLE, pool);
  await expectOutboxIncludes(request, memberC.phone, INTRO_NEEDLE, pool);
  const t0 = new Date().toISOString();

  // --- Act 1: A texts STOP to the POOL number. The filed confirmation rides the
  //     webhook TwiML response (postInboundSms); the bare STOP is NOT relayed. ---
  const stop = await postInboundSms(request, {
    from: aPhone,
    to: pool,
    body: 'STOP',
    messageSid: uniqueSid('stop'),
  });
  expect(stop.status).toBe(200);
  expect(twimlMessageBody(stop.body)).toBe(STOP_COPY);

  // B and C received NOTHING new: the webhook returned only AFTER deciding to skip the
  // fan-out for the bare keyword (so no worker job exists to relay it); the settle lets
  // a broken relay betray itself. An empty since-diff to EITHER member is the proof.
  await new Promise((r) => setTimeout(r, 2_000));
  expect(await getOutbox(request, { to: memberB.phone, since: t0 })).toHaveLength(0);
  expect(await getOutbox(request, { to: memberC.phone, since: t0 })).toHaveLength(0);

  // --- Act 2: member B sends group content -> reaches C, SKIPS the opted-out A. B is
  //     the sender, so B is excluded from its own fan-out (reach here is C only). ---
  const t1 = new Date().toISOString();
  const tok1 = `grp1-${Date.now()}`;
  const send1 = await postInboundSms(request, {
    from: memberB.phone,
    to: pool,
    body: tok1,
    messageSid: uniqueSid('grp1'),
  });
  expect(send1.status).toBe(200);
  await expectOutboxIncludes(request, memberC.phone, tok1, pool); // C reached (happens-after barrier)
  await new Promise((r) => setTimeout(r, 2_000)); // let A's (skipped) slot settle in the same pass
  const aGot1 = (await getOutbox(request, { to: aPhone, since: t1 })).filter((m) =>
    (m.body ?? '').includes(tok1),
  );
  expect(aGot1, 'opted-out A must be skipped on the fan-out').toHaveLength(0);

  // --- Act 3: A texts START -> the welcome copy rides the TwiML response and
  //     suppression is cleared. ---
  const start = await postInboundSms(request, {
    from: aPhone,
    to: pool,
    body: 'START',
    messageSid: uniqueSid('start'),
  });
  expect(start.status).toBe(200);
  expect(twimlMessageBody(start.body)).toBe(WELCOME_COPY);

  // --- Act 4: member B sends again -> A now RECEIVES the relayed message (suppression
  //     lifted by START). ---
  const tok2 = `grp2-${Date.now()}`;
  const send2 = await postInboundSms(request, {
    from: memberB.phone,
    to: pool,
    body: tok2,
    messageSid: uniqueSid('grp2'),
  });
  expect(send2.status).toBe(200);
  await expectOutboxIncludes(request, aPhone, tok2, pool);
});
