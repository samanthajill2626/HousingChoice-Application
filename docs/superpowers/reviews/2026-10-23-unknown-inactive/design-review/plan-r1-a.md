# Plan review round 1 (reviewer A) - unknown-inactive plan v1

Reviewed: `docs/superpowers/plans/2026-10-23-unknown-inactive-plan.md` (all
9667 lines) against `docs/superpowers/specs/2026-10-23-unknown-inactive-design.md`
(rev 3) and the tree at main @916258ae (worktree `W:/tmp/unknown-inactive`).

Method: every spec decision D1-D10 and test 1-8 walked to its task; every
quoted "old" / "Current text" / "Anchor" block (175 blocks) mechanically
matched against the tracked files (all match main except the ones that
anchor on text an earlier task produces, and the collisions named below);
the mutation and reader surfaces of contact `status` grepped across `app/`,
`dashboard/`, `e2e/`; the test helpers each new test uses checked for
existence and signature. Read-only; nothing run.

Coverage verdict: every spec decision and every spec test has a delivering
task. The findings below are where a literal builder would produce something
other than the spec, or would be told two contradictory things.

---

## F1. [MEDIUM] The edit form's type-change rule breaks through the KindPicker "Other" step: a change-and-back still writes a status

What is wrong. S4.4 step 3e rewrites `handleKindChange` to move the Status
field only when `next.type !== liveType`, and step 3d keeps
`liveType = kind.type ?? contact.type`. While the KindPicker's Other panel is
open with no base picked, `kind.type` is `null`, so `liveType` silently
falls back to the STORED type - not the type the Status field currently
reflects. Any path "stored type -> another type -> Other -> stored base type"
therefore leaves the field on the OTHER type's first step, and the save
treats it as a no-type-change status change.

Evidence.
- Plan 7193-7203 (3d: `liveType`, `typeChanged`, `initialStatus`), 7230-7236
  (3e: `if (next.type !== null && next.type !== liveType) setStatus(...)`).
- `dashboard/src/routes/contact/KindPicker.tsx:141-150` - clicking Other from
  a plain segment calls `onChange({ type: null, role })`; `:168-170` - a base
  pick calls `onChange({ type: baseType, role })`.
- `dashboard/src/routes/contact/ContactEditForm.tsx:205` - `liveType` fallback.
- Worked case 1: stored tenant Searching -> Landlord (field = interested) ->
  Other (type null, liveType = tenant) -> base Tenant (`tenant === liveType`,
  no reset; field stays `interested`). Save: `typeChanged` false, `isTenant`,
  `statusTransition = 'interested' !== 'searching'` true, and 3h narrows the
  off-list value to `needs_review` -> `setTenantStatus(needs_review)`. A
  Searching tenant is silently moved to Needs review.
- Worked case 2: stored landlord Parked -> Tenant (field = onboarding) ->
  Other -> base Landlord: field stays `onboarding` (a legal landlord value),
  3f sends `status: 'onboarding'` in the PATCH. A Parked landlord silently
  becomes Onboarding.
- Spec D3: "a change-and-back (tenant -> landlord -> tenant) [is] NOT [a]
  type change: the Status field keeps the stored status and the save writes
  no status". The plan's own comment (3e) claims the field "never carries a
  type-invalid status"; case 1 shows it does (the select shows a tenant list
  with a non-tenant value).

What it implies. A D3 violation that writes a wrong status on save, on a
reachable (if uncommon) path, and no planned test covers it: the S4.4
change-and-back test only goes tenant -> Landlord -> Tenant directly. Fix in
the plan: compare against the type the status was last set for (track the
last non-null kind type, or a `statusForType` state), or keep the old
"reset when not valid for next.type" check as a second guard; add a test for
the Other-panel path.

---

## F2. [MEDIUM] The live re-read on `contact.updated` uses an eventually consistent GET and can overwrite the operator's own fresh change

What is wrong. S2.9 routes `contact.updated` into `refetchInPlace`, which
calls `getContact(contactId)` with no `consistent` option and replaces the
whole contact in state. The event is emitted by the very write the operator
just made (S2.3 setTenantStatus; S2.5 PATCH), so the re-read is issued tens
of milliseconds after the write. Against real DynamoDB a default GetItem can
still return the pre-write item; the stale contact then replaces the fresh
one the page already applied from the route's response. S4.3's 409 handler
re-reads the same way (`getContact(contact.contactId)`), after a concurrent
re-type it must see.

Evidence.
- Plan 3895-3908 (S2.9 `refetchInPlace` -> `getContact(contactId)`), plan
  6542-6546 (S4.3 409 re-read), plan 3975-3980 (S2 report treats the echo
  re-read as a harmless extra GET).
- `dashboard/src/api/endpoints.ts:1470-1486` - `getContact(..., { consistent })`
  exists precisely for "a re-read that must see a save that landed a moment
  ago" (planner ruling PR-3); used by `ApplyRequirementsDialog.tsx:166` and
  `UnitCreateForm.tsx:234`.
