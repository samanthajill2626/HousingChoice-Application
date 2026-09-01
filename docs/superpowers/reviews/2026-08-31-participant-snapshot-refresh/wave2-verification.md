# Wave-2 verification (2026-09-01)

Branch `feat/participant-snapshot-refresh`, HEAD `335b7448` (the round-2
adjudications commit). Wave 2 is `7b9450e6`; wave 1 is `c895f081`.
Worktree `W:\tmp\participant-snapshot-refresh`, tracked tree clean before and
after (two sabotages staged and reverted; see section 3).

Inputs read: `code-review-round2.md`, `code-review-round2-adjudications.md`,
`wave2-report.md`, `fix-wave-report.md`, `git show c895f081` and
`git show 7b9450e6`, and the repo. The plan and the other review-directory
files were deliberately not read.

Commands run from `W:\tmp\participant-snapshot-refresh` (or `\app`), targeted
only - no suite, no e2e, no session:

```
npx vitest run test/inboxGroups.test.ts test/inboundMessagePush.test.ts test/rosterDriftTally.test.ts
  -> 3 files, 46 passed, exit 0   (baseline, and again after both reverts)
npm run typecheck    -> EXIT=0, 0 "error TS"
npx eslint <the six wave-2 files>  -> ESLINT_EXIT=0
```

`git diff --stat 744142f9..HEAD` is exactly the six wave-2 files plus the three
review documents. Nothing else moved since round 2.

---

## 1. NEW - what neither round 2 nor the adjudications covers

### SHOULD-FIX

**W2-1. The audit's id collection uses a WEAKER guard than the tally it feeds,
so one malformed roster row can kill a 100-key chunk and turn up to 100 healthy
members into `danglingContactId` - in the exact numbers wave 2 exists to make
trustworthy.**

`app/scripts/measure-unread-contact-coverage.ts:604`:

```
for (const roster of rosters) for (const p of roster) if (p.contactId !== '') ids.add(p.contactId);
```

`app/src/lib/rosterDriftTally.ts:49` guards the same field with
`typeof p.contactId !== 'string'`. That defensive `typeof` is not decoration -
it is the module author saying a roster row can reach this code with no
`contactId` attribute at all, the same wire-shape warning `groupTitle.ts:48-55`
carries for `phone`. `undefined !== ''` is TRUE, so such a member is added to
the id set and shipped to `getDisplaysByIds`.

