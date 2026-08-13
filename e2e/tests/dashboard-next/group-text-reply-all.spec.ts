import { test, expect, type Page } from '@playwright/test';
import {
  registerParty,
  sendGroupAsParty,
  listThreads,
  listConversations,
  setConversationState,
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

// THE DEFECT THIS COVERS END TO END (fix wave 4, H1). A Conversation that closes
// - Twilio's own auto-close timer, or an operator in the console - keeps its
// UniqueName, and our UniqueName is the conversationId. So the "closed rails are
// healed" path shipped in wave 2 could not heal anything: it cleared the stored
// sid, called ensureGroupRail, adopted THE SAME closed Conversation by
// UniqueName, and recorded rail_failed. Every send to that thread failed,
// forever, with no in-app remedy. The heal now DELETES the dead resource to
// reclaim the name and builds a fresh rail under it.
//
// Nothing in this spec is stubbed: the rail is real, the close is the state
// Twilio really puts it in, the refusal is the 50353 it really returns, and the
// proof is that a member's handset receives the reply.
test('a rail that CLOSED under a live thread is deleted, rebuilt and the reply still arrives', async ({
  page,
  request,
}) => {
  test.slow();
  const stamp = `${Date.now()}`.slice(-6);
  const DEE = `+1555082${stamp.slice(-4)}`;
  const ELI = `+1555083${stamp.slice(-4)}`;
  const conversationId = conversationIdForGroup([DEE, ELI]);
  const reply = `Rebuilt and still talking ${stamp}`;

  await registerParty(request, { label: `Dee ${stamp}`, role: 'tenant', number: DEE });
  await sendGroupAsParty(request, {
    from: DEE,
    otherRecipients: [ELI],
    body: `Both of us are in ${stamp}`,
  });

  await expect
    .poll(
      async () => (await listConversations(request)).some((c) => c.uniqueName === conversationId),
      { timeout: 20_000, message: 'the group rail was never created' },
    )
    .toBe(true);
  const original = (await listConversations(request)).find((c) => c.uniqueName === conversationId)!;

  // Twilio closes it. The UniqueName stays bound to this dead resource, which is
  // the whole trap.
  await setConversationState(request, { uniqueName: conversationId, state: 'closed' });

  await devLogin(page);
  await page.goto(`${NEXT}/conversations/${conversationId}`);
  const composer = page.getByRole('textbox', { name: 'Reply message' });
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill(reply);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  // The send SUCCEEDS. Before the heal it refused with "no usable Conversations
  // rail" and the message never appeared at all.
  await expect(page.getByText(reply)).toBeVisible({ timeout: 20_000 });

  // A DIFFERENT Conversation now holds the same UniqueName: the closed one was
  // deleted and the name reclaimed, rather than a second rail being minted
  // beside it under a suffixed name.
  await expect
    .poll(
      async () => {
        const rails = (await listConversations(request)).filter(
          (c) => c.uniqueName === conversationId,
        );
        return rails.length === 1 && rails[0]!.sid !== original.sid ? rails[0]!.sid : undefined;
      },
      { timeout: 20_000, message: 'the closed rail was never replaced under its own UniqueName' },
    )
    .not.toBeUndefined();

  // And the proof that matters: the handset really received it.
  await expect
    .poll(
      async () => {
        const thread = (await listThreads(request)).find((t) => t.partyNumber === ELI);
        return (thread?.messages ?? []).filter(
          (m) => m.direction === 'outbound' && m.body === reply && m.from === BUSINESS,
        ).length;
      },
      { timeout: 20_000, message: 'the rebuilt rail never delivered the reply' },
    )
    .toBe(1);
});
