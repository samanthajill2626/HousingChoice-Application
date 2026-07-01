// Shared Voice Phase 1 setup + drive helpers — the SINGLE source of truth for the
// e2e moves both the low-level voice-outbound.spec.ts and the diagram-driven
// landlord-onboarding scenario need:
//
//   - verifyCell / readVerifyCode : verify the CURRENT session user's cell FOR
//     REAL (spec §7) — verify-start sends a 6-digit SMS code (dispatched via the
//     fake), which we read back from /__dev/outbox → verify-confirm. This is the
//     exact self-service path a navigator uses before placing masked calls; the
//     originate route 409s `cell_not_verified` without it.
//   - driveBridge : press '1' on the paused navigator leg and wait for the bridge
//     to complete (whisper accept → <Dial> the target from the business number →
//     <Dial action> summary → recording), exactly as a navigator pressing 1 on
//     their ringing cell would.
//   - callTimeline / legPhones / uniqueVoicePhone : small readers/generators the
//     assertions share.
//
// Both consumers pass their own APIRequestContext (page.request), which carries the
// live session cookie + the :5174 baseURL — so getOutbox's relative /__dev/outbox
// and the ${NEXT} API calls resolve against the same authenticated stack.
import { expect, type APIRequestContext } from '@playwright/test';
import { getOutbox } from './outbox.js';
import { pressCall, type FakeCall } from './fakeVoice.js';

/** The dashboard dev-server origin (the :5174 proxy that fronts the app :8080). */
export const NEXT = 'http://localhost:5174';

/** Per-run-unique NANP E.164s so cases never collide (mirrors steps.freshContact
 *  / the local uniquePhone the voice spec used to keep). */
let voiceSeq = 0;
export function uniqueVoicePhone(): string {
  const stamp = `${Date.now()}`.slice(-5);
  voiceSeq += 1;
  return `+1555${stamp}${String(voiceSeq).padStart(2, '0')}`;
}

/** Poll /__dev/outbox for the verification SMS to `cell` and extract its 6-digit code. */
export async function readVerifyCode(api: APIRequestContext, cell: string): Promise<string> {
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

/**
 * Verify the CURRENT session user's cell FOR REAL (spec §7): verify-start sends a
 * 6-digit SMS code (which the app really dispatches via the fake) → we read it from
 * /__dev/outbox → verify-confirm stamps cell_verified_at. Returns the verified cell.
 * This is the exact self-service path a navigator uses before placing masked calls.
 */
export async function verifyCell(api: APIRequestContext, cell: string): Promise<string> {
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

/**
 * Press '1' on the navigator leg and wait for the bridge to complete. The app's
 * originate route places the fake call fire-and-forget (Twilio's Calls.json returns
 * the queued sid immediately, then the CallEngine fetches the outbound-bridge TwiML
 * asynchronously), so a press can land BEFORE the engine has built the pre-dial gate
 * — in which case it no-ops and the call stays `ringing`. Retry the press until the
 * call reaches a terminal state. Returns the terminal FakeCall.
 */
export async function driveBridge(api: APIRequestContext, callSid: string): Promise<FakeCall> {
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
export function legPhones(call: FakeCall): string[] {
  const legs = (call['legs'] as Array<{ phone: string }> | undefined) ?? [];
  return legs.map((l) => l.phone);
}

/** The contact's `call` timeline entries (kind:'call'), oldest-first (C2 order). */
export async function callTimeline(
  api: APIRequestContext,
  contactId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}/timeline?kinds=call&limit=50`);
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { items: Array<Record<string, unknown>> };
  return body.items.filter((i) => i['kind'] === 'call');
}
