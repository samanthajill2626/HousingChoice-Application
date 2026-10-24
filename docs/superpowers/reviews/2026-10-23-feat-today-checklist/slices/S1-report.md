# S1 slice report - the signal (today-checklist, tracker #31)

Branch feat/today-checklist, S1 built on 498aae0b. Commits, in order:
299060f8 (S1.1), 35328d4f (S1.2), e96b914a (S1.3), 4e8162e8 (S1.4),
a274dae7 (S1.5), 06f173da (S1.6), 93dc924e (S1.7). Line numbers below are
at 93dc924e.

## Where the tree and the plan differed

- No anchor drift. Every S1.1-S1.7 old text matched verbatim and uniquely;
  the plan's line hints were off by the lines earlier S1 tasks added
  (expected), nothing else.
- WL-1 (worklist wins over plan S1.6 Step 2): a shape-only stub
  `app/src/services/staffOutreach.ts` (interface + `return []`) was written
  first, so the RED ran per case instead of failing at module load. RED
  seen: 7 test cases failed on their assertions (D1-1's list; WL-1 says
  "six" because it counts the reject/throw loop at
  `app/test/staffOutreach.test.ts:119` as one case - it yields two), and
  the 2 PINs ('no stamps ...', "'skipped' ...") were green on the stub.
  The stub was replaced by the Step 3 body before the commit; it was never
  committed (`git log -- app/src/services/staffOutreach.ts` shows only
  06f173da, whose blob is the real body).
- S1.5 3a: anchored on the `getById(...)` interface line plus the next
  doc-comment opener (`app/src/repos/conversationsRepo.ts:561-570`) rather
  than the single line; same result, no divergence in content.
- S1.8 Step 1's seed check omits `app/src/lib/seedData.ts`; checked it too
  (empty diff vs 970a29b9). WI9 holds for every seed file.
- Naming note, no action: `getByIdConsistent` already exists on the
  broadcasts repo (`app/src/repos/broadcastsRepo.ts:429`, harness
  `twilioWebhookHarness.ts:3861`). The new conversations method follows that
  precedent; there is no collision (different repo objects).

## Contradictions C1-C5 (plan section 5) - resolved

- C1: exactly five full `ContactsRepo` literals needed the new member and
  got it: harness `app/test/helpers/twilioWebhookHarness.ts:2280` (recording
  twin, :2684), throwing stubs at `app/test/sendMessage.test.ts:277`,
  `app/test/audienceResolution.test.ts:141`,
  `app/test/contactCapture.test.ts:159`,
  `app/test/scheduledSendSuppression.test.ts:293`. `npm run typecheck` exit
  0 after S1.2 named no other literal. Pick-typed fakes deliberately NOT
  edited (they do not include the new member): `importOrgNames`,
  `groupTextWebhook`, `inboundEmail`, `unmatchedEmailRoutes`,
  `devTranscriptFixture`, `devMessageTransportFixture`. S2 note: when PR14
  widens the dev router Pick (`app/src/routes/dev.ts:160`), the two
  dev-fixture rigs (`devTranscriptFixture.test.ts:27`,
  `devMessageTransportFixture.test.ts:24`) need a `touchLastReachedOut`.
