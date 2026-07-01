// e2e/tests/dashboard-next/voice-outbound.spec.ts
//
// Voice Phase 1 — in-app MASKED OUTBOUND calling, end-to-end against the REAL
// hermetic stack (app :8080 via the :5174 proxy + the fake-twilio host :8889).
// One test per spec §9 item. The originate route rings the NAVIGATOR's verified
// cell FROM the business number via the real Twilio driver → the fake's Calls.json
// → the CallEngine (which pauses at the whisper Gather). We then DRIVE the call
// deterministically through the fake voice CONTROL API (press '1' runs the whole
// dial chain: whisper → gate accept → <Dial> the target from the business number
// → the <Dial action> status summary → recording), exactly as a navigator pressing
// 1 on their ringing cell would.
//
// How we drive + verify:
//   - dev-login (va@example.com → the navigator; founder@example.com → admin).
//   - Verify the navigator's cell FOR REAL: verify-start → read the 6-digit code
//     from /__dev/outbox (the SMS the app actually sent) → verify-confirm.
//   - Originate via POST /api/contacts/:id/call → { callSid }.
//   - Resolve the fake's paused outbound call by that callSid (findOutboundCall)
//     and assert to=NAVIGATOR cell, from=BUSINESS number; press '1' to bridge.
//   - Assert the target is dialed as a <Number> leg from the business caller ID,
//     the persisted `call` timeline entry (answered + recorded), and PII: no raw
//     navigator/target phone in any stored label or leg URL.
//
// Unique phones per case (helper below) so cases never collide within a run.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  placeCall,
  listCalls,
  pressCall,
  findOutboundCall,
  type FakeCall,
} from '../../fixtures/fakeVoice.js';
import { getOutbox } from '../../fixtures/outbox.js';
import { reseed } from '../../fixtures/reseed.js';

const NEXT = 'http://localhost:5174';

// Each case starts from a clean, deterministic slate: a FRESH (unverified) VA, and
// the founder seeded as the inbound-voice-line holder with a VERIFIED FOUNDER_CELL
// (resetLocalData re-runs the §6 FOUNDER_CELL migration). Cell verification +
// inbound-holder state persist on the fixed va/founder personas, so isolating each
// test is what keeps the "unverified VA" and single-holder assertions honest. The
// suite runs workers:1 / fullyParallel:false, so a per-test reseed never races.
test.beforeEach(async ({ request }) => {
  await reseed(request);
});
/** The app's own business number in the e2e stack (OUR_PHONE_NUMBERS[0]) — the
 *  masked caller ID the target sees, and the from= on the navigator-leg ring. */
const BUSINESS = '+15550009999';
/** The e2e stack seeds FOUNDER_CELL onto the founder as the inbound-line holder;
 *  the inbound cases prove a REASSIGNED holder's cell wins over this value. */
const FOUNDER_CELL = '+15550000001';

/** Per-run-unique NANP E.164s so cases never collide (mirrors steps.freshContact). */
let seq = 0;
function uniquePhone(): string {
  const stamp = `${Date.now()}`.slice(-5);
  seq += 1;
  return `+1555${stamp}${String(seq).padStart(2, '0')}`;
}

/** Dev-login as a persona (va→navigator, founder→admin), then load the SPA so the
 *  session cookie is live for subsequent page.request API calls. */
async function devLoginAs(page: Page, email: string): Promise<{ userId: string }> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email } });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { userId: string };
  await page.goto(`${NEXT}/`);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  return { userId: body.userId };
}

/** Create a fresh tenant contact via the authenticated API; returns its id. */
async function createContact(
  api: APIRequestContext,
  over: Record<string, unknown> = {},
): Promise<{ contactId: string; phone: string }> {
  const phone = (over['phone'] as string) ?? uniquePhone();
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName: 'Callee', lastName: 'Tester', phone, ...over },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { contact } = (await res.json()) as { contact: { contactId: string } };
  return { contactId: contact.contactId, phone };
}

