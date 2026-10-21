# Plan review R2 - reviewer B (adversarial, round 2)

Plan: `docs/superpowers/plans/2026-10-21-flyer-leads-plan.md` v2 (commit 444e0f86).
Inputs read: the v1 -> v2 diff (`.superpowers/sdd/plan-v1-to-v2.diff`), the
round-1 adjudications, reviewer A's R1 report, spec section 7.
Read-only: nothing was run in the worktree. Every claim cites a file:line read
on this tree.

## Summary

No BLOCKING, HIGH or MEDIUM finding. The round-2 changes are sound in
substance. I verified the parts that carry real risk:

- **AR13 / Task 3.5.**
  - The recipient projection really carries `phone`
    (`app/src/repos/contactsRepo.ts:1093-1096` RECIPIENT_PROJECTION includes
    `#phone`), and so does the harness fake (`twilioWebhookHarness.ts:2295-2301`).
  - `formatPhoneForDisplay` passes non-NANP values through
    (`app/src/lib/phone.ts:73-77`).
  - `seedTenant` returns its item (`listingSendsApi.test.ts:30-39`), so the
    `const tx = seedTenant(...)` edits work.
  - Both re-pinned anchors are unique (`grep -c` = 1).
  - The outcome route lets an unknown contact take Not interested: the
    `interested_unsupported` gate is for Interested only
    (`app/src/routes/units.ts:1505,1595`).
  - The only dashboard reader of `ListingSendRow.tenantName` is
    `ListingDetail.tsx:1343`.
  - No e2e locator names a row by its contactId.
- **AR16.** Verified: `app/src/app.ts:146` mounts `trimJsonBody()` after both
  parsers and before every route, and `middleware/trimStrings.ts:43-50`
  deep-trims every string value of an `application/json` body.
- **AR12.** The stub-doc test asserts `ConsistentRead` on every page.
- **AR11.** `satisfies SignupSentSkipped` is fine: the union is declared in
  Task 4.4, before Task 4.5 uses it.
- **The S4 closed-thread spy test.** It is coherent: the stubbed adoption
  returns the stored object, the fake touch reopens it, and the call order is
  pinned.
- **The new commit commands.** I checked every single-quoted `-m` in S2 and S5
  for an apostrophe: none. The double-quoted ones in S1, S3, S4 and S6 carry
  no backtick or dollar sign.

