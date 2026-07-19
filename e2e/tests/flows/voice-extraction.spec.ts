import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { reseed } from '../../fixtures/reseed.js';
import { extractionTick, sendExtractSms, planTranscribedCall } from '../../fixtures/extraction.js';

// Voice-extraction end-to-end against the hermetic stack, reusing the DETERMINISTIC
// FAKE extraction driver (EXTRACTION_DRIVER=fake). The full pipeline runs for real -
// a planted COMPLETED call transcript (via POST /__dev/voice/transcript-fixture)
// schedules an IMMEDIATE voice-channel run, then POST /__dev/extraction/tick drives
// the worker job synchronously -> guarded apply -> dashboard chips/badges. The ONLY
// substitution is the LLM: an EXTRACT: marker on a CLIENT-speaker line is parsed by
// the fake driver into the exact ExtractionResult (the fake reads ONLY client lines).
//
// The three attribution layers exercised here (voice-extraction spec section 3):
//   1. VOICEMAIL   - single-channel, unprefixed -> toUtterances attributes the line
//      to the CLIENT by construction; a voice trigger + client attribution proof.
//   2. ATTRIBUTED  - dual-channel bridge with a full { "1":"client","2":"staff" }
//      roles map -> Client:/Staff: prefixes -> known role -> FULL write policy.
//   3. UNATTRIBUTED- a 2-channel bridge with NO roles map -> Speaker N: lines ->
//      'unknown' utterances -> the whole run is DEMOTED to suggest-only (Layer 3).
// Plus the SuggestionChip action-row wrap (spec section 6): "View conversation"
// stays visible + the chip never overflows horizontally at the desktop card width.
//
// Accessible names are the slice-1 / R5 contract:
//   - AutoBadge  -> role img, name "Auto"
//   - chip       -> role group, name `AI suggestion for <label>`; text `AI heard "<value>"`
//   - link       -> role link, name "View conversation"

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

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

let callSeq = 0;
/** A per-plant-unique Twilio-shaped CallSid so the call append never dedupes. */
function uniqueCallSid(): string {
  callSeq += 1;
  return `CA${Date.now()}${String(callSeq).padStart(2, '0')}`;
}

/** Create a fresh TENANT via the authenticated API (never touches seeded rows).
 *  `pets` pre-seeds the intake field so its row (and any suggestion chip nested
 *  under it) renders. Returns the new contactId + its phone. */
async function createTenant(
  request: APIRequestContext,
  opts: { firstName: string; voucherSize?: number; status?: string; pets?: string } = { firstName: 'Voice' },
): Promise<{ contactId: string; phone: string }> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName: opts.firstName,
      lastName: 'Voice',
      phone,
      ...(opts.voucherSize !== undefined && { voucherSize: opts.voucherSize }),
      ...(opts.status !== undefined && { status: opts.status }),
      ...(opts.pets !== undefined && { pets: opts.pets }),
    },
  });
  expect(res.ok(), `create tenant ${opts.firstName}`).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  return { contactId, phone };
}

/** Resolve (create-or-get) the contact's 1:1 conversationId - the SAME phone-keyed
 *  thread an inbound SMS from that contact lands in (createOrGetByParticipantPhone,
 *  one active conversation per external phone). */