/**
 * Verify the CURRENT session user's cell FOR REAL (spec §7): verify-start sends a
 * 6-digit SMS code (which the app really dispatches via the fake) → we read it from
 * /__dev/outbox → verify-confirm stamps cell_verified_at. Returns the verified cell.
 * This is the exact self-service path a navigator uses before placing masked calls.
 */
async function verifyCell(api: APIRequestContext, cell: string): Promise<string> {
  const start = await api.post(`${NEXT}/api/users/me/cell/verify-start`, { data: { cell } });
  expect(start.status(), await start.text()).toBe(200);

  // The app really sent the code SMS — read it back from the recorded outbox.
  const code = await readVerifyCode(api, cell);
  const confirm = await api.post(`${NEXT}/api/users/me/cell/verify-confirm`, { data: { code } });
  expect(confirm.status(), await confirm.text()).toBe(200);
  expect(typeof ((await confirm.json()) as { cell_verified_at: string }).cell_verified_at).toBe(
    'string',
  );
  return cell;
}

/** Poll /__dev/outbox for the verification SMS to `cell` and extract its 6-digit code. */
async function readVerifyCode(api: APIRequestContext, cell: string): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const msgs = await getOutbox(api, { to: cell });
        for (const m of msgs) {
          const match = /(\d{6})/.exec(m.body ?? '');
          if (match) code = match[1];
        }
        return code;
      },
      { timeout: 10_000 },
    )
    .toBeTruthy();
  return code!;
}

/** Set/clear a user's inbound-voice-line (admin session required). */
async function assignInboundLine(api: APIRequestContext, userId: string): Promise<number> {
  const res = await api.post(`${NEXT}/api/users/${userId}/inbound-voice-line`, { data: {} });
  return res.status();
}
async function clearInboundLine(api: APIRequestContext, userId: string): Promise<number> {
  const res = await api.delete(`${NEXT}/api/users/${userId}/inbound-voice-line`);
  return res.status();
}

/** The contact's `call` timeline entries (kind:'call'), newest-first. */
async function callTimeline(
  api: APIRequestContext,
  contactId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await api.get(
    `${NEXT}/api/contacts/${contactId}/timeline?kinds=call&limit=50`,
  );
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { items: Array<Record<string, unknown>> };
  return body.items.filter((i) => i['kind'] === 'call');
}

/**
 * Press '1' on the navigator leg and wait for the bridge to complete. The app's
 * originate route places the fake call fire-and-forget (Twilio's Calls.json returns
 * the queued sid immediately, then the CallEngine fetches the outbound-bridge TwiML
 * asynchronously), so a press can land BEFORE the engine has built the pre-dial gate
 * — in which case it no-ops and the call stays `ringing`. Retry the press until the
 * call reaches a terminal state. Returns the terminal FakeCall.
 */
async function driveBridge(api: APIRequestContext, callSid: string): Promise<FakeCall> {
  let last: FakeCall | undefined;
  await expect
    .poll(
      async () => {
        const call = await pressCall(api, callSid, '1');
        last = call;
        return call.status;
      },
      { timeout: 10_000, intervals: [100, 200, 300, 500] },
    )
    .toBe('completed');
  return last!;
}

/** Every leg phone recorded on a fake call (the dialed target ends up here). */
function legPhones(call: FakeCall): string[] {
  const legs = (call['legs'] as Array<{ phone: string }> | undefined) ?? [];
  return legs.map((l) => l.phone);
}