What follows: one contested rejection (finding 5), my one concession (my R1
#9), and six LOW items that are new or arise from the v2 edits.

---

## 1. [LOW] The S3 and S4 full-suite exit steps run a 3-8 minute suite in the foreground, without the background and timeout discipline Task 6.5 uses

**What is wrong.** AR15 adds `cd app; npx vitest run` to the S3 and S4 exit
checks.
- S4 exit check step 1 gives NO timeout or background guidance at all. The
  Bash tool's default foreground timeout is 120000 ms.
- S3 exit check step 3 suggests "the tool's 600000 ms" as the hard cap, in the
  foreground. AGENTS.md records app-suite wall times of 190-231 s on a fresh
  container and 446-509 s when loaded ("FIRST, if `npm test` is red...").
- S3's step also drops the exported-AWS-key check that S4's step and AGENTS.md
  require (`env | grep '^AWS_'`, then `env -u AWS_ACCESS_KEY_ID -u
  AWS_SECRET_ACCESS_KEY`).

**Evidence.** Plan S3 exit check step 3 (diff line 896); S4 exit check step 1
(diff line 1427); Task 6.5 Step 6 (background, redirected `npm test`).

**What it implies.**
- A literal S4 exit check is killed at two minutes and reads as a red suite.
- On Windows a killed foreground vitest can leave its workers running against
  the shared DynamoDB Local container, which slows later runs and then reads
  as "contention".

**Smallest fix.** Give both steps Task 6.5's form:
`cd app && timeout 1500 npx vitest run > ../.superpowers/sdd/gates/S<n>-app-suite.log 2>&1`,
run in the background, read the log after the completion notice. Put the AWS
env check in S3's step too.

---

## 2. [LOW] S5 leaves the full dashboard suite "optional" although it edits shared dashboard modules - AR15's own rationale applies

**What is wrong.** AR15 runs the full app suite at the S3/S4 exits "because
both slices edit shared test helpers". S5 edits shared dashboard code:
- the `ListingSendOutcome` and `TimelineMilestoneType` unions in `api/types.ts`;
- `SendRosterRow` in `Card.tsx`, rendered by `TenantFile`, `PartnerFile` and
  `ListingDetail`, with its `waiting` const replaced by `actionable`;
- `groupSendRows`.

Yet S5 exit check step 4 calls the whole dashboard suite "Optional but cheap".
S2's exit check runs it (step 1). After S5, the next full dashboard run is the
gate `npm test` in Task 6.5, after the main sync - where attribution is
hardest.

**Smallest fix.** Make S5 exit step 4 mandatory: `cd dashboard && npx vitest
run`, exit 0.

---

## 3. [LOW] The deleted-contact issue update says the audit row is "the ONLY trace", but the plan's own S4 notes name a second one

**What is wrong.** Task 6.4 Step 1f's inserted paragraph says: "That audit row
is the ONLY trace". S4 section E (plan, "S6 Task 6.4 (R1 #8) rewrites ...")
says the deleted path's trace is the audit AND "the `housing-fair signup
captured` log line carrying the same booleans". Task 4.5 Step 3b writes that
INFO line with `deletedContact: true`. Reviewer A's R1 F4 smallest fix named
it too.

**What it implies.** Whoever picks up the issue is told there is no log signal
and will not search for the INFO line that does exist - the same stale-evidence
problem R1 #8 was meant to fix.

**Smallest fix.** Change the sentence to: "That audit row and the INFO
`housing-fair signup captured` line (`deletedContact: true`, `sentSkipped:
'deleted'`) are the only traces".

---

## 4. [LOW] Spec section 7's AR13 amendment is narrower than what Task 3.5 builds

**What is wrong.**
- Spec section 7 records AR13 as: "an existing `unknown` contact with no name
  ... is labelled on the property's Sent to card by its formatted phone".
- Plan AR13 and Task 3.5 relabel EVERY resolved recipient with no first or
  last name, of any type, whenever it has a phone: a nameless tenant, partner
  or landlord on any Sent to card. `recipientLabelOf` has no type check.
- Task 3.5 Step 1a re-pins two pre-existing nameless-TENANT rows
  (`listingSendsApi.test.ts:169`, `:239`) to the phone label.

**What it implies.** The approved contract and the build disagree on how far
the change reaches. A reviewer holding the spec reads the tenant re-pins as
scope creep.

**Smallest fix.** Reword the spec section 7 bullet to say "a resolved
recipient with no name (for example an auto-captured `unknown` contact a
sign-up put on the card) is labelled ... by its formatted phone".

---

## 5. [LOW] CONTESTED (R1 #12 / my B5): the `consentVersion` comment and spec wording still assert something the code cannot know

**The rejection's reasoning.** The form sends no version, the contact record
already carries the same server constant, and bundle and server ship together.
A tab left open across a disclosure-copy change is a residual the contact
record already carries.

**Why I still hold the narrow point.** The reasoning concedes the residual,
but the plan still writes the false claim into code. Task 4.5 Step 3c's audit
comment (diff line 1398) reads "consentVersion (the disclosure version the
form showed - evidence only ...)". That is not what `CONSENT_VERSION`
(`app/src/lib/smsCompliance.ts:91`) is. D1's own "Old flyer pages" argument
covers a page LOAD; this is a SUBMIT from a page loaded before the deploy.
For an EXISTING contact this audit field is the ONLY consent evidence the
change keeps (D4 records none on the contact), so its comment should not
over-claim. I did NOT ask for a client-sent version; the rejection answers a
fix I did not propose.

**Smallest fix (wording only).** In Task 4.5 Step 3c, write "consentVersion
(CONSENT_VERSION - the disclosure version this deploy serves, which a
same-release form showed)", and the same words in spec D6's field list. No
code change.

---

## 6. [LOW] Slice reports get contradictory rules on pre-existing lint errors

**What is wrong.**
- S2 exit check step 7 requires the S2 report to name the two pre-existing
  `FlyerPage.tsx` lint errors.
- S5 exit check step 6 requires the S5 report to name the pre-existing
  `Timeline.tsx` error.
- S6 Task 6.5 Step 11 says "Gate exit codes and pre-existing lint errors stay
  in `S6-gates.md`, not here (one file, one kind)".
- Plan section 0 defines a slice report as "findings only (what the tree held
  that the plan got wrong, risks, untrimmed paths)". A known pre-existing lint
  error is none of those.

**Smallest fix.** Pick one rule in section 0. Simplest: pre-existing lint
errors are named in each slice report under one "pre-existing, not ours"
line, and S6's Step 11 sentence is dropped. Alternatively, all of them go only
to `S6-gates.md`.

---

## Concessions

- **R1 #9 (AR5 pending): conceded.** Its premise came from the drafters' D10
  report, which I relayed. `app/src/app.ts:146` and
  `app/src/middleware/trimStrings.ts:43-50` show every JSON body is
  deep-trimmed before any route, so there was no untrimmed save path to plan
  for. AR16 is correct, and the withdrawal leaves no dangling reference
  (grep of the plan for `Task 1.3` and `unit-plain-string`: none).
- **Reviewer A's F3 (S4 test code never executed), kept as a watch item: not
  contested.** I re-read the v2 S4 test code against the fakes and types:
  - `ConversationItem` required fields (`conversationsRepo.ts`) match
    `seedThread`;
  - `UnitItem.status` is a plain string, so `'placed'` compiles;
  - `findAllByPhone` exists on the fake (`twilioWebhookHarness.ts:2274`);
  - the closed-thread test's `touch.mock.results[0]?.value` is awaited.

  I found no compile or wrong-RED defect. Every task runs RED first, so the
  watch item suffices.

## Round-1 fixes checked (all correct, not merely plausible)

| R1 | Fix | Verdict |
|---|---|---|
| B1 / AR13 | Task 3.5 `recipientLabelOf`, units-only, wire comments | Correct; scope wording - finding 4 |
| B2 / A6 | section 0 slice-report rule + per-slice commit steps | Correct; one rule conflict - finding 6 |
| B3 / A9 | build-order text and S2 exit check 6 | Correct (S2 check 6 now expects S1's last commit below Task 2.1) |
| B4 / AR11 | `sentSkipped: 'deleted'` + `satisfies` | Correct |
| B6 | section 0 indent rule | Correct |
| B7 | "17 lines (406-422)" | Correct |
| B8 | repeated `-m` / message file outside the worktree | Correct; quoting checked for every message |
| A1 / AR12 | `ConsistentRead: true` + stub-doc test | Correct |
| A2 | closed-thread spy test | Correct for the handler; the real repo's adoption remains existing code |
| A4 | issue update | Correct except finding 3 |
| A7 / AR15 | full app suite at S3/S4 exits | Right intent; execution form - finding 1 |
| A8 | spec section 7 | Correct except finding 4 |
