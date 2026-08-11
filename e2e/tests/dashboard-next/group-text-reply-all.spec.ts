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
  //    RELOAD-POLLED, not waited on. Group delivery receipts arrive on the
  //    Conversations webhook and emit NO SSE event, so nothing pushes the open
  //    thread: a bare `toBeVisible` here was passing only because the post-send
  //    `message.persisted` refetch happened to land after the fake's delivery
  //    ladder, a margin of about a hundred milliseconds. The rollup is
  //    refetch-driven, so the spec has to drive the refetch - the same pattern
  //    the STOP spec uses for its own `Delivered 2/2`.
  await expect
    .poll(
      async () => {
        await page.reload();
        // `count()` takes a snapshot with no auto-wait, so wait for the thread
        // to have rendered before counting - otherwise every sample measures an
        // empty SPA.
        await page.getByText(reply).waitFor({ timeout: 15_000 });
        return page.getByText(`Delivered ${3}/${3}`).count();
      },
      { timeout: 60_000, message: 'the per-member delivery rollup never finalized' },
    )
    .toBeGreaterThan(0);

  // 3) NO unknown-provider-SID error. Checked over the whole window, not just
  //    for this conversation, because the failure mode is a stray callback
  //    arriving with a SID nothing can attribute - it would name no thread.
  const errors = await readLogTail(request, { level: 'error' });
  expect(
    errors.filter((l) => (l.msg ?? '').includes('status callback for unknown provider SID')),
  ).toHaveLength(0);
});
