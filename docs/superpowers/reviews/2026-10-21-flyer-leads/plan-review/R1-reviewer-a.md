# Plan review R1 - reviewer A (adversarial, plan-blind)

Plan: `docs/superpowers/plans/2026-10-21-flyer-leads-plan.md` (v1, d5684bbe).
Spec: `docs/superpowers/specs/2026-10-21-flyer-leads-design.md` (rev 6).
Method: walked D1-D10, spec section 4 (surfaces) and section 5 (tests) to
tasks; read every slice against the code it anchors on; grepped the app,
dashboard and e2e workspaces for writers and readers the plan does not name.
Nothing was executed in the worktree.

## Overall verdict

No BLOCKING or HIGH finding. Coverage is complete: every D1-D10 decision,
every section 4 surface and every section 5 test bullet maps to a task (or a
deliberate no-change with a pin). The assembly rulings AR1-AR10 are obeyed by
the slice text (AR4's build order supersedes stale order text inside S1, S2
and S6 - see F9). The surface enumeration held up against a whole-app grep.

Verified directly (not taken from the plan), so a later round need not repeat:

- Outcome derivation callers are exactly five (`grep deriveListingSendOutcome`
  over `app/src` + `app/scripts`): `contacts.ts:1324`, `units.ts:240,260`,
  `followUps.ts:168`, `broadcasts.ts:612`. No app switch over the union.
- `listing_sends` readers/writers: the repo methods used anywhere are
  getByKeyConsistent, getByKeys, listByContact, listByUnit, putShareMemory,
  setDeclined, clearDeclined; the only decline writers are the outcome route
  (`units.ts:1656,1671,1700`). No `by: 'engine'` writer exists in `app/src`
  today, so O1's two writers are the complete set.
- No reader of a pair's `via` or `broadcastId` outside the ledger/jobs
  (`grep "\.via\b|broadcastId"` over `app/src`), so `summarize` mapping
  `flyer` to no broadcastId breaks no consumer.
- `PUBLIC_FLYER_NOTE` renders only in `TaggedField.tsx:58`; every form tag is
  derived from the mirror (`formFieldVisibility`, `RequirementsFields`).
- No other public projection (no Open Graph / link-preview route) carries
  rent, pets or deposit; `mergeFields.ts` publishes only `[Rent]` (out of scope).
- Inbox rows come from conversations, not message rows: a message-less thread
  falls back to `last_message_preview` (`inbox.ts:678-681`), so the S6 /join
  landlord case (a new thread with no message) is listable.
- The real `createOrGetByParticipantPhone` adopts a CLOSED thread through the
  phone claim (`conversationsRepo.ts:1277-1333`) and the real
  `touchLastActivity` sets `status = 'open'` with no monotonic guard
  (`:1626-1683`), so D6.3's touch-first ordering works in production.
- Automated sends skip the JIT consent gate (`sendMessage.ts:537-547`) and a
  new 1:1 thread is `ai_mode: 'auto'` (`conversationsRepo.ts:1291-1299`), so
  the S6 D5 mutation really does text the existing landlord: "2 failed" is
  the right RED prediction.
- Harness facts S4 depends on hold: `touches` records `{ conversationId,
  previewText, ts }` (`twilioWebhookHarness.ts:673`), `emitted` is
  `{ event, payload }` (`:617`), the fake touch returns the conversation BY
  REFERENCE (so the "count incrementUnread RETURNS" case with 7 is the one that
  catches an event built from the touched image), the activity fake's array is
  `activityEvents` (`:3559`), `HarnessOptions` takes `env` and `world`
  (`:5471-5472`).
- `queryAll` uses the lib-dynamodb `QueryCommand` (`dynamoPaging.ts:15`), so
  the S4 one-row-per-page interceptor's `instanceof` check fires.
- No existing conformance case writes a tokenless `putShareMemory` after a
  decline (`twilioWebhookHarnessRepoAdditions.integration.test.ts:1015-1076`),
  so O1 stamping the token breaks no existing case.

## Findings

### F1. [LOW] The 24-hour repeat read is an eventually consistent Query

What is wrong: plan 2.5 / Task 4.1 Step 3a builds `hasEventSince` as a base-
table Query with no `ConsistentRead`. DynamoDB Query defaults to eventually
consistent. Invariant C (plan 3.1, BINDING) is "one pin and one bump per
contact per source per 24 hours".

