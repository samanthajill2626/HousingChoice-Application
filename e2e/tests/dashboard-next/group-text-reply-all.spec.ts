import { test, expect, type Page } from '@playwright/test';
import {
  registerParty,
  sendGroupAsParty,
  listThreads,
  listConversations,
} from '../../fixtures/fakeTwilio.js';
import { clearLogTail, readLogTail } from '../../fixtures/groupText.js';
import { conversationIdForGroup } from '../../../app/src/lib/import/ids.js';

// SPEC 2 - reply-all: ONE send, every handset, per-member delivery.
//
// A17 IS BINDING AND SHAPES EVERY ASSERTION HERE. A group send leaves through
// the Conversations adapter, which the recording messaging driver does not
// wrap, so `/__dev/outbox` is STRUCTURALLY BLIND to it. Proving delivery
// against the outbox would produce a spec that fails for the wrong reason
// today and passes for the wrong reason tomorrow. Proof comes from the fake
// phones' own threads and from the per-member chips the receipts drive.
//
// The last assertion is the one worth stating plainly: NO unknown-provider-SID
// ERROR. A Conversations send persists its message under an IMxx, and any code
// path that also fired a classic status callback would arrive carrying an SMxx
// the app has no row for. Spec 16.2 says that path does not exist; this is the
// regression pin that keeps it that way.
//
// READ THIS BEFORE TOUCHING THAT ASSERTION (spec 16.2 amendment 5). It pins a
// regression IN THE FAKE - that the fake never starts emitting classic status
// callbacks for a Conversations-originated send. It is NOT coverage of the
// app's unknown-SID path, and a later reader must not mistake it for the
// latter and delete the app-side care it appears to prove. The app's handling
// of an unknown provider SID (park, bounded retry, then the ERROR this
// assertion watches for) is covered by its own unit tests and is load-bearing
// in production regardless of what this spec asserts.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const BUSINESS = process.env['BUSINESS_PHONE_NUMBER'] ?? '+15550009999';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('a dashboard reply reaches every handset once, with per-member delivery and no unknown-SID error', async ({
  page,
  request,
}) => {
  test.slow();
  const stamp = `${Date.now()}`.slice(-6);
  const ANA = `+1555079${stamp.slice(-4)}`;
  const BEN = `+1555080${stamp.slice(-4)}`;
  const CAL = `+1555081${stamp.slice(-4)}`;
  const conversationId = conversationIdForGroup([ANA, BEN, CAL]);
  const reply = `Confirming Saturday ${stamp}`;

  await registerParty(request, { label: `Ana ${stamp}`, role: 'tenant', number: ANA });
  await sendGroupAsParty(request, {
    from: ANA,
    otherRecipients: [BEN, CAL],
    body: `All three of us are coming ${stamp}`,
  });

  // The rail is created by a job, so wait for the Conversation to exist before
  // replying - without a rail the send is refused, and a spec that raced it
  // would fail with a refusal message about something else entirely.
  await expect
    .poll(
      async () => (await listConversations(request)).some((c) => c.uniqueName === conversationId),
      { timeout: 20_000, message: 'the group rail was never created' },
    )
    .toBe(true);

  const rail = (await listConversations(request)).find((c) => c.uniqueName === conversationId)!;
  // THE PARTICIPANT SHAPE, as the adapter actually built it: the business
  // number is its own projected-address participant, each member is
  // address-only. Getting this wrong is Twilio's 50407.
  expect(rail.participants.filter((p) => p.projectedAddress === BUSINESS)).toHaveLength(1);
  expect(rail.participants.filter((p) => p.address !== undefined).map((p) => p.address).sort()).toEqual(
    [ANA, BEN, CAL].sort(),
  );

  // A clean window, so "no ERROR" means "none caused by this send".
  await clearLogTail(request);

  await devLogin(page);
  await page.goto(`${NEXT}/conversations/${conversationId}`);
  await expect(page.getByText(/Everyone in this group text sees everyone's real number/)).toBeVisible({
    timeout: 15_000,
  });

  const composer = page.getByRole('textbox', { name: 'Reply message' });
  await expect(composer).toBeEnabled();
  await composer.fill(reply);
  // EXACT: a tenant's contact page also carries a "+ Send" aside whose
  // accessible name is "Send a property to this tenant", so a substring match
  // on "Send" is a strict-mode violation - and only on a tenant's page.
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(reply)).toBeVisible({ timeout: 15_000 });

  // 1) EVERY handset got it, EXACTLY ONCE, from the BUSINESS number. "Exactly
  //    once" is the half that matters: a fan-out bug shows up as duplicates on
  //    one member's phone, not as an error anywhere.
  for (const member of [ANA, BEN, CAL]) {
    await expect
      .poll(
        async () => {
          const thread = (await listThreads(request)).find((t) => t.partyNumber === member);
          return (thread?.messages ?? []).filter(
            (m) => m.direction === 'outbound' && m.body === reply && m.from === BUSINESS,
          ).length;
        },
        { timeout: 20_000, message: `the group send never reached ${member}` },
      )
      .toBe(1);
  }

  // 2) The per-member delivery rollup finalizes green once every receipt lands.
  //    This is the ONLY delivery signal a Conversations send produces.
  //
  //    DELIBERATELY NOT RELOADED. This poll used to call `page.reload()` on
  //    every sample, which made it pass against a product that never pushed the
  //    update at all: group receipts updated `delivery_recipients` and emitted
  //    no SSE, so a live operator watched `Delivered 0/3` until they refreshed.
  //    The reload was added in wave 4 to settle a "flaky" assertion that was in
  //    fact reporting that defect. The receipts path now emits
  //    `message.persisted` exactly as the relay path does, so THE PAGE IS NEVER
  //    TOUCHED HERE - the rollup has to arrive on its own. If this goes flaky,
  //    the push is broken; do not put the reload back.
  await expect
    .poll(async () => page.getByText(`Delivered ${3}/${3}`).count(), {
      timeout: 60_000,
      message: 'the per-member delivery rollup never finalized LIVE (no reload) - the SSE push is missing',
    })
    .toBeGreaterThan(0);

  // 3) NO unknown-provider-SID error. Checked over the whole window, not just
  //    for this conversation, because the failure mode is a stray callback
  //    arriving with a SID nothing can attribute - it would name no thread.
  const errors = await readLogTail(request, { level: 'error' });
  expect(
    errors.filter((l) => (l.msg ?? '').includes('status callback for unknown provider SID')),
  ).toHaveLength(0);
});