Downstream, with the shipped client config (`app/src/lib/dynamo.ts:87`
`removeUndefinedValues: true`) the key marshals to `{}` and DynamoDB rejects the
BatchGet. `contactsRepo.ts:838-841` catches it (no `requireComplete` here),
drops the WHOLE chunk with one warn, and `unprocessed += keys.length`. In the
audit that reads as: every member in that chunk counted `danglingContactId`,
`NOT RETURNED` up to 100, and the script's own advice
(`:628` "a short batch (throttle?) inflates 'dangling'; re-run before trusting
it") sends the operator chasing a throttle that is not there - deterministically,
on every re-run.

R2-4's whole point was that the audit cannot see the branch's own cost. Wave 2
added the counter one line above this. The fix is to mirror the tally's guard.
Cost: one predicate. Reachability is unproven (it needs one roster row with the
attribute absent) but the tally already assumes such rows exist, and the
`--audit-denorm` lane run is the next step per the adjudications.

**W2-2. R2-1 names TWO surfaces; wave 2 pinned ONE. The contact card's
independent copy of the carve-out is still unpinned, and its existing carve-out
test cannot reach the flip.**

R2-1 (`code-review-round2.md:60-65`): "So the tag vanishes from two surfaces."
The second is `app/src/routes/contacts.ts:1233`
(`others.anyNamed || tag.length === 0 ? others.labels : []`) over hydrated
names (`:1214` `withLiveNames`, batch at `:1208-1212`), feeding the client
mirror `GroupTextsCard.groupLabel`, which computes its own precedence over the
DTO. The adjudication's remedy (a) named only `inboxGroups.test.ts`, and wave 2
delivered exactly that.

The card's existing carve-out test does NOT cover the new behavior:
`app/test/contactRelayGroups.test.ts:205-223` seeds the other member as
`{ contactId: '', phone: LANDLORD_PHONE }` - a bare-phone member hydration
cannot name - so it asserts `otherMemberNames == []` and passes identically
before and after M1. `:290` ("otherMemberNames come from the OTHER members
contacts") seeds no tag. Nothing in the suite pins "tagged + snapshot-nameless +
contact-NAMED -> the card sends names and the tag loses".

So the surface that reaches the operator through a second, hand-copied
precedence chain plus a client mirror can be changed by anyone without a test
going red - which is the condition R2-1 asked to end ("What is not acceptable is
shipping it invisible"). One test, cloned from `:205` with a real `contactId`
and a named contact in `world.contacts`, closes it.

### NOTES

**W2-3. The new carve-out comment names a caller this function does not have,
contradicting the SCOPE GUARD 25 lines above it.**
`app/src/lib/groupTitle.ts:167-168` now says "Hydrated callers (inbox rows,
contact cards) have fed this LIVE contact names since 2026-09-01". The contact
card never calls `relayThreadLabel`: `git grep relayThreadLabel` returns
`routes/inbox.ts:1162` and `routes/webhooks/twilio.ts:743` only. The card calls
`relayMemberLabels` directly (`routes/contacts.ts:1218`) and re-implements the
carve-out at `:1233` - which is precisely what this function's own SCOPE GUARD
(`groupTitle.ts:140-147`) says: "this consolidates ONLY the inbox row + push
title. Other relay-label chains (notably ... `routes/contacts.ts`
`otherMemberNames`) are DELIBERATELY different precedences". The module header's
identical phrasing (`:15-16`) IS accurate, because the header speaks for the
whole module including `relayMemberLabels`. Only the in-body comment overreaches.
Fix: say "the inbox row here; the contact card through `relayMemberLabels` and
its own copy of this carve-out".

**W2-4. A third copy of the A-2/R2-12 parity claim is still standing, in a file
wave 2 edited - and the wave-2 test 65 lines below it states the opposite.**
`app/test/inboundMessagePush.test.ts:365-366`:

```
// Same label the inbox row renders (parity by construction).
expect(soleMessagePayload(world).title).toBe(relayThreadLabel(relay));
```

The assertion is still true (both sides read the raw roster), but the comment's
general claim is exactly what hydration broke: the inbox row goes through
`withLiveNames` (`routes/inbox.ts:1162`), the push title does not
(`routes/webhooks/twilio.ts:743`). Wave 2's own new test at `:459-461` says so
in as many words ("The TITLE still renders the stored snapshot"), so the file
now asserts both. R2-12 found the same false claim on two docblocks; this is the
third instance and nobody swept the tests for it. Comment-only.

**W2-5. The `nameOnlyStored` docblock's causal claim is wrong in KIND: the
pre-branch code suppressed the stored name in a RESPONSE, never in storage.**
`app/src/lib/rosterDriftTally.ts:24-26` says "This is the population
relayGroups' member update made permanent when it stopped deleting the stored
name, so clearing a contact's name no longer clears it from a roster". The
removed code (`git diff f27aabbf..HEAD -- app/src/routes/relayGroups.ts`) is in
GET `/conversations/:id/members`: it built a local `memberWithoutStoredName`,
`delete`d `.name` from that COPY and returned it. There is no write, no
`update`, and no member-update path involved - the stored roster name was never
cleared by anything, before or after. What actually changed is DISPLAY: that
reader used to fall to the phone and now falls to the stale stored name (the
2026-08-31 middle-rung ruling, `relayGroups.ts:481-488`). The counter is right
and worth having; the sentence sends the next reader looking for a write path
that does not exist. Two words ("the /members read stopped suppressing").

**W2-6. The one sub-case whose OUTPUT changed from `main` (R2-3) is the only
part of the guard with no pin - on either arm.** Adjudicated CORRECT BY
CONSTRAINT with "No code change", which I do not contest (section 4). But the
guard is pinned exactly once and only on the case where a stored roster name
exists: I removed `!isDeleted(senderContact)` from
`app/src/routes/webhooks/twilio.ts:322-325` and precisely one test failed -
`inboundMessagePush.test.ts` "RED: a soft-deleted contact supplies no name - the
body prefix falls back to the stored roster name" (22 passed, 1 failed). The
deleted + NO stored roster name case, whose push body now reads
`(555) 010-0001: hello` where `main` read `Ana Reyes: hello`, is asserted
nowhere. Regression risk is low (the guard itself is protected by the test
above); the value is documentary, and it is one `expect` in a file that already
has the fixture.

**W2-7. "One bucket per member" is true; "exactly once" is not, and the new
comment names only one of the two unbucketed combinations.**
`app/src/lib/rosterDriftTally.ts:56-58` says the fourth combination (neither
side named) "lands in no bucket". The BOTH-named-and-EQUAL case also lands in no
bucket - it is the healthy majority case - and the test named "classifies every
member exactly once" asserts 5 name/state buckets over 7 `withContactId`
members (`app/test/rosterDriftTally.test.ts:33-37`, the two `c-ok` rows). No
defect: precedence is intact and no member is double counted. Recorded so the
audit's reader does not try to sum the block.

---

## 2. The wave-2 diff, reviewed cold (7b9450e6)

Six files, 118/5. Exactly the four adjudicated items; no read or write path
changed - verified by reading every hunk, not by trusting the report.

### Pin 1 (R2-1) - correct, and it asserts the right thing

`app/test/inboxGroups.test.ts:533-561`. The fixture is honest: a `relay_group`
carrying `placement_tag: 'Maple St - Dana'` whose two participants have
contactIds and NO `name`, against seeded contacts `Ana Reyes` / `Ben Ortiz`.
The file's `getDisplaysByIds` fake (`:122-131`) maps the seed's `name` onto
`firstName`, so `contactDisplayName` resolves it - the resolution really is the
contact read, not the fixture handing the label over. Whole names (not first
names) is right: `relayThreadLabel` -> `relayMemberLabels` does not shorten,
unlike `groupThreadLabel`.

Could it pass with the behavior broken? Only if something else produced the
exact string `'With Ana Reyes & Ben Ortiz'`, and nothing can: the stored roster
is nameless, so without hydration rung 1 yields formatted phones, `anyNamed` is
false and the tag wins. The trailing `.not.toBe('Maple St - Dana')` is
redundant after an exact `toBe` but harmless. It is a declaration pin, so it
passed on first run - the discrimination evidence is the sabotage, reproduced
in section 3.

Unit-level support already existed and I confirmed it stands:
`app/test/groupTitle.test.ts:110` (tag beats a roster of raw numbers) and
`:124` (one real name beats the tag) - so the rung itself is pinned in both
directions and wave 2 adds the hydrated integration layer. The adjudication's
strongest ground is also true in code: `resolveMemberName`
(`app/src/services/relayMembers.ts:47-60`) writes contact-derived names at add
time, so on `main` a dashboard-created tagged group ALREADY titles by names and
ignores its tag. The tag rung's live population was only ever nameless imported
rosters.

Residual: W2-2 (second surface unpinned), W2-3 (comment overreach).

### Pin 2 (R2-2) - correct for the FLIP, silent on the guard

`app/test/inboundMessagePush.test.ts:432-462`. Discriminating by construction:
stored `Old Alice` vs live `Alicia Live`, so the winning rung is legible in the
assertion. Wiring verified: the harness's `contacts.getById` reads
`world.contacts` (`app/test/helpers/twilioWebhookHarness.ts:1688-1690`), the
world is rebuilt per test (`inboundMessagePush.test.ts:158`), and the relay arm
resolves `senderContact` from the roster contactId alone
(`app/src/routes/webhooks/twilio.ts:589`) - the arm the group-arm tests never
reached. Asserting the body rather than the whole payload is the right call and
the comment says why.

What it does not cover: the `isDeleted` guard on this arm - proven, not
assumed (W2-6): with the guard deleted this test still passes. That is
acceptable by construction, because `pushSenderLabel` is arm-agnostic and the
only arm-specific code is the `senderContact` resolution this test does drive.
R2-2 asked for "one relay test with a renamed contact and one with a deleted
one"; the adjudication scoped it to the first. Recorded as a scoped close, not
an open item.

### `nameOnlyStored` (R2-4) - correct

Precedence intact and verified against the source, not the report:
`noContactId` (`:49`) -> `withContactId` -> `danglingContactId` (`:52`) ->
`deletedContact` (`:53`), each with `continue`, then the name chain at
`:59-61`. The new arm is LAST and its predicate `want === undefined && have
!== undefined` is disjoint from both siblings, so no member can enter two
buckets and neither existing count changes meaning. `want`/`have` are computed
exactly as before. The interface field is required and the only consumer is the
audit script - `git grep RosterDriftTally` finds no other constructor -
confirmed by an independent `npm run typecheck` (EXIT=0).

Audit print line (`app/scripts/measure-unread-contact-coverage.ts:622`): reads
the right field, sits inside the "with contactId" block beside its siblings,
and its label column lands at the same offset as the four lines around it
(checked character-by-character). The gloss "contact readable but nameless; the
stored name stands (kept by design)" is accurate.

Caveats: W2-1 (the id collection feeding it), W2-5 (docblock causality), W2-7
(taxonomy wording).

### groupTitle comments (R2-12) - comments only, as claimed

Independently verified rather than taken from the report: filtering
`git show 7b9450e6 -U0 -- app/src/lib/groupTitle.ts` to changed lines that are
not `//`, `*` or `/**` returns NOTHING. All three hunks are inside comments;
zero code tokens changed.

Accuracy, claim by claim:

- `groupThreadLabel` docblock (`:36-39`) - "routes/inbox.ts does at :1205" is
  literally correct: `inbox.ts:1205` is
  `name: groupThreadLabel(withLiveNames(conv.participants, names))`.
- Module header (`:13-18`) - correct. Hydrated callers are `inbox.ts:1205`
  (group) / `:1162` (relay) and `contacts.ts:1297,1310` (group card) /
  `:1214,1218` (relay card); the stored-snapshot callers are
  `twilio.ts:1826` and `:743`.
- The third stored-snapshot caller, `poolNumbersAdmin.ts:109`, is NOT named
  here - correctly, since it is filed as its own issue
  (`docs/issues/staff-only-roster-name-readers-stale.md`, severity low, with
  `serverLabel` listed) and the header does not claim to enumerate callers.
- Carve-out comment (`:166-170`) - see W2-3.

I also checked the surface R2-12's module header is actually about, the native
group_text THREAD HEADER, since it is the one place a fourth input class could
hide: `GroupTextView.tsx:264` titles from `headerRoster`, but that state is
converged from `getGroupMembers` on mount and on every SSE/focus/interval beat
(`:172-200`), applying the same transform the route applies - so it is not a
new stale surface. No finding.

---

## 3. Sabotage re-run - the discrimination claims, reproduced

Both wave-2 sabotages were re-staged here from scratch and reverted.

**R2-1 pin.** `app/src/routes/inbox.ts:1162` changed to pass
`participants: conv.participants` (hydration removed):

```
FAIL test/inboxGroups.test.ts > roster names resolve on read (M1) > PIN: a
tagged, snapshot-nameless roster titles by the CONTACT names once hydrated
AssertionError: expected 'Maple St - Dana' to be 'With Ana Reyes & Ben Ortiz'
 Test Files  1 failed (1)
      Tests  2 failed | 19 passed (21)
```

The received value is the TAG - the pin bites on exactly the rung R2-1 named,
and the collateral failure is the sibling relay test ("With Ann Tenant"), as
the report predicted.

**R2-2 pin.** Rungs reordered in `pushSenderLabel` (roster before live contact):

```
FAIL ... > PIN: the relay push body prefix prefers the live CONTACT name over
the stored roster name
AssertionError: expected 'Old Alice: is the unit available?' to be
'Alicia Live: is the unit available?'
FAIL ... > RED: the body prefix prefers the CONTACT name over a stale roster name
AssertionError: expected 'Old Ana: ...' to be 'Ana Reyes: ...'
 Test Files  1 failed (1)
      Tests  2 failed | 21 passed (23)
```

Both match `wave2-report.md` line for line, including the collateral group-arm
sibling.

**Extra probe (mine, not the report's).** `!isDeleted(senderContact)` removed
from `pushSenderLabel`: 1 failed | 22 passed - only the group-arm deleted test.
That is the evidence behind W2-6 and behind "the relay pin does not cover the
guard".

Reverted with `git checkout -- <path>` after each; `git status --porcelain`
prints NOTHING but this file, and the three-file re-run is 46/46 green again.

---

## 4. Adjudications - challenged and upheld

**R2-1 ACCEPTED-BY-DESIGN - UPHELD.** The rung is genuinely untouched
(`groupTitle.ts:171`), and the adjudication's claim that the render now equals a
freshly-created group's is verifiable: `resolveMemberName`
(`relayMembers.ts:47-60`) derives member names from the contact at add time, so
any dashboard-created tagged group already suppressed its own tag on `main`.
That makes this a widening of an existing precedence, not a new one, and the
residual population (bare-phone members, dangling ids, deleted or nameless
contacts) still gets the tag. Routing the product preference to Cameron with a
one-line remedy is the right disposition. Two residuals: W2-2 and W2-3.

**R2-3 CORRECT-BY-CONSTRAINT - UPHELD, with the record caveat below.** I went
looking for a reason to contest this and did not find one. "A soft-deleted
contact supplies no name" is the same rung `withLiveNames`
(`participantNames.ts:71`) enforces, so the push body now AGREES with the inbox
row for the same member instead of contradicting it; and the phone fallback is
the app's documented convention for staff-only chrome, stated at
`groupTitle.ts:74-79` ("Rendering 'Unknown' gives a navigator nothing to act
on"). The push is staff-only. `main`'s name-showing really was the odd one out.
Caveat, not a contest: `fix-wave-report.md:109-112` still carries the refuted
"restores main's outcome" claim with no in-file pointer to its superseder, the
same shape as the T9/`applyTriage` correction (which I re-verified: `git grep
applyTriage app/src` returns `contacts.ts:1769`, `contacts.ts:1887` and
`placementNudges.ts:556` - three writers, and `code-review-conformance.md` has
not been touched since `744142f9`). Correcting later documents rather than
rewriting produced ones is this repo's convention, so I am not asking for an
edit - but the handback should state that two green-stamped records carry facts
corrected elsewhere.

**R2-17 REJECTED - UPHELD as an outcome; the stated reason half-answers the
finding.** "The leg CAN fail (name never renders -> 20s timeout)" is true but is
not what R2-17 claimed; the next clause concedes the actual claim ("it cannot
isolate rung 1 because the product's own PATCH write-through refreshes the
snapshot"), which I confirmed at `contacts.ts:1753-1769`. Reading
`e2e/tests/scenarios/participant-names.spec.ts:47-59`, assertion 1 asserts the
renamed tenant on Today's Unreplied list after a 1:1 inbound, which the
write-through alone satisfies. R2-17's secondary-phone alternative would isolate
the rung, but it is a real harness change against a product that write-throughs
by design, and `todayApi.test.ts` carries rung 1. Defensible call.

**R2-19 - N-A for the branch, but it is the ONE item whose closure cannot be
verified here.** Every fact is still true in the tree, re-checked:
`docs/issues/group-roster-name-snapshot-never-refreshed.md:5-9` is
`severity: high` + `status: resolved`; `docs/issues/_CLUSTERS.md:82` still lists
that slug as a `high` ANCHOR; `_CLUSTERS.md:84` still says "six private
name-join copies". Holding `_CLUSTERS.md` out of a feature branch is a
defensible line. The consequence is that this item's entire load sits on a
handback document that does not exist at verification time, exactly as round 2
warned - so it is a merge-time check, not a code-time one.

**A-3's corrected reason** - accepted and recorded; nothing further owed.

---

## 5. Verdict per round-2 item

| id | round-2 severity | verdict | basis |
|---|---|---|---|
| R2-1 | must-fix | CLOSED (scoped) | Pinned `inboxGroups.test.ts:533`, sabotage-discriminating; comment at `groupTitle.ts:166-170`. Residuals W2-2 (second surface unpinned) and W2-3 (comment overreach). Handback item unverifiable here. |
| R2-2 | should-fix | CLOSED (scoped) | Relay-arm flip pinned `inboundMessagePush.test.ts:432`, sabotage-discriminating. Guard on this arm intentionally out of scope; guard itself pinned once on the group arm (W2-6). |
| R2-3 | should-fix | CLOSED | Record corrected in the adjudications, now committed at `335b7448`. Adjudication upheld on the merits. Residual W2-6; stale claim left standing in `fix-wave-report.md` by convention. |
| R2-4 | should-fix | CLOSED | `nameOnlyStored` added, precedence verified disjoint, test asserts the whole tally, print line correct and aligned, typecheck clean. Adjacent W2-1 and W2-5. |
| R2-12 | should-fix | CLOSED | `groupThreadLabel` docblock + module header carry the input contract; comments-only proven independently; claims verified against the callers. W2-3 and W2-4 are the residue. |
| R2-17 | promoted should-fix | N-A (rejected, rationale recorded) | Outcome upheld; reason partly answers a claim not made, then concedes the real one. |
| R2-19 | should-fix (2 doc lines) | N-A for the branch / OPEN at handback | Facts re-verified true in the tree; `_CLUSTERS.md` held out of the feature branch by policy; closure rests entirely on a handback not yet written. |
| R2-5..R2-11, R2-13..R2-16, R2-18 | notes | CLOSED as notes | Carried to the handback per the adjudications; nothing owed in code. R2-18's correction verified present. |

## Overall call

**CLEAN, with a short punch list - no blocker.**

Wave 2 delivered exactly its four adjudicated items and nothing else: no read
path, write path or precedence rung moved, both pins discriminate under sabotage
I re-ran myself, the counter cannot double-count, the audit line prints the
right field, and the comment hunks are provably comment-only. Typecheck and
lint on the touched files are green.

What I would carry into the handback rather than block on:

1. **W2-1** (`measure-unread-contact-coverage.ts:604`) - a one-predicate fix,
   and it lands BEFORE the P5 audit lane run, whose numbers are the deliverable.
   This is the only item with an operational consequence.
2. **W2-2** - one test on the contact card, closing R2-1's second surface.
3. **W2-3, W2-4, W2-5** - three comment lines, all in text wave 2 or wave 1
   wrote, all of the same species R2-12 was raised about.
4. **W2-6, W2-7** - recorded only.
5. R2-19's `_CLUSTERS.md` lines and R2-1's push-vs-inbox divergence must appear
   in the handback; neither is verifiable until it exists.