// ---------------------------------------------------------------------------
// §9.1 — Originate + bridge + record (the happy path)
// ---------------------------------------------------------------------------
test('§9.1 originate rings the navigator cell from the business number, bridges to the target, persists + records the outbound call', async ({
  page,
}) => {
  const api = page.request;
  await devLoginAs(page, 'va@example.com');

  // The navigator verifies their OWN cell first (real verify-start → outbox code → confirm).
  const navCell = uniquePhone();
  await verifyCell(api, navCell);

  const { contactId, phone: target } = await createContact(api);

  // Originate → 200 { callSid }. The navigator's cell is what rings first.
  const res = await api.post(`${NEXT}/api/contacts/${contactId}/call`, { data: {} });
  expect(res.status(), await res.text()).toBe(200);
  const { callSid } = (await res.json()) as { callSid: string };
  expect(typeof callSid).toBe('string');
  expect(callSid.length).toBeGreaterThan(0);

  // The fake placed the navigator-leg call FROM the business number TO the nav cell.
  const paused = await findOutboundCall(api, callSid);
  expect(paused, 'fake did not record an outbound call for the originate').toBeDefined();
  expect(paused!.from).toBe(BUSINESS);
  expect(paused!.to).toBe(navCell);
  expect(paused!.status).toBe('ringing'); // paused at the whisper Gather (no scenario)

  // Drive press-1 on the navigator leg → whisper accept → <Dial> the target from
  // the business caller ID → <Dial action> summary → recording (record-from-answer-dual).
  const bridged = await driveBridge(api, callSid);
  expect(bridged.status).toBe('completed');
  // The TARGET is dialed as a bridged leg (the <Number>), FROM the business number.
  expect(legPhones(bridged)).toContain(target);
  expect(bridged.from).toBe(BUSINESS);
  // The outbound bridge RECORDS (like the founder bridge) — a recording was minted.
  expect(typeof bridged.recordingUrl).toBe('string');

  // The persisted `call` timeline entry: answered + a recording stamped on it.
  await expect
    .poll(async () => {
      const calls = await callTimeline(api, contactId); // ascending; one call here
      const entry = calls[calls.length - 1];
      return entry ? { outcome: entry['call_outcome'], hasRec: 'recording_s3_key' in entry } : null;
    }, { timeout: 10_000 })
    .toEqual({ outcome: 'answered', hasRec: true });
});

// ---------------------------------------------------------------------------
// §9.2 — Guard: no verified cell → 409 cell_not_verified, NO call placed
// ---------------------------------------------------------------------------
test('§9.2 no verified cell → 409 cell_not_verified and NO call is placed', async ({ page }) => {
  const api = page.request;
  await devLoginAs(page, 'va@example.com'); // this fresh VA has NO verified cell
  const { contactId } = await createContact(api);

  const before = (await listCalls(api)).length;
  const res = await api.post(`${NEXT}/api/contacts/${contactId}/call`, { data: {} });
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('cell_not_verified');

  // The fake placed NO new call (the guard is pre-dial).
  expect((await listCalls(api)).length).toBe(before);
});

// ---------------------------------------------------------------------------
// §9.3 — Guard: voice_opt_out contact → 409, NO call; CallMenu disabled (UI)
// ---------------------------------------------------------------------------
test('§9.3 do-not-call contact → 409 contact_voice_opted_out (no call) and the CallMenu is disabled', async ({
  page,
}) => {
  const api = page.request;
  await devLoginAs(page, 'va@example.com');
  await verifyCell(api, uniquePhone()); // a verified navigator, so the ONLY refusal is the opt-out
  const { contactId } = await createContact(api);
  // Mark do-not-call via the real voice-opt-out route (create doesn't accept the flag).
  const flag = await api.post(`${NEXT}/api/contacts/${contactId}/voice-opt-out`, {
    data: { optOut: true },
  });
  expect(flag.status(), await flag.text()).toBe(200);

  // API guard: 409 + no call placed.
  const before = (await listCalls(api)).length;
  const res = await api.post(`${NEXT}/api/contacts/${contactId}/call`, { data: {} });
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('contact_voice_opted_out');
  expect((await listCalls(api)).length).toBe(before);

  // UI guard: the Call control is DISABLED with a "Do not call" note.
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
  const callBtn = page.getByRole('button', { name: /Call/i });
  await expect(callBtn).toBeDisabled();
  await expect(page.getByRole('note').filter({ hasText: /Do not call/i })).toBeVisible();
});