- `app/src/routes/contacts.ts:1263-1266` - the route reads consistently only
  with `?consistent=1`.

What it implies. In production, intermittently: the header pill the operator
just set to Inactive flips back to Needs review, the D8 card title reverts to
"Needs triage", and after an edit-form save every edited field can revert
(the whole contact is replaced) - with no further event to correct it until
a reload. DynamoDB Local is strongly consistent, so no unit, integration or
e2e test in the plan can catch it. Fix in the plan: pass
`{ consistent: true }` in both re-reads (the codebase's own rule).

---

## F3. [MEDIUM] AR17 is not reflected in the slice text it overrides; S3's text tells the builder to STOP in exactly the state AR17 creates

What is wrong. AR17 (plan 284-294) moves S3.4 Step 5 (the
`inbox.integration.test.ts` flip) into S1.1 "and adds that file to its
RED/GREEN commands and its commit", and turns S3.4 Step 1 into a GREEN
check. None of that is in S1.1 or S3:
- S1.1 Files (437-449), RED command (858), GREEN command (1239) and commit
  paths (1266) all omit `app/test/inbox.integration.test.ts`. A builder
  executing S1.1 literally commits a red tree (the reviewed rows at
  `app/test/inbox.integration.test.ts:485` are seeded `active`, a block that
  no longer exists after S1.1's order change), contrary to AR17's "every
  commit stays green"; S1.6 Step 3 then finds it red and classifies it as
  "this slice's bug".
- S3 Contradictions item 2 (4058-4064): "S3.4 owns those flips. S1 must not
  'fix' them a different way, and no gate may run between S1 and S3.4
  expecting them green" - the opposite of AR17 and of S1.1's own C3.
- S3.4 Step 1 (4495-4517) is still titled RED and says "If none of these
  fail, S1's order change is not in the tree: STOP". Under AR17 none of them
  fail, so the literal instruction is to stop the build.

What it implies. Section 0 says section 4 wins, so a careful builder can
reconcile - but only by hand-splicing AR17 into three places and ignoring an
explicit STOP. The plan must not rely on that: fold AR17 into S1.1's files,
commands and commit, delete S3's Contradictions item 2, and rewrite S3.4
Step 1 as the GREEN check.

---

## F4. [LOW] S3.4 anchors on lines S1.1 already rewrote, while AR17 says some of those steps "run as written"; S3.4 is left with no real RED

What is wrong.
- S3.4 Step 6 Edit C (plan 4851-4862) anchors on
  `` * `active` block's first Query is issued.`` and Edit D (4866-4876) on
  ` * way: anything that hard-codes "needs_review then active" ...`. S1.1
  step 3f (1169-1178, 1196-1197) already replaced both lines. AR17 says
  "Steps 6-9 run as written", so the Edit tool cannot apply C or D. D is
  harmless (same result), but C carries a NEW parenthetical ("the `active`
  block it replaced was removed 2026-10-23 ...") that has no anchor any more.
  Only Edit B carries an "if S1 already made this edit, leave it" clause.
- S3.4 Step 3 Edit F (4673-4711) anchors on the `honest` cursor with
  `status: 'active'`, which S1.1 1f (816-819) already flipped; AR17 says to
  add "every NEW test case those steps add", so the pre-deploy cursor pins
  (the only D9 cursor coverage) must be re-anchored by the builder.
- S3.4 Step 4's class-f rename/comment (4731-4742) is dropped under AR17
  (S1.1 already changed the old text, keeping `c-active`).
- With every flip done in S1.1, S3.4's remaining new cases (the pre-deploy
  cursor) are green on S1's tree, so S3.4 has no real RED - against section
  0's "every task still has at least one real RED case".

What it implies. Builder improvisation in a task the plan presents as
mechanical; give S3.4 anchors on the post-S1.1 text.

---

## F5. [LOW] S2.4 writes the `\u2192` escape in test code, which the plan itself says the Edit/Write tools decode

What is wrong. S1's notation block (plan 332-335) rules that test code NEVER
writes the six-character `\u2192` because Edit/Write decode it into a literal
arrow, and uses `String.fromCharCode(0x2192)` instead. S2.4 (plan 3052)
writes `'Status \u2192 Inactive'` in `app/test/transitionRoutes.test.ts` and
then only greps that it "survived" (3105-3110, S2.10 3943-3946) with no
remediation if it did not.

What it implies. If decoded, the added line is non-ASCII (AGENTS.md ASCII
rule) and S2.10 Step 1's ASCII check fails; the builder has no instruction.
Use the `String.fromCharCode(0x2192)` pattern S1 already uses.

---

## F6. [LOW] Three "prints nothing" post-edit greps can never print nothing

What is wrong. The patterns include `TenantStatus`, which also matches
`setTenantStatus`, a name each file keeps:
- S4.3 (plan 6607-6608): `grep -n "TENANT_STATUS\|LANDLORD_STATUS\|TenantStatus\|LandlordStatus" ContactDetail.tsx`
  - the file keeps `setTenantStatus` (`ContactDetail.tsx:36`, `:930`, `:941`).
- S4.3 (plan 6385-6388): `grep -n "TenantStatus\|LandlordStatus" endpoints.ts`
  - `export async function setTenantStatus(` at `endpoints.ts:477`.
- S4.4 (plan 7369-7370): the pattern includes `TenantStatus`;
  `ContactEditForm.tsx` keeps `setTenantStatus` (import `:17`, calls).

What it implies. A literal builder sees a "failed" check that is a false
alarm (or is tempted to "fix" it). Anchor the patterns with `\b` or exclude
`setTenantStatus`.

---

## F7. [LOW] S1.3 labels a RED case "(PIN)"

What is wrong. Plan 1575-1580, `(PIN) labels an Inactive tenant re-typed to
unknown "Status -> Needs review"`. After S1.1, `inactive` is legal for
`unknown`, so the unchanged normalize fallback (`app/src/routes/contacts.ts:1751`,
runs only when the stored status is illegal for the new type) keeps
`inactive`, writes no status and records no milestone. The case fails before
S1.3 (it is the same behavior as the non-PIN `['tenant', 'unknown',
'needs_review', false]` row at 1481). The RED list (1601) says "The PIN and
(guard) cases pass".

What it implies. An unexpected red that a careful builder may stop on. Drop
the "(PIN)" label and list it among the expected failures.

---

## F8. [LOW] S5.1's RED expectation miscounts the failing cases

Plan 7796-7799: "four InboxRow cases fail ... (the first, third and fourth
new cases ...)". That is three; the second ("renders NO Inactive tag") and
the fifth (Mark unread) are PINs. Cosmetic, but it is the builder's
pass/fail oracle for the step.

---

## F9. [LOW] D4.4's "same muted status colour" is delivered only where a toned badge already renders; the Contacts list shows Inactive two different ways

What is wrong. AR21 and S4 clarification 5 (plan 306-308, 5635-5641) keep
non-tenant Contacts-list rows as plain text. On the same list an Inactive
tenant renders a muted `StatusBadge` (`ContactsList.tsx:166-167`) while an
Inactive caseworker or unknown contact renders plain text (`:168-169`).
Spec Goal 4 / D4.4 ("The same muted status colour") is not limited to the
contact page. The plan records this as a planner decision and asks the S4
report to name it, but does not route it to the human before the build.

What it implies. Possibly acceptable, but it is a narrowing of an approved
spec decision made in the plan; it should be confirmed with Cameron rather
than discovered in a slice report.

---

## F10. [LOW] W4's inbound-writer enumeration omits the email inbound paths

What is wrong. Spec D9 states "no inbound writer moves an existing contact
back to Needs review". Plan W4 (156-159) and S3.5 (5321-5337) enumerate
`contactCapture.ts`, `groupMembers.ts`, `groupConvert.ts`, `routes/public.ts`
and the Twilio text/voice webhooks, but not `app/src/services/inboundEmail.ts`
or `app/src/routes/unmatchedEmail.ts` (email to an existing contact).

Evidence / consequence. Read-only check: neither file calls a contact
`update`/`createIfAbsent` that touches `status` (grep of both files finds no
contact update), so nothing breaks today. Name them in the W4 record so the
watch item is complete.

---

## Checked and found sound (no finding)

- All 175 quoted anchors match main except those that anchor on text an
  earlier task creates (S1.3 3a import, S4.5 1b) and the collisions in F4;
  CSS anchors in `InboxRow.module.css:103-105, 170-176` match.
- Test helpers and fixtures used by new tests exist with the assumed shapes
  (harness `world.auditEvents` / `activityEvents`, `makeServiceWithActivity`,
  `seedUnknownContactAndThread`, `seedSuggestion`/`accept`/`journalsFor`,
  `seedD7`-style pushes, `founderHarness`/`bizVoiceParams`/`CALLER`,
  `postInboundSms`, `expectTodayReady`, `reseed`, the useInbox `Probe`
  testids, `EventStreamHandlers` export).
- The harness fake honors `expect` clauses on `type`
  (`app/test/helpers/twilioWebhookHarness.ts:2439-2453`) and the real repo
  already guards `type` (`contactsRepo.ts:717-741`, landlord requirements).
- The transition router receives the harness event bus (`app/src/routes/api.ts:1225-1235`),
  so S2.4's `world.events` listener is reachable.
- `statusModel.ts` has no imports (mirror test precondition holds).
- No other app, dashboard or e2e code seeds or asserts `(unknown, active)`
  beyond the files the plan names; `NON_TENANT_STATUSES` consumers are all
  migrated by S1.1.
- Performance seed arithmetic (300 contacts -> 285/12/3, ordinal 1 =
  `perf-contact-00298`) matches `performance.ts:197-201`.