async function ensureConversation(request: APIRequestContext, contactId: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/contacts/${contactId}/conversation`);
  expect(res.ok(), 'ensure conversation').toBeTruthy();
  return (await res.json()).conversation.conversationId as string;
}

// A clean slate once for the file; each test still uses fresh per-run contacts.
test.beforeAll(async ({ request }) => {
  await reseed(request);
});

test('voicemail: a single-channel transcript triggers a voice run that suggests pets', async ({
  page,
  request,
}) => {
  await devLogin(page);
  // Pre-seed pets so the Eligibility-intake pets row (and the review chip nested
  // under it) renders - the card only shows the pets row when pets is set.
  const { contactId } = await createTenant(page.request, { firstName: 'Voicemail', pets: 'none' });
  const conversationId = await ensureConversation(page.request, contactId);

  // A voicemail is single-channel + unprefixed; toUtterances maps the unprefixed
  // line to the CLIENT, so the fake driver reads the marker. No roles (voicemail).
  await planTranscribedCall(request, {
    conversationId,
    callSid: uniqueCallSid(),
    sentences: [
      {
        text: 'EXTRACT:{"fields":{"pets":{"op":"suggest","value":"has a dog","reason":"voicemail"}}}',
        mediaChannel: 1,
      },
    ],
  });
  const tick = await extractionTick(request);
  expect(tick.processed).toBeGreaterThanOrEqual(1);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const chip = page.getByRole('group', { name: 'AI suggestion for pets' });
  await expect(chip).toBeVisible();
  await expect(chip.getByText('AI heard "has a dog"')).toBeVisible();
});

test('attributed bridge: Client:/Staff: roles let a call fact direct-write with an Auto badge', async ({
  page,
  request,
}) => {
  await devLogin(page);
  const { contactId } = await createTenant(page.request, { firstName: 'Bridge' });
  const conversationId = await ensureConversation(page.request, contactId);

  // Dual-channel bridge with source-attributed roles: channel 1 = client, 2 = staff.
  // joinViSentences renders Client:/Staff: prefixes; toUtterances attributes the
  // marker line to the client with a KNOWN role -> full write policy (no demotion).
  await planTranscribedCall(request, {
    conversationId,
    callSid: uniqueCallSid(),
    roles: { '1': 'client', '2': 'staff' },
    sentences: [
      { text: 'EXTRACT:{"fields":{"pets":{"op":"write","value":"cat","reason":"said cat"}}}', mediaChannel: 1 },
      { text: 'ok noted', mediaChannel: 2 },
    ],
  });
  const tick = await extractionTick(request);
  expect(tick.processed).toBeGreaterThanOrEqual(1);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const intake = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Eligibility intake' }) });
  await expect(intake).toBeVisible();
  await expect(intake.getByText('cat')).toBeVisible();
  await expect(intake.getByRole('img', { name: 'Auto' })).toBeVisible();
  // A direct write - NOT a suggestion - so there is no review chip for pets.
  await expect(page.getByRole('group', { name: 'AI suggestion for pets' })).toHaveCount(0);
});

test('unattributed bridge: a Speaker-N call demotes a same-window write to a suggestion', async ({
  page,
  request,
}) => {
  await devLogin(page);
  // Empty voucherSize: ABSENT demotion the write would land directly (with an Auto
  // badge) - the Speaker-N call is what turns it into a suggestion (the proof).
  const { contactId, phone } = await createTenant(page.request, { firstName: 'Demote' });
  const conversationId = await ensureConversation(page.request, contactId);

  // The FACT rides an inbound CLIENT sms - the fake driver reads only client lines;
  // a Speaker-N call line is 'unknown' + prefix-kept, so ITS marker would be invisible.
  await sendExtractSms(request, phone, {
    fields: { voucherSize: { op: 'write', value: '3', reason: 'said three bedroom' } },
  });
  // A dual-channel call with NO roles -> Speaker N: lines -> 'unknown' utterances in
  // the same window -> run-level demotion (Layer 3). It carries no marker of its own.
  await planTranscribedCall(request, {
    conversationId,
    callSid: uniqueCallSid(),
    sentences: [
      { text: 'hello there', mediaChannel: 1 },
      { text: 'hi back', mediaChannel: 2 },
    ],
  });
  const tick = await extractionTick(request);
  expect(tick.processed).toBeGreaterThanOrEqual(1);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const details = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Details' }) });
  // Demoted: the write arrives as a SUGGESTION, not a direct write.
  const chip = page.getByRole('group', { name: 'AI suggestion for voucher size' });
  await expect(chip).toBeVisible();
  await expect(chip.getByText('AI heard "3"')).toBeVisible();
  // Nothing was written, so there is NO AI provenance badge in the Details card.
  await expect(details.getByRole('img', { name: 'Auto' })).toHaveCount(0);
});

test('chip wrap: the "View conversation" action stays visible and never overflows the chip', async ({
  page,
  request,
}) => {
  await devLogin(page);
  // Plant a voucherSize SUGGESTION (its chip renders unconditionally in the narrow
  // Details card - the exact place the action row used to clip) via a voicemail.
  const { contactId } = await createTenant(page.request, { firstName: 'ChipWrap' });
  const conversationId = await ensureConversation(page.request, contactId);
  await planTranscribedCall(request, {
    conversationId,
    callSid: uniqueCallSid(),
    sentences: [
      {
        text: 'EXTRACT:{"fields":{"voucherSize":{"op":"suggest","value":"3","reason":"mentioned a 3 bedroom"}}}',
        mediaChannel: 1,
      },
    ],
  });
  const tick = await extractionTick(request);
  expect(tick.processed).toBeGreaterThanOrEqual(1);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const chip = page.getByRole('group', { name: 'AI suggestion for voucher size' });
  await expect(chip).toBeVisible();

  // At the desktop two-pane Details-card width the third action wraps rather than
  // clipping: the "View conversation" link is visible, its actions container has no
  // horizontal overflow, and the link's box sits within the chip's box. (390px
  // mobile is covered by live QA, not this spec.)
  const link = chip.getByRole('link', { name: 'View conversation' });
  await expect(link).toBeVisible();

  // The actions container is the link's parent <span> (CSS-module class is hashed,
  // so reach it structurally). flex-wrap keeps scrollWidth <= clientWidth.
  const actionsNoOverflow = await link
    .locator('xpath=..')
    .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(actionsNoOverflow).toBe(true);

  // Belt-and-braces: the chip itself never overflows horizontally, and the link's
  // right edge sits within the chip's right edge (it wrapped, it did not clip).
  const chipNoOverflow = await chip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(chipNoOverflow).toBe(true);
  const chipBox = await chip.boundingBox();
  const linkBox = await link.boundingBox();
  expect(chipBox).not.toBeNull();
  expect(linkBox).not.toBeNull();
  expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(chipBox!.x + chipBox!.width + 1);
});