Evidence: Task 4.1 3a code block (QueryCommandInput has TableName,
KeyConditionExpression, FilterExpression, names, values - no ConsistentRead);
`activityEventsRepo.ts:165-179` (the sibling `listByContact` is eventual too).
The harness fake is an array scan, i.e. strongly consistent, so no app test
can observe the gap.

Implication: two sign-ups for the same source inside the replication lag both
read "no pin" and both pin and bump. Mitigated in practice:
`IntakeForm.tsx:289` disables the submit while pending, so a double tap is
already fenced; two separate submits a fraction of a second apart remain.

Smallest fix: add `ConsistentRead: true` to the query input (supported on a
base-table Query, no GSI involved) and have the paging test's interceptor
assert `command.input.ConsistentRead === true`.

### F2. [LOW] No test anywhere exercises an existing contact whose thread is CLOSED

What is wrong: spec D6.3's stated reason for touch-before-increment is "a
failure can never leave a closed thread flagged unread but invisible". The
harness fake `createOrGetByParticipantPhone` reuses only an OPEN thread and
otherwise creates a new one (`twilioWebhookHarness.ts:652-669`), while the real
repo adopts the closed thread (verified above). S4's section E names the
divergence and stops there; S6's e2e never closes a thread first.

Implication: the closed-thread reopen path ships verified by code reading
only. The call-ORDER assertion in Task 4.3 (invocationCallOrder, and
`world.touches` recording only `touchLastActivity`) does catch a reorder or a
switch to `touchLastActivityPreservingStatus`, so the residual is the real
repo's adoption path, which is existing code.

Smallest fix: none required for this branch; if wanted, one e2e step in
Task 6.2 test 2 that closes the tenant's thread through the existing close
route before the sign-up and then asserts the inbox row is back and unread.

### F3. [LOW] S4 is the only app slice whose test code was neither run nor typechecked

What is wrong: S4's header says its test code "has NOT been executed"; unlike
S3 (scratch `tsc` with every edit applied, plan section 7 B) and S1/S5
(scratch RED/GREEN runs), S4 also claims no typecheck. S4 is the largest and
most intricate test surface (the new `publicSignupLeads.test.ts`, the
handler rewrite).