- C2: exactly four full `ConversationsRepo` literals got `getByIdConsistent`:
  harness `twilioWebhookHarness.ts:695` (answers `getById`'s object), and
  throwing stubs at `app/test/contactCapture.test.ts:168`,
  `app/test/scheduledSendSuppression.test.ts:157`,
  `app/test/sendMessage.test.ts:125`. Typecheck after S1.5 exit 0, no other
  literal named.
- C3: see "world.emitted" below.
- C4: built to PR5/PR44 (stamps array in, written ids out), not the spec
  7.3 sketch: `app/src/services/staffOutreach.ts:45-70`.
- C5: `getByIdConsistent` filters nothing, exactly like `getById`; the doc
  comment says so (`app/src/repos/conversationsRepo.ts:562-570`, impl
  `:1139-1144`, return literal `:1293`).

## Deliberate test changes (each stricter or additive, none weakened)

- `app/test/caseworkerRepoParity.integration.test.ts:446-473` (PR1): the
  exact-projection pin now seeds and expects `last_reached_out_at`; retitled
  to name it. Its neighbour (the "nothing else" case) is unchanged and green.
- `app/test/contactsBatchIncomplete.test.ts:280-295` (PR1): the
  `arrayContaining` list gains `last_reached_out_at`, plus two new asserts
  on the `#lastReachedOutAt` placeholder.
- `app/test/followUps.test.ts:46` (PR7): `RECIPIENT_ATTRS` fixture gains the
  field (additive; the fake now projects what the real projection does).
- `app/test/contactTriage.test.ts` (PR43, C3): the two exact pins whose
  PATCH already emitted `contact.updated` (`app/src/routes/contacts.ts:2230`)
  now name it:
  - `:155-167` type=tenant: was `toEqual([conversation.updated])` (1 event)
    -> `[conversation.updated, { event: 'contact.updated', payload:
    { contactId: 'contact-triage-1' } }]` (2 events, in that order).
  - `:365` type=team_member: was `toHaveLength(0)` -> `toEqual([{ event:
    'contact.updated', payload: { contactId: 'contact-triage-1' } }])`; the
    title (`:350`) now says "or emit conversation.updated"; the arrow comment
    line was replaced whole by ASCII lines (`:361-364`).
  - The AR3 preamble comment (`:61-66`) rewritten.
- `app/test/sse.test.ts:218-220`: comment only (the contact.updated baseline
  now equals the shared one; the separate baseline is kept).
- No further `world.emitted` pin went red in S1.7 Step 4's 12 files or in
  the full app workspace run (so none was missed beyond C3's two).
  `contactTriage.test.ts:331` (name-only PATCH, `toHaveLength(1)`) stays
  green as D1 predicted.

## Watch items

- WI1 (S1 part): with only the additive `RECIPIENT_ATTRS` change,
  `followUps.test.ts`, `followUpsApi.test.ts`, `listingSendsApi.test.ts` and
  `listingSendOutcomeApi.test.ts` stayed green after S1.1 (6 files / 158
  tests with the two S1.1 test files) and after S1.3 (7 files / 119 tests).
- WI9: `git diff --stat 970a29b9 -- app/src/lib/seed app/src/lib/performanceSeed.ts app/scripts/db-seed.ts app/src/lib/events.ts`
  printed nothing; `app/src/lib/seedData.ts` also unchanged. S1 adds no emit
  and does not touch `events.ts` (`contact.updated` already at
  `app/src/lib/events.ts:329, :351`).

## Gates run in S1 (fast gates only, as briefed)

- `npm run typecheck` (bare, root): exit 0 after S1.1, S1.2, S1.3, S1.5,
  S1.6, S1.7 and at S1.8.
- eslint on the slice's 21 files (S1.8 Step 3 list = every file the slice
  changed vs 970a29b9): exit 0, no output. No baseline comparison needed.
- App workspace once (`cd app; npx vitest run`, redirected to a log):
  exit 0; Test Files 531 passed (531); Tests 11206 passed | 1 skipped
  (11207); duration 114.76s. No red file, so no re-run. No `[dynamoAdmin]`
  line (the only matches were the `dynamoAdminRetry.test.ts` file name).
- ASCII: `git diff -U0 970a29b9 -- app | grep '^+' | tr ...` = 0; each new
  file = 0. The only removed non-ASCII line in the slice is the deliberate
  arrow line above. No `\u` escape exists in any touched file (base and head
  counts both 0).

## Risks and notes for later slices

- The harness `touchLastReachedOut` (`twilioWebhookHarness.ts:2684-2698`)
  does NOT refuse pointer ids, as its `touchLastHeardFrom` twin does not;
  the real repo does (`app/src/repos/contactsRepo.ts:2077`). Writer tests
  must stamp real contact ids; a pointer-id stamp would read as 'written'
  in the harness only.
- `world.recipientDisplayCalls` (`twilioWebhookHarness.ts:546-549`, push at
  `:2326`) stores a SHALLOW copy of `opts`, present only when the caller
  passed one: assertions must read `call.opts?.consistentRead` (PR60/PR82).
- `recordStaffOutreach` swallows a throwing or rejecting touch as 'failed'
  with ONE ERROR line `{ contactId }` (`staffOutreach.ts:56-68`). A writer
  test still on an S1 throwing stub (sendMessage, contactCapture,
  scheduledSendSuppression, audienceResolution) sees "no stamp + one ERROR
  line", not a crash; S2's W1/W2 cases in `sendMessage.test.ts` must swap
  the stub for a recording one (PR7 exception).
- `app/test/sendEmailMessage.test.ts:119` casts a contacts object without
  `touchLastReachedOut`; after S2's W3 wiring the helper would log ERROR
  there unless S2 adds a recording method (plan cross-slice note).
- Untrimmed input paths: none new. The field is server-owned and refused by
  both contact parsers (`app/src/routes/contacts.ts:314-320`); no client
  value is parsed.
