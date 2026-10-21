# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: flows\voice-extraction.spec.ts >> unattributed bridge: a Speaker-N call demotes a same-window write to a suggestion
- Location: tests\flows\voice-extraction.spec.ts:155:1

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: /Continue as dev user/i })

```

# Test source

```ts
  1   | import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
  2   | import { reseed } from '../../fixtures/reseed.js';
  3   | import { extractionTick, sendExtractSms, planTranscribedCall } from '../../fixtures/extraction.js';
  4   | import { expectTodayReady } from '../../support/today.js';
  5   | 
  6   | // Voice-extraction end-to-end against the hermetic stack, reusing the DETERMINISTIC
  7   | // FAKE extraction driver (EXTRACTION_DRIVER=fake). The full pipeline runs for real -
  8   | // a planted COMPLETED call transcript (via POST /__dev/voice/transcript-fixture)
  9   | // schedules an IMMEDIATE voice-channel run, then POST /__dev/extraction/tick drives
  10  | // the worker job synchronously -> guarded apply -> dashboard chips/badges. The ONLY
  11  | // substitution is the LLM: an EXTRACT: marker on a CLIENT-speaker line is parsed by
  12  | // the fake driver into the exact ExtractionResult (the fake reads ONLY client lines).
  13  | //
  14  | // The three attribution layers exercised here (voice-extraction spec section 3):
  15  | //   1. VOICEMAIL   - single-channel, unprefixed -> toUtterances attributes the line
  16  | //      to the CLIENT by construction; a voice trigger + client attribution proof.
  17  | //   2. ATTRIBUTED  - dual-channel bridge with a full { "1":"client","2":"staff" }
  18  | //      roles map -> Client:/Staff: prefixes -> known role -> FULL write policy.
  19  | //   3. UNATTRIBUTED- a 2-channel bridge with NO roles map -> Speaker N: lines ->
  20  | //      'unknown' utterances -> the whole run is DEMOTED to suggest-only (Layer 3).
  21  | // Plus the SuggestionChip action-row wrap (spec section 6): "View conversation"
  22  | // stays visible + the chip never overflows horizontally at the desktop card width.
  23  | //
  24  | // Accessible names are the slice-1 / R5 contract:
  25  | //   - AutoBadge  -> role img, name "Auto"
  26  | //   - chip       -> role group, name `AI suggestion for <label>`; text `AI heard "<value>"`
  27  | //   - link       -> role link, name "View conversation"
  28  | 
  29  | const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
  30  | 
  31  | async function devLogin(page: Page): Promise<void> {
  32  |   await page.goto(`${NEXT}/`);
> 33  |   await page.getByRole('button', { name: /Continue as dev user/i }).click();
      |                                                                     ^ Error: locator.click: Test timeout of 60000ms exceeded.
  34  |   await expectTodayReady(page);
  35  | }
  36  | 
  37  | let seq = 0;
  38  | /** Per-run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
  39  | function uniquePhone(): string {
  40  |   seq += 1;
  41  |   const stamp = `${Date.now()}`.slice(-5);
  42  |   return `+1555${stamp}${String(seq).padStart(2, '0')}`;
  43  | }
  44  | 
  45  | let callSeq = 0;
  46  | /** A per-plant-unique Twilio-shaped CallSid so the call append never dedupes. */
  47  | function uniqueCallSid(): string {
  48  |   callSeq += 1;
  49  |   return `CA${Date.now()}${String(callSeq).padStart(2, '0')}`;
  50  | }
  51  | 
  52  | /** Create a fresh TENANT via the authenticated API (never touches seeded rows).
  53  |  *  `pets` pre-seeds the intake field so its row (and any suggestion chip nested
  54  |  *  under it) renders. Returns the new contactId + its phone. */
  55  | async function createTenant(
  56  |   request: APIRequestContext,
  57  |   opts: { firstName: string; voucherSize?: number; status?: string; pets?: string } = { firstName: 'Voice' },
  58  | ): Promise<{ contactId: string; phone: string }> {
  59  |   const phone = uniquePhone();
  60  |   const res = await request.post(`${NEXT}/api/contacts`, {
  61  |     data: {
  62  |       type: 'tenant',
  63  |       firstName: opts.firstName,
  64  |       lastName: 'Voice',
  65  |       phone,
  66  |       ...(opts.voucherSize !== undefined && { voucherSize: opts.voucherSize }),
  67  |       ...(opts.status !== undefined && { status: opts.status }),
  68  |       ...(opts.pets !== undefined && { pets: opts.pets }),
  69  |     },
  70  |   });
  71  |   expect(res.ok(), `create tenant ${opts.firstName}`).toBeTruthy();
  72  |   const contactId = (await res.json()).contact.contactId as string;
  73  |   return { contactId, phone };
  74  | }
  75  | 
  76  | /** Resolve (create-or-get) the contact's 1:1 conversationId - the SAME phone-keyed
  77  |  *  thread an inbound SMS from that contact lands in (createOrGetByParticipantPhone,
  78  |  *  one active conversation per external phone). */
  79  | async function ensureConversation(request: APIRequestContext, contactId: string): Promise<string> {
  80  |   const res = await request.post(`${NEXT}/api/contacts/${contactId}/conversation`);
  81  |   expect(res.ok(), 'ensure conversation').toBeTruthy();
  82  |   return (await res.json()).conversation.conversationId as string;
  83  | }
  84  | 
  85  | // A clean slate once for the file; each test still uses fresh per-run contacts.
  86  | test.beforeAll(async ({ request }) => {
  87  |   await reseed(request);
  88  | });
  89  | 
  90  | test('voicemail: a single-channel transcript triggers a voice run that suggests pets', async ({
  91  |   page,
  92  |   request,
  93  | }) => {
  94  |   await devLogin(page);
  95  |   // Pre-seed pets so the Eligibility-intake pets row (and the review chip nested
  96  |   // under it) renders - the card only shows the pets row when pets is set.
  97  |   const { contactId } = await createTenant(page.request, { firstName: 'Voicemail', pets: 'none' });
  98  |   const conversationId = await ensureConversation(page.request, contactId);
  99  | 
  100 |   // A voicemail is single-channel + unprefixed; toUtterances maps the unprefixed
  101 |   // line to the CLIENT, so the fake driver reads the marker. No roles (voicemail).
  102 |   await planTranscribedCall(request, {
  103 |     conversationId,
  104 |     callSid: uniqueCallSid(),
  105 |     sentences: [
  106 |       {
  107 |         text: 'EXTRACT:{"fields":{"pets":{"op":"suggest","value":"has a dog","reason":"voicemail"}}}',
  108 |         mediaChannel: 1,
  109 |       },
  110 |     ],
  111 |   });
  112 |   const tick = await extractionTick(request);
  113 |   expect(tick.processed).toBeGreaterThanOrEqual(1);
  114 | 
  115 |   await page.goto(`${NEXT}/contacts/${contactId}`);
  116 |   const chip = page.getByRole('group', { name: 'AI suggestion for pets' });
  117 |   await expect(chip).toBeVisible();
  118 |   await expect(chip.getByText('AI heard "has a dog"')).toBeVisible();
  119 | });
  120 | 
  121 | test('attributed bridge: Client:/Staff: roles let a call fact direct-write with an Auto badge', async ({
  122 |   page,
  123 |   request,
  124 | }) => {
  125 |   await devLogin(page);
  126 |   const { contactId } = await createTenant(page.request, { firstName: 'Bridge' });
  127 |   const conversationId = await ensureConversation(page.request, contactId);
  128 | 
  129 |   // Dual-channel bridge with source-attributed roles: channel 1 = client, 2 = staff.
  130 |   // joinViSentences renders Client:/Staff: prefixes; toUtterances attributes the
  131 |   // marker line to the client with a KNOWN role -> full write policy (no demotion).
  132 |   await planTranscribedCall(request, {
  133 |     conversationId,
```