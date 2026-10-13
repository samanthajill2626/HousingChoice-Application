# FWF re-review - fresh, cold (fix/caseworker-integrity, final fix wave)

Reviewer: fresh re-reviewer of the final fix wave FWF-1..FWF-5 (Claude Opus
5.5), 2026-10-13. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, reviewed at 1358fb42 (fix diff
`.superpowers/review/fwf-fix.diff`, base 437686d6). Inputs read: the rulings
A2-A7 in `final-review/adjudications.md` (as it stood at about 01:16),
`final-review/adversarial.md`, `final-review/FWF-report.md`, and spec revision
6 section 4 "Restore" and "Contact list (I4)". The plan and the other review
records were not opened. Code is cited by file:line at 1358fb42.

Independence note. At about 01:30, checking `git status` for my clean-up
baseline, I found three review records modified by someone else
(`final-review/adjudications.md`, `adversarial.md`, `conformance.md`: the
parallel round 2) and ran `git diff --stat` plus the first 20 lines of the
adjudications diff to make sure the changes were not mine. Those lines showed
the planner's round-2 rows R2-1 (the still-deleted dialog loop, ruled ACCEPT -
FIX) and R2-4 (addContact's lost-write re-read, ruled ACCEPT - FIX). I had
already found F1 and F4 below and drafted F1's throwaway test (01:20-01:29),
and I read no further into those records. The severities below are my own,
and F1's reasoning is given in full.

Method. Read-only until `.superpowers/sdd/logs/p8-e2e.exit` existed (it did
at 01:43, exit=0, "346 passed (24.9m)"). Then one vitest file at a time, with
no `AWS_*` variable in the environment. DynamoDB Local was used by the two
integration suites but not started, stopped or touched otherwise. There were
4 throwaway files `zz-review-fwf-*` and 8 one-line mutants, applied only with
the Edit tool. Every mutated file's sha256 was checked against its pre-mutant
hash after each revert:

    units.ts            90e08e0b...a8d8
    unitsRepo.ts        37c64d9f...0df
    twilioWebhookHarness.ts  4b10fbdc...7827
    ListingDetail.tsx   33c6d0fb...1da001
    ContactDetail.tsx   9d0dbc0e...0133a

All five hashes matched at the end. The throwaways were deleted by exact
name. `git status` showed nothing of mine except this file.

Counts: 0 BLOCKING, 0 HIGH, 1 MEDIUM (F1, a regression introduced by
FWF-1), 1 LOW, 6 INFO. FWF-1..FWF-5 are all REAL by mutant.

---

## (A) Findings

### F1 [MEDIUM, regression of FWF-1, CONFIRMED] Still-deleted restore dialog: every action answers the same 409 and asks to "try that change again"

Location:
- `app/src/routes/units.ts:1775-1786`: the late-body refusal.
- `dashboard/src/routes/listing/RestoreLandlordDialog.tsx:82-85`: the retry
  sentence plus `onConflict`.
- `dashboard/src/routes/listing/ListingDetail.tsx:1438-1452`: keeps the
  dialog while the re-read is still deleted.
- `RestoreLandlordDialog.tsx:122`: the first sentence.
- `dashboard/src/routes/listing/rosterCopy.ts:7`: the retry copy.

What happens. FWF-1 makes a body that arrives when the plain restore would
apply answer 409 `unit_roster_conflict`. That is the same code the dialog
already reads as "the list or landlord changed, try again". The dialog shows
"The property contacts changed - try that change again." and re-reads. When
the re-read is live, it closes (spec revision 6). When the property is STILL
deleted but the plain restore now applies (its stored landlord is typed
`landlord` again), the dialog stays open. Its first sentence ("<name> is no
longer a landlord ...") is now false. Both restore actions answer the same 409
on every retry. The only way out is Cancel followed by the banner's Restore.

Reachable scenario (one staff member, invited by the dialog's own sentence):
1. Staff A presses Restore on deleted property P. The dialog says "Lee Lord is
   no longer a landlord ...".
2. A (or a colleague) opens Lee's contact page and marks Lee a landlord again.
   Nothing refuses this unless Lee is the tenant of an open tour or placement.
3. A returns to the still-open dialog and picks a landlord, or presses
   "Restore without a landlord".

The result is 409 with "try that change again". Every retry gives the same
409. It is the same in the two-staff race of the adversarial finding 2(b),
where B re-types Lee while A's dialog is open. An API PATCH of the deleted
unit's `landlordId` to a landlord also reaches this state: the units PATCH
accepts it on a deleted unit (`units.ts:1615-1669`).

Before FWF-1, the same click answered 200 with the plain restore. That was
wrong in its own way (the choice was silently dropped, A2), but it was not a
dead end.

Why MEDIUM:
- It is a regression this wave introduced.
- It breaks Cameron's ruled product rule "restore never dead-ends" (spec
  revision 3) at the level of the dialog.
- The copy tells the user to retry an action that can never succeed.
- This repo rated A2, an explicit restore choice frustrated with a misleading
  outcome, MEDIUM. This is the same class.

It is not higher because nothing is written, the property's real state is
recoverable with Cancel then Restore, and the trigger needs a re-type (or an
API landlord change) while the dialog is open. My working rating had been LOW
(rare, recoverable). I raised it on the regression and copy grounds above.

The FWF report records this behavior as kept by its brief. The record is in
`docs/issues/contact-type-refusal-copy-edge-cases.md:53-68`, with no
direction.

Evidence:
- Server side: `app/test/unitsRestoreLandlord.test.ts:241`, the state "its
  stored landlord is typed landlord again" answers 409.
- Throwaway `zz-review-fwf-restore.test.ts`, case 2: the same holds when the
  stored landlord is typed landlord but soft-deleted, for `c-new`, `null` and
  the stored id itself. Nothing is written. A later no-body restore then
  answers 200.
- Dashboard side: throwaway `zz-review-fwf-dialog.test.tsx`, case 1, GREEN at
  HEAD (it demonstrates the defect):
  - Plain restore, then 409 `restore_needs_landlord`, then the dialog opens.
  - "Restore without a landlord" gives 409, the retry sentence and a re-read
    that is still deleted. The dialog stays.
  - Trying again gives the same 409.
  - Picking Nora and "Restore with this landlord" gives the same 409.
  - `restoreUnit` is called 4 times. The dialog is still open, still saying
    "James Porter is no longer a landlord".
  - Cancel, then the banner's Restore, gives 200.

Recommended fix: give the late-body case its own 409 code, distinct from
`unit_roster_conflict`, which keeps meaning "the list or landlord changed
under the write, retry". Nothing is written, as today. On that code the
dialog closes and the page re-reads. When the property is still deleted, the
page says in one sentence that its landlord changed while staff were
choosing, and that Restore must be pressed again. Do not re-run the plain
restore automatically, because that would override the explicit choice A2
was about. This matches the direction of the planner's round-2 row R2-1 that
I saw.

Regression tests:
- App: each plain-path state with each body answers the new code, writes
  nothing and adds no audit row. These are the existing six late-body cases
  with the code changed, plus the soft-deleted stored landlord.
- Dashboard: my case 1, flipped. On the first such answer with a
  still-deleted re-read, the dialog closes, the page shows the sentence and
  `restoreUnit` is not called again.
- The existing "keeps the dialog while it is still deleted" case
  (`ListingDetail.test.tsx:1249`, a `unit_roster_conflict` from a real list
  change) must stay green.

### F2 [LOW, CONFIRMED] FWF-4's client close never fires for a generic re-type; the comment and the filed issue overstate its reach

Location:
- `dashboard/src/routes/contact/ContactDetail.tsx:280-289`. The comment says
  "a conversion or re-type by someone else, received through useContact's
  suggestion.updated re-read".
- `dashboard/src/routes/contact/useContact.ts:55-71`: the page's only outside
  refresh.
- `app/src/routes/contacts.ts:1755-1762`: a PATCH snapshots pending
  suggestions only for the fields it changes, and never for `type`.
- `contacts.ts:1840-1853`: the only emit, after a drain of a pending TYPE
  suggestion.
- `docs/issues/ha-review-close-name-patch-unfenced.md:36-39`: "The window
  that remains is a page that has not received the change - ... a dropped
  event stream ...".

What happens. A conversion supersedes the pending housing-authority
suggestion and emits `suggestion.updated`
(`app/src/services/caseworkerConversion.ts:358-372`). The page re-reads and
FWF-4 closes the review, as tested.

A generic contacts PATCH that re-types the tenant (for example to landlord) is
different:
- It leaves the housing-authority suggestion pending.
- It emits nothing unless a TYPE suggestion happened to be pending.
- So the page never learns of the re-type, the review stays open, and its
  close-name pick still sends the plain PATCH.
- The same stale page also re-opens the review from the chip, because
  `onAcceptSuggestion` gates on the page's stale local type
  (`ContactDetail.tsx:852-859`).

So the remaining window is every generic re-type that a page loaded before.
It is not only a dropped stream. The outcome is the deferred A5 residual,
wrong data rather than a misroute, which is why this is LOW.

Evidence: throwaway `zz-review-fwf-retype.test.ts`, 2/2 GREEN at HEAD.
- Case 1:
  - A tenant has a pending `housingAuthority` suggestion.
  - PATCH `{ type: 'landlord' }` answers 200, with zero `suggestion.updated`
    in `world.emitted`, and the suggestion is still pending.
  - PATCH `{ housingAuthority: 'Atlanta Housing Authority' }` (the close-name
    path) answers 200 and is stored on the landlord.
- Case 2: the conversion emits exactly one `suggestion.updated`.

Recommended fix:
- Do not reopen the code. The deferred server fence is the real fix.
- Amend the issue's "window that remains" to say that a generic re-type emits
  no event the page hears, so the client close covers a conversion (and a
  re-type that drains a pending type suggestion) only.
- Correct the code comment in the same way.

Regression test: my case 1 as a PIN on the issue. When the server fence lands
it flips to a refusal of the close-name PATCH.

### F3 [INFO, CONFIRMED] FWF-2 in the adversarial's own A3 scenario: the refused row vanishes together with its sentence

Location: `dashboard/src/routes/listing/ListingDetail.tsx:455-459` (the typed
branch now settles) and `:954` (a row's sentence is keyed to that row).

Staff A re-roles caseworker C's existing seat while staff B removes it. The
roster write refuses `contact_list_caseworker`. The settle re-reads, C's row
disappears, and the sentence goes with it. A sees the row vanish with no
reason given. The card is now true, which was the ruling's aim. The 409
catch-all path behaves the same way, and has since before this branch.

Evidence: throwaway `zz-review-fwf-dialog.test.tsx`, case 2, GREEN. After the
re-read Dana's row is gone, no sentence remains and there are 0 alerts.

Direction (optional, no reopen): when a settle drops the row a sentence was
keyed to, show the sentence at card level.

### F4 [INFO, PLAUSIBLE] FWF-5 covers the per-attempt read only; addContact's lost-write re-read and removeContact's reads stay eventually consistent

Location: `app/src/repos/unitsRepo.ts:1018`. After a lost conditional write,
`addContact` re-reads without `consistentRead` and can throw
`LandlordReassignmentRequiredError` from it (`:1024-1030`). `removeContact`'s
per-attempt read (`:1057`) and its re-read (`:1108`) are the same; they come
from before this branch.

A spurious 409 `landlord_reassignment_required` needs a replica older than
the request's own consistent first read: a landlord cleared within replica
lag before the add, and a lost write in between. It self-corrects on retry,
and the dashboard settles the card.

Status: PLAUSIBLE, not reproduced. DynamoDB Local is strongly consistent, so
replica lag cannot be staged. The FWF report notes it ("Noticed, not fixed"
1), and the round-2 row R2-4 I saw rules a fix. Regression test for that fix:
FWF-5's racing-client pattern asserting EVERY recorded unit read is `true`
(`unitsRepoContactListRules.integration.test.ts:206` checks only the first and
the last).

### F5 [INFO, CONFIRMED state + code read] A soft-deleted landlord-typed contact added as Landlord still receives automatic routing through the landlord-of-record fallback

Location: `app/src/repos/unitsRepo.ts:938` (the claim asks the type only, as
ruled) and `app/src/lib/rosterResolution.ts:294` (no primary row means fall
back to `landlordId`).

FWF-3 keeps such a contact non-primary. But a Landlord-role add claims
`landlordId`, and with no primary row the resolvers route to the landlord of
record, which is the deleted contact. The exclusion therefore only bites for
non-landlord roles.

This follows the spec as ruled (revision 6: "The I3 claim check still asks
only whether the contact is typed landlord"). It is noted for Cameron, not a
wave defect.

Evidence: `app/test/unitsApiRosterAutoPrimary.test.ts:156` ('landlord')
asserts `landlordId` is claimed and there is no primary, green at HEAD. The
fallback is from a code read.

### F6 [INFO, CONFIRMED] A plain (no-body) restore of a LIVE property still answers 200 and appends a second `unit_restored` row

Location: `app/src/routes/units.ts:1787-1800`. This predates the branch, and
the A2 ruling covered only a body. It is reachable from a stale banner, when
another staff member restored the property first. The audit names the second
actor for a restore that changed nothing.

Evidence: throwaway `zz-review-fwf-restore.test.ts`, case 5.

Direction (optional): skip the audit when the stored unit was not deleted.

### F7 [INFO, read] The dashboard's `addUnitContact` doc still states revision 5's rule

Location: `dashboard/src/api/endpoints.ts:1068-1073`. It reads "a NEW seat
for a contact typed landlord ... becomes its primary contact", with no
mention of the soft-deleted exclusion. FWF-1 updated `restoreUnit`'s doc but
not this one. Fix: one clause.

### F8 [INFO, CONFIRMED] A review closed by FWF-4 while its own "Yes, add it" is in flight still sends an accept when the add resolves

Location: `dashboard/src/routes/orgs/NewOrgDialog.tsx:154-160`. `add()` calls
`onAdded` after its await, with no unmount guard. The dialog's `onAdded`
(`ContactDetail.tsx:1290`) leads to `acceptHousingAuthorityAs`.

The plain PATCH never follows. The accept that does follow is fenced by the
server: an accept onto a non-tenant is refused (I1). The org-list entry is
added, which is what staff asked for. So nothing is written to the contact.

Evidence: throwaway `zz-review-fwf-ha.test.tsx`, case 2, GREEN:
`acceptSuggestion` was called once, with `'Wren Housing Authority'`, after
the close, and `updateContact` was never called.

---

## (B) Verdicts by mutant

Each mutant is a one-line Edit, run against one test file, then reverted and
checked by sha256.

| Fix | Verdict | Mutant (one line) | Result | Revert |
|---|---|---|---|---|
| FWF-1 (A2) late body 409 | REAL (introduces F1) | M1 `units.ts:1779` `if (choosesLandlord)` -> `if (choosesLandlord && false)` | `unitsRestoreLandlord.test.ts` 6 failed / 26 passed: exactly the six late-body cases (`:241`) | sha256 OK |
| FWF-2 (A3) typed refusal settles | REAL | M2 `ListingDetail.tsx:458` `await settle();` commented out (typed branch) | `ListingDetail.test.tsx` 3 failed / 83 passed: both add-row cases (`:1888`) and the row case (`:1923`) | sha256 OK |
| FWF-3 (A4) one auto-routing rule | REAL | M3a `units.ts:1250` fact from `contact.type === 'landlord'` | `unitsApiRosterAutoPrimary.test.ts` 2 failed / 17: (i) pm, landlord (`:156`) | sha256 OK |
| | | M3b `units.ts:150` predicate's `!isContactDeleted(contact)` -> `true` | add: the same 2 / 19 red. Restore: `unitsRestoreLandlord.test.ts` 2 / 32 red (`:491`, `:506`). One rule, both consumers | sha256 OK |
| | | M3c `unitsRepo.ts:962` real repo `facts.autoPrimaryEligible` -> `facts.landlordTyped` | `unitsRepoAutoPrimary.integration.test.ts` (DynamoDB Local) 2 failed / 13: (i) (`:175`) | sha256 OK |
| | | M3d `twilioWebhookHarness.ts:2981` fake, same swap | `unitsApiRosterAutoPrimary.test.ts` 2 failed / 17 | sha256 OK |
| | | M3e `unitsRepo.ts:938` I3 claim asks `facts.autoPrimaryEligible` | integration (i) landlord red, 1 / 15. The "claim asks only the type" property is pinned | sha256 OK |
| FWF-4 (A5 client) review closes on a type change | REAL (reach: F2) | M4 `ContactDetail.tsx:289` reset removed | `ContactDetail.test.tsx` 1 failed / 127 (`:2735`) | sha256 OK |
| FWF-5 (A7 read) consistent per-attempt read | REAL (scope: F4) | M5 `unitsRepo.ts:907` `{ consistentRead: true }` dropped | `unitsRepoContactListRules.integration.test.ts` (DynamoDB Local) 2 failed / 3: `:193`, `:206` | sha256 OK |

Every non-target case in each mutated run stayed green, so each run doubles as
a baseline for that file at HEAD. The planner's p8 `npm test` and e2e were
also exit 0 at 1358fb42.

---

## (C) Swept and clean

- **Restore route inputs (FWF-1).**
  - A string, `null`, `''`, non-string (`0`, `false`, an array value) or
    array-body request: the 400 for a malformed `landlordId` comes before any
    read, even on a live unit.
  - An array body is treated as no body.
  - An unknown unit answers 404 before the 409.
  - In every plain-path state (live; deleted with a typed landlord,
    soft-deleted included; deleted ownerless), nothing is read beyond the
    unit and its landlord contact, and nothing is written or audited before
    the 409. The log line only carries ids.
  - Deleted with a non-landlord: the body is honored as before.
  - Evidence: the fixer's six cases plus throwaway `zz-review-fwf-restore`
    1-4, 5/5 green.
- **Dashboard per state (FWF-1).**
  - Live re-read: the dialog closes and the page shows the re-read property
    and its landlord (`ListingDetail.test.tsx:1457`).
  - Still deleted: see F1.
  - Deleted ownerless with the dialog open: unreachable from the dashboard.
    The PATCH rejects a non-string `landlordId` (`unitFields.ts:47`, `:166`),
    and only a restore removes it.
- **Consumers of the restore answer.**
  - Only `RestoreLandlordDialog.tsx:74` sends a body. `ListingDetail.tsx:371-388`
    sends none.
  - e2e `property-roster.spec.ts:372`, `:437` exercise only the needs-landlord
    path.
  - `e2e/performance` `mutationCatalog.ts:81` / `templates.ts:105` are static
    inventories.
  - No caller in `scripts/`.
- **`ContactListFacts` signature (FWF-3).**
  - One producer (`units.ts:1247-1251`), one real consumer
    (`unitsRepo.ts:937-965`) and one fake (`twilioWebhookHarness.ts:2963-2985`).
  - The `unitsApiRoster.test.ts:233`, `:254` overrides take no arguments.
    The `unitsApiRosterTypeChecks.test.ts:273`, `:301` wrappers pass `facts`
    through.
  - Every fact literal in the tests carries the third field. There is no
    JS/MJS caller in `scripts/` or `e2e/`.
  - The planner's typecheck exit 0 at the head.
  - The route still 404s a pointer before the facts (`units.ts:1196`), and
    the I3 checks still ask the type (`units.ts:1226-1232`; repo `:938`,
    pinned by M3e).
- **Restore promotion unchanged (FWF-3).** `autoRoutingEligible`
  (`units.ts:145-153`) is the removed inline conditions verbatim, in the same
  order. M3b turns both consumers red.
- **FWF-2 settle.**
  - It is a read run while `rosterBusy` is held (`ListingDetail.tsx:430-475`),
    so no second roster write can interleave and there is no double write.
  - The sentence is set before the settle and nothing clears it.
  - Only the two typed 409s can reach a roster write (`contactTypeErrors.ts:26-46`
    against `units.ts:1221-1269`).
  - A stamp onto another property is guarded (`:306` and `useListing.setUnit`).
  - Focus and busy behave as during the write itself, extended by one GET.
  - Pre-existing and shared with the 409 path: the settle's GET is an
    eventually consistent read (`units.ts:604`).
- **FWF-4 render-time reset.**
  - It is guarded, so there is no loop. The StrictMode render was green
    (throwaway `zz-review-fwf-ha` case 1).
  - It also closes a review whose check answer lands after the type change
    (`ContactDetail.tsx:805-814`, then the reset on the next render).
  - The contactId reset (`:295-306`) is unchanged.
  - An in-flight add: see F8.
- **FWF-5.** The `this` binding in the attempt closure is unchanged, and
  `getById` maps the option to `ConsistentRead` (`unitsRepo.ts:756-765`).
- **Issue edits in the wave.** The `import-bypasses-contact-type-rules`,
  `landlord-of-record-no-reassign-ui`, `ai-run-log-refused-accept-replay-200`,
  `auto-routing-changes-not-named` and
  `contact-list-rule-duplication-and-fake-drift` text matches the code at the
  lines I spot-checked. Exception: `ha-review-close-name-patch-unfenced`, see
  F2.