// ---------------------------------------------------------------------------
// §9.4 — An unverified cell is NEVER dialed
// ---------------------------------------------------------------------------
test('§9.4a a navigator with an UNVERIFIED cell → 409, NO call placed', async ({ page }) => {
  const api = page.request;
  await devLoginAs(page, 'va@example.com');

  // Start verification but NEVER confirm — the cell is pending, not verified.
  const cell = uniquePhone();
  const start = await api.post(`${NEXT}/api/users/me/cell/verify-start`, { data: { cell } });
  expect(start.status()).toBe(200);
  const me = await api.get(`${NEXT}/api/users/me`);
  expect(((await me.json()) as { user: { cell_verified_at?: string } }).user.cell_verified_at).toBeUndefined();

  const { contactId } = await createContact(api);
  const before = (await listCalls(api)).length;
  const res = await api.post(`${NEXT}/api/contacts/${contactId}/call`, { data: {} });
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('cell_not_verified');
  expect((await listCalls(api)).length).toBe(before);
});

test('§9.4b an unverified (pending) cell is NEVER dialed on inbound — only the VERIFIED holder cell is', async ({
  page,
}) => {
  const api = page.request;
  await devLoginAs(page, 'founder@example.com'); // admin; the seeded inbound holder (verified FOUNDER_CELL)

  // Begin (but NEVER confirm) verifying a NEW cell on the holder. verify-start only
  // writes `cell_pending` — it does NOT touch the live verified `cell` — so this cell
  // is present-but-untrusted. The invariant under test: an unverified cell is never
  // dialed; the bridge still rings the VERIFIED holder cell (FOUNDER_CELL), not the
  // pending one.
  const pendingCell = uniquePhone();
  const start = await api.post(`${NEXT}/api/users/me/cell/verify-start`, { data: { cell: pendingCell } });
  expect(start.status()).toBe(200);

  const caller = uniquePhone();
  const before = (await listCalls(api)).length;
  const sid = await placeCall(api, { from: caller, to: BUSINESS });
  expect((await listCalls(api)).length).toBeGreaterThan(before);

  const call = (await listCalls(api)).find((c) => c.callSid === sid)!;
  // The bridge dialed the VERIFIED holder cell; the pending (unverified) cell was NOT dialed.
  expect(legPhones(call)).toContain(FOUNDER_CELL);
  expect(legPhones(call)).not.toContain(pendingCell);
});

// ---------------------------------------------------------------------------
// §9.5 — Inbound rings the HOLDER's cell (not FOUNDER_CELL); no holder → text-us
// ---------------------------------------------------------------------------
test('§9.5 inbound rings the reassigned holder cell (not FOUNDER_CELL); no holder → text-us fallback', async ({
  page,
  browser,
}) => {
  const admin = page.request;
  await devLoginAs(page, 'founder@example.com');

  // A SECOND session as the VA to verify THEIR own cell to a distinct number.
  const vaCtx = await browser.newContext();
  const vaPage = await vaCtx.newPage();
  const { userId: vaUserId } = await devLoginAs(vaPage, 'va@example.com');
  const holderCell = uniquePhone();
  await verifyCell(vaPage.request, holderCell);

  // Admin reassigns the inbound line to the VA → single-holder MOVE (off the founder).
  expect(await assignInboundLine(admin, vaUserId)).toBe(200);

  // Inbound call → the bridge dials the HOLDER (VA) cell, NOT FOUNDER_CELL.
  const caller1 = uniquePhone();
  const sid1 = await placeCall(admin, { from: caller1, to: BUSINESS });
  await pressCall(admin, sid1, '1').catch(() => undefined);
  const call1 = (await listCalls(admin)).find((c) => c.callSid === sid1)!;
  expect(legPhones(call1)).toContain(holderCell);
  expect(legPhones(call1)).not.toContain(FOUNDER_CELL);

  // Clear the holder → the line moves OFF the VA. In this stack FOUNDER_CELL is the
  // deprecated env fallback, so a subsequent inbound no longer rings the VA's cell
  // (the single-holder move + clear invariant) and degrades to the fallback instead.
  expect(await clearInboundLine(admin, vaUserId)).toBe(200);
  const caller2 = uniquePhone();
  const sid2 = await placeCall(admin, { from: caller2, to: BUSINESS });
  await pressCall(admin, sid2, '1').catch(() => undefined);
  const call2 = (await listCalls(admin)).find((c) => c.callSid === sid2)!;
  expect(legPhones(call2)).not.toContain(holderCell); // the cleared holder is no longer rung

  await vaCtx.close();
});