Evidence: plan section 8 preamble ("written against this worktree at
7ac1f2e3 ... has NOT been executed").

Implication: its RED/GREEN predictions are unproven. I read the S4 tests
against the fakes and the handler and found them consistent (see the
verified list above: touch shape, event shape, by-reference touch, deleted
path return, narrowing of `unitId` in the 4.4 else-if chain, `ContactItem`
literals, `CreateTourInput` shape). A wrong prediction costs build time, not
a shipped defect, because every task still runs RED before GREEN.

Smallest fix: none to the plan text; the builder should treat any S4 RED that
fails for a reason other than the stated one as a stop-and-report, as
section 0 already says.

### F4. [LOW] The deleted-contact issue's evidence goes stale and the plan leaves it

What is wrong: D4's deleted path no longer resolves a conversation or attempts
the welcome. `docs/issues/deleted-contact-web-signup-silent.md` point 3 and
its "Net" paragraph describe today's behavior - the welcome refused as
`contact_deleted` and "the only trace is the audit entry and a warn log".
After this branch that WARN line never fires; the trace becomes the audit row
plus the INFO `housing-fair signup captured` line with `deletedContact: true`
(Task 4.5 3b). The spec says the audit row is what the issue relies on, but no
task touches the issue body.

Implication: whoever picks the issue up reads evidence that no longer matches
the code and may search logs for a line that is no longer written.

Smallest fix: one sentence in Task 6.4 (or a 6.4b) appended to the issue:
"flyer-leads (2026-10-21): the deleted path no longer attempts the welcome;
the trace is the housing_fair_signup audit row on the deleted contact
(deletedContact: true) and the INFO captured line." ASCII, no status change.

### F5. [LOW] AR5 is PENDING inside a binding plan

What is wrong: AR5 defers the untrimmed `'string'` unit fields to Cameron at
the launch gate, with "until he answers, it is out of scope". If the answer
is "fix here", the plan has no task, no test list and no spec text for it.

Implication: a mid-build "fix here" leaves the builder without a contract.

Smallest fix: resolve AR5 before launch, or add the default explicitly as the
filed issue (`docs/issues/unit-plain-string-fields-untrimmed.md`) as a Task
6.4 sub-step, so the plan has a complete path for both answers.

### F6. [LOW] Slice reports are referenced but never given a tracked path

What is wrong: S1 exit check 5 ("Record this in the S1 slice report"), S2 exit
check 3 and S5 exit check 3 ("Name ... in the slice report") require a slice
report, but no task says where it is written or that it is committed. Only
S6's two records have paths (Task 6.2 Step 3b, Task 6.5 Step 10).

Evidence: AGENTS.md "Mission reasoning is version-controlled" and
FEATURE-DEVELOPMENT-WORKFLOW.md:270 put per-slice reports in
`docs/superpowers/reviews/<date>-<branch>/`, committed as produced.

Implication: a builder that follows the plan literally can leave the reports
under the gitignored `.superpowers/`, the loss AGENTS.md documents.

Smallest fix: one line in section 0: "Each slice exit writes
`docs/superpowers/reviews/2026-10-21-flyer-leads/S<n>-report.md` and commits it
with an explicit path."

### F7. [LOW] The full app suite never runs before the final gate

What is wrong: every slice exit check runs only that slice's named files plus
`npm run typecheck`. `npm test` first runs at Task 6.5. S3 changes the shared
harness fake (decline token) and the shared `listingSendSeed.ts`; S4 changes
the shared harness `public:` wiring. Any other test file that reads those
(there are many importers of `listingSendSeed.ts`) is first exercised at the
end.

Implication: a regression introduced in S3 or S4 surfaces only after S5 and
S6, when attribution is hardest. I found no such regression by grep (only
five test files read `shares_op`, all named by S3), so this is a timing
risk, not a known break.

Smallest fix: add `cd app && npx vitest run` (with DynamoDB Local up) to the
S3 and S4 exit checks.

### F8. [LOW] AR2 widens a spec-enumerated audit field without a spec record

What is wrong: spec D6 enumerates `sentSkipped` as not_flyer, not_shareable,
not_tenant, declined, lost, error. AR2 adds `refused`. The addition is honest
(the order rule really can keep a newer flyer entry) and Task 4.5 tests it,
but the spec - the approved contract - still lists six values.

Implication: a later reader of the audit who trusts the spec's enum meets an
undocumented value. The one existing reader
(`backfill-join-housing-authority.ts:226-229`) reads only `signupVersion`, so
nothing breaks today.

Smallest fix: record AR2 in the design-review adjudications file (or a spec
rev-6 erratum line) so the contract and the code agree.

### F9. [LOW] Stale build-order text survives inside three slices

What is wrong: S1's preamble (section 5, "Build it first (plan section 3: S1
-> S3 -> S4 -> S2 -> S5 -> S6)"), S6's preamble (section 10, same order) and
S2's exit check 6 ("six S2 commits on top of the S1 (and, by build order,
S3/S4) commits") contradict AR4 (S1 -> S2 -> S3 -> ...). AR4 says it
supersedes this text, so a careful builder is fine; S2 exit check 6's
expected commit stack is simply wrong under AR4.

Smallest fix: edit the three sentences to AR4's order, or prefix each with
"(superseded by AR4)".

## Spec coverage walk (for the record)

| Spec item | Task(s) |
|---|---|
| D1 projection, PublicFlyer, comment rewrite, old-bundle note | 1.1, 2.3 |
| D2 tag tables, mirror, TaggedField gate, form props, landlord form | 1.1, 2.1, 2.2 |
| D3 heading/link/suffix/fallbacks, area line, highlight, facts, authority line, rows, helpers, CTA copy, unchanged items, 320px | 2.3-2.6, 6.2 |
| D4 findByPhone, live/deleted/none, never changed, deleted path | 4.2, 4.5 |
| D5 welcome only when created; flag still set | 4.2 |
| D6.1 repeat check (source, window, fail-open, read shape) | 4.1, 4.3 |
| D6.2 pin labels, refs, trimmed name | 4.3, 5.1 |
| D6.3 touch -> increment -> one event, failures, typed thread, events dep | 4.2, 4.3 |
| D6.4 best-effort, logged, `{ ok: true }` | 4.3, 4.4, 4.5 |
| D6 new contacts get pin + unread after the welcome | 4.3 |
| D6 audit fields | 4.5 |
| D7 flyer entry, decline refusal, O1, residuals, types | 3.1-3.3, 4.4 |
| D8 signed_up order, one helper, never waiting, renderers, blast default | 3.1, 3.4, 5.2, 5.3 |
| D9 subzone normalization | 1.2 |
| D10 whitespace reports | S1 A.2, S2 A.2, S4 E (AR5) |
| Section 4 docs (GLOSSARY, selectors.md) | 6.3, 6.4 |
| Section 5 e2e | 6.1, 6.2 |