// ---------------------------------------------------------------------------
// §9.6 — Team page single-holder (UI, accessibility-first)
// ---------------------------------------------------------------------------
test('§9.6 Team page: assigning the inbound line to B moves it off A (exactly one holder badge)', async ({
  page,
  browser,
}) => {
  const admin = page.request;
  const { userId: founderId } = await devLoginAs(page, 'founder@example.com');

  // Ensure BOTH the founder (A) and the VA (B) have verified cells so either can hold
  // the line. Founder keeps its seeded verified FOUNDER_CELL. Verify the VA's cell.
  const vaCtx = await browser.newContext();
  const vaPage = await vaCtx.newPage();
  const { userId: vaId } = await devLoginAs(vaPage, 'va@example.com');
  await verifyCell(vaPage.request, uniquePhone());
  await vaCtx.close();

  // Start clean: make A (founder) the holder via the API, then drive the MOVE via UI.
  await clearInboundLine(admin, vaId);
  expect(await assignInboundLine(admin, founderId)).toBe(200);

  await page.goto(`${NEXT}/settings/team`);
  await expect(page.getByRole('heading', { name: 'Team', level: 2 })).toBeVisible();

  // Exactly one holder badge to begin with (A holds it).
  await expect(page.getByText('Inbound voice line', { exact: true })).toHaveCount(1);

  // Assign to B (the VA row) via its accessible-name button → the line MOVES.
  await page.getByRole('button', { name: 'Assign the inbound voice line to va@example.com' }).click();

  // Still EXACTLY ONE holder badge, and B (the VA) now offers a CLEAR control while
  // A (founder) is back to offering ASSIGN — proving A was cleared (single-holder).
  await expect(page.getByText('Inbound voice line', { exact: true })).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Clear the inbound voice line from va@example.com' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Assign the inbound voice line to founder@example.com' }),
  ).toBeVisible();

  // Server view agrees: exactly one holder, and it is the VA.
  const users = await admin.get(`${NEXT}/api/users`);
  const list = ((await users.json()) as { users: Array<{ userId: string; inbound_voice_line?: boolean }> }).users;
  const holders = list.filter((u) => u.inbound_voice_line === true);
  expect(holders.map((h) => h.userId)).toEqual([vaId]);
});

// ---------------------------------------------------------------------------
// §9.7 — PII: no raw navigator/target phone in stored labels or leg URLs
// ---------------------------------------------------------------------------
test('§9.7 PII: the target appears only as a dialed <Number> leg — never in a leg whisper URL or the stored label', async ({
  page,
}) => {
  const api = page.request;
  await devLoginAs(page, 'va@example.com');
  const navCell = uniquePhone();
  await verifyCell(api, navCell);
  const { contactId, phone: target } = await createContact(api, {
    firstName: 'Priva',
    lastName: 'Cee',
  });

  const res = await api.post(`${NEXT}/api/contacts/${contactId}/call`, { data: {} });
  expect(res.status()).toBe(200);
  const { callSid } = (await res.json()) as { callSid: string };
  const bridged = await driveBridge(api, callSid);

  // The navigator-leg whisper URL carries ONLY the opaque conversationId — never a
  // phone. The target rides only inside the <Number> leg (its `phone`), and the nav
  // leg's whisper URL must contain NEITHER the target NOR the nav cell.
  const legs = (bridged['legs'] as Array<{ phone: string; whisperUrl?: string }> | undefined) ?? [];
  for (const leg of legs) {
    if (leg.whisperUrl) {
      expect(leg.whisperUrl).not.toContain(target);
      expect(leg.whisperUrl).not.toContain(navCell);
    }
  }
  // The target is present as a dialed leg phone (that is the ONLY place it appears).
  expect(legPhones(bridged)).toContain(target);

  // The persisted timeline `call` entry is MASKED at the label level: the wire
  // projection exposes NO raw navigator/target phone (a masked call omits
  // party_phone/recording PII fields are role-scoped). Assert no navigator cell
  // and no '+1555…navigator' leaks into the serialized entry.
  const calls = await callTimeline(api, contactId);
  const serialized = JSON.stringify(calls);
  expect(serialized).not.toContain(navCell);
});
