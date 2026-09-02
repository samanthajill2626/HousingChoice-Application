# Adversarial spec review, round 2 - reviewer B

Spec v2: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md` @8053bbea
Adjudications: `design-review/adjudications.md`
Round-1 reports: `spec-review-A-findings.md`, `spec-review-B-findings.md`
Tree: `W:\tmp\participant-snapshot-refresh`, read-only.

Round-1 items are NOT re-litigated except where an accepted finding did not
land or where a v2 fix is wrong. Everything below was opened in the code.

Not re-checked, still UNVERIFIED: section 1's dev/prod measurement table
(live-table script output; v2 now says so itself).

---

## R1. BLOCKING - `requireComplete` on the two outbound jobs produces a NEVER-SENT intro, which is worse than the bug it fixes

5.4 and S4 rule that `relayFanOut.ts:634` and `:685` take
`getManyByIds({ requireComplete: true })` and "let `IncompleteBatchReadError`
fail the job, so redelivery retries". Risk table: "job fails and redelivers".

That does not happen. The handler stamps a job-execution marker FIRST:

- `app/src/jobs/relayFanOut.ts:615-622` - `putJobExecutionMarker(jobId, ...)`,
  and `if (!first) { log; return; }`.
- Only then does it read the conversation (`:626`) and compose (`:633-634`).
- `app/src/repos/messagesRepo.ts:1264-1268` states the contract: "True = first
  execution (proceed); false = this jobId already ran (an SQS redelivery -
  suppress the side effect)."

So a `requireComplete` throw at `:634` leaves the marker written. SQS
redelivers, `putJobExecutionMarker` returns false, and the handler RETURNS
WITHOUT SENDING. The relay group is provisioned and no member is ever
announced to - and the intro is the A2P first-contact message carrying the
brand and the STOP instruction (`:213-215`). `RELAY_MEMBER_ADDED_JOB` has the
identical shape at `:671-678`.

B4 traded a shortened connection sentence for a permanently absent one. Either
the roster read moves AHEAD of the marker, or the marker becomes conditional on
a completed send, or these two sites keep the short-map posture and accept the
count phrasing. The spec must say which; as written the build is wrong.

## R2. BLOCKING - `requireComplete` does not cover rung 2, so 5.4's guarantee has a hole the size of the cap

5.4's guarantee is that an outbound body never silently loses a name.
`requireComplete` is an option on `getManyByIds` only
(`app/src/repos/contactsRepo.ts:611-614`). Rung 2 (5.1) is a SEPARATE
mechanism: serial `findByPhone` calls, capped at 25, "past the cap the
remaining members keep their stored names and a WARN fires".

For a member with no usable `contactId` and no stored name - the population
5.1's own rung-2 justification is built on, and the population the Quo import
creates, since `app/src/lib/import/apply.ts:1075` types the written roster as
`{ contactId: string; phone: string }[]` with no `name` - the outcome is:

- rung 1 misses (by construction),
- rung 2 resolves them, or is cut off by the cap, or its `findByPhone` throws,
- rung 3 yields `undefined`,
- `composeConnectionSentence` (`app/src/jobs/relayFanOut.ts:190-192`) DROPS
  them and substitutes the count.

That is exactly B4's failure, reached through the cap instead of the throttle,
and `requireComplete` cannot see it. The spec states no cap-exceeded posture and
no `findByPhone`-failure posture for the outbound path.

## R3. BLOCKING - S5 puts an awaited contact read in front of a deliberately fire-and-forget webhook boundary

`app/src/routes/webhooks/twilio.ts:398-402` states the invariant: the push
"promise is deliberately NOT awaited, so a slow or failing push can never delay
or fail the webhook ack (the same pattern as the pre-ring voice push)".

The TITLE argument is computed synchronously OUTSIDE that boundary, and today it
is pure:

- `:727` `relayThreadLabel(relay)`
- `:1810` `groupThreadLabel(thread.participants)`

Hydrating those means awaiting a batch contact read inside the Twilio webhook
handler, before `emitMessagePush` is reached - i.e. on the ack path the docblock
exists to protect. The risk table's only hot-path row is the relay fan-out
sender prefix; the webhook is not named.

The other half of S5 is FREE and the spec should say so, because pricing them
together hides this:

- `pushSenderLabel` (`:307-315`) is already handed `senderContact` at `:728` and
  `:1814-1818`;
- `maskedPartyLabel` (`app/src/routes/webhooks/voice.ts:116-121`) is already
  handed the matching contact at `:980-982` and `:990`.

Both precedence flips cost zero reads. Only the two title sites cost anything,
and they cost it in the worst place.

## R4. HIGH - section 3's justification for reversing `relayGroups.ts:474-476` misreads the comment it overturns

Section 3 decision 3: "the live contact still outranks the snapshot whenever it
is readable - **which is all its comment at `:471-473` actually argues**".

The comment is `app/src/routes/relayGroups.ts:471-474` and has two clauses. The
second is not precedence: "current name wins, **otherwise the dashboard uses
this current roster phone as its fallback**". "Otherwise" is exactly the
read-failure branch the code implements at `:482-489`, and the log string at
`:487` restates it: "returning roster phone without stored name".

That fallback is real and implemented client-side:

- `dashboard/src/lib/recipientLabel.ts:121` labels a member via
  `groupMemberLabel` - "full name, else formatted number";
- `dashboard/src/lib/recipientLabel.ts:95-99` states the split as an invariant:
  "a nameless relay member is unnamed as an AUTHOR ... and shown by number as a
  RECIPIENT, because a blank row is useless. That split is intended and must not
  be 'fixed' in either direction."

So the shipped design guarantees that for a relay member WITH a contactId, the
rendered name is always live-or-absent - never a stale name asserted as
current - and hands the operator a number to act on instead. The reversal
trades an actionable unknown for a possibly-wrong assertion on the surface where
an operator picks relay recipients.

The reversal may still be the right product call; Cameron answered it. But S2
instructs a builder to AMEND `:471-473` "to say what now holds", and a builder
amending it on this spec's reading will delete a rationale that three other
sites still implement. State the trade honestly, and say what
`recipientLabel.ts:95-99` now means.

## R5. HIGH - section 3 decision 2 is violated by a route section 4.2 puts in scope

Decision 2: "Batch the lookups. One batch read per page, never one per member."

`app/src/routes/relayGroups.ts:468-492` is `Promise.all` over
`contacts.getById(member.contactId)` - one read PER MEMBER. 4.2 lists it as
"YES (S2)" and S2 changes only its fallback (`:324-328`). So the spec's own
in-scope list contains an unbatched per-member reader it leaves unbatched, while
decision 2 declares the opposite rule. Either batch it with `getDisplaysByIds`
or scope decision 2 to the surfaces it actually governs.

## R6. HIGH - section 4's completeness claim is already false on the first table

"These tables are the enumeration; every line was opened by a reviewer or the
planner." 4.1's WRITERS row lists three.

Two more write `participant_display_name`, both through
`createOrGetByParticipantEmail`'s `opts.displayName`
(`app/src/repos/conversationsRepo.ts:587-594`), which is why a literal-string
grep misses them:

- `app/src/routes/contacts.ts:1909-1912` - `POST /:contactId/email-conversation`
- `app/src/services/inboundEmail.ts:909-917` - inbound email thread creation

Both derive the value from their own private `displayNameOf`
(`contacts.ts:476-482`, `inboundEmail.ts:399-405`), so they are also two more
entries for section 9's census.

A table that asserts completeness and is short on its first row is worse than
one that does not, because the next reviewer stops looking.

## R7. HIGH - the deferral justification "neither shares a rendered thread with a hydrated surface" is false for both deferred readers

Section 5, lines 174-178.

`services/relayGroupDuplicates.ts:128-132` builds `memberNames` for a
`DuplicateOpenGroup`, which `buildOpenPreviewFromParts` attaches to the SAME
`RosterPreview` object S4 hydrates (`app/src/services/rosterEdits.ts:478-481`,
fed at `:535-536`). One dialog, two name sources: the body sentence hydrated,
the "you already have a group with these people" list stale. That is not a
different surface, it is the same screen.

`routes/poolNumbersAdmin.ts:109` names the same relay conversations the inbox
row (`relayThreadLabel`) and the contact card (`contacts.ts:1204`) name. They
are different PAGES, not different threads. The sentence as written claims
something stronger and untrue, and it is the whole basis for the deferral.

## R8. HIGH - 4.2's table and S3's text contradict each other on `resolveRoster`

4.2 row: "`lib/rosterResolution.ts:219-228` | `resolveRoster` copies `p.name`
verbatim to every caller | **YES (S3)**".

S3 text: "`resolveRoster` (`:219-228`) copies `p.name` verbatim to callers
beyond `describeRoster`. Those callers read phones and counts ... except the
roster-edit previews - which S4 covers." S3's only code change is the
`describeRoster` flip at `:544-545`.

So the table says resolveRoster is fixed by S3 and the text says it is not. The
row decides real behavior, because these callers read `resolveRoster` members:

- `app/src/services/rosterProvision.ts:106-121` `provisionMembersOf` copies
  `member.name` into the NEW thread's roster (`:117`) - a name WRITE, not a
  count;
- `app/src/jobs/rosterActions.ts:321`, `app/src/jobs/placementNudges.ts:487`,
  `app/src/services/rosterProvision.ts:202, :576, :618`.

The count/phone claim is correct for `rosterActions` and `placementNudges`
(verified: `placementNudges.ts:505-506` uses `isOnRoster` only;
`rosterActions.ts:322-326` checks `source`), but not for `provisionMembersOf`.

## R9. HIGH - rung 2 can attach the WRONG person's name, and S4 sends it

`app/src/repos/contactsRepo.ts:1011-1016` documents the hazard in the
implementation of the exact primitive 5.1 elevates to a resolution rung:
"Accepted risk: duplicate phones return the FIRST item the GSI yields
(arbitrary order) ... pre-existing duplicates (e.g. imports) stay first-match
until the M1.6 import dedupe resolves them."

Rung 1 (`contactId`) is exact. Rung 2 is a heuristic with a documented arbitrary
tiebreak, on the population - imports - the spec is largely about. 5.1 cites
`api.ts:2058` as the precedent, and that precedent is a staff PANEL. S4 routes
the same resolution into delivered SMS bodies and S5 into push titles. "Wrong
name in a panel a navigator can correct" and "wrong name texted to a tenant" are
not the same risk, and the spec does not distinguish them.

At minimum: say whether rung 2 is permitted on the outbound path at all.

## R10. HIGH - the phone rung's cost is understated by roughly 2x, and it is serial

5.1 prices rung 2 as "serial `findByPhone` calls" capped at 25.

`app/src/repos/contactsRepo.ts:1017-1037`: each `findByPhone` is a byPhone GSI
Query, and a hit on a phone-pointer item (`phone_ref === true`) issues a SECOND
read via `getByIdImpl(owner)` (`:1031-1035`). Non-primary numbers are exactly
the pointer case. So the cap of 25 authorises up to 50 sequential DynamoDB round
trips per hydration call, on `GET /api/inbox`.

That is the amplification class 5.1 invokes the cap to prevent
("the amplification class this repo has been burned by twice"), reintroduced by
the mechanism chosen to prevent it. Compare the round-1 accepted correction
about `batchGetByIds` chunking: the same reasoning applies here and is stronger,
because these are serial and unbatchable by construction.

## R11. MEDIUM - the cap of 25 is fixed against a distribution this branch has not yet measured

S6 exists BECAUSE roster staleness is unmeasured: "members whose stored name is
MISSING while the contact has one" is a number the branch produces. 5.1 picks
25 before that number exists, and rung 2 fires for every member whose rung-1
lookup missed - which includes every bare-phone member on the page, not only
the triage-stub case rung 2 was justified by.

Sequence S6's group pass BEFORE fixing the cap, or state that 25 is provisional
and name the metric that would revise it.

## R12. MEDIUM - section 11's test list contradicts 5.1

Section 11: "**bare-phone member untouched**".

5.1: rung 2 is "attempted ONLY for members whose contactId rung missed". A
bare-phone member's `contactId` is `''` (`rosterProvision.ts:116`,
`relayMembers.ts:76`), so its rung-1 lookup necessarily misses and rung 2 fires
by phone. The v1 spec's rule ("a bare-phone member keeps its stored name -
there is no contact to resolve") was dropped when rung 2 was added, but the test
that pinned it was carried forward unchanged.

Decide: is a bare-phone member resolved by phone or not? Both answers are
defensible; the spec currently asserts both.

## R13. MEDIUM - `requireComplete` on the two PREVIEW composers turns a throttle into an operator-facing 500

S4's table applies `requireComplete` to `rosterEdits.ts:472-473` and `:672-676`.

B4's argument was specific: the SMS is sent once, behind an idempotency marker,
and can never be recomposed. A preview has none of those properties - the
operator is looking at a dialog and can click again. `buildOpenPreview`
deliberately does not catch (`app/src/services/rosterEdits.ts:529-531`), so an
`IncompleteBatchReadError` propagates and the operator cannot open the group at
all during a transient throttle.

Applying the send-path rule to the preview converts a degraded label into a
blocked workflow. The previews should use the short-map posture and the SEND
should be the gate.

## R14. MEDIUM - S4 overturns a second documented design without acknowledging it

`app/src/services/rosterEdits.ts:437-441` states the body/recipient split as
deliberate: "They are separate because the owner path composes the body from
`resolveRoster` (stored names) and the recipient list from `describeRoster`
(backfilled names) - one field cannot carry both." `:425-426` says the recipient
name "may be backfilled from the contact and so differ from the body name", and
`:500-506` gives the reason the BODY uses stored names: "The body names the
members PROVISION will actually put on the thread ... because the intro job
composes from the conversation's participants."

S4's change is coherent - it hydrates both the job and the preview, so the
invariant "preview body == what the job composes" is preserved. But three
comments become wrong the moment it lands, and the spec neither quotes nor
amends them. This is the same class as R4 and as the round-1 `contactName.ts`
scope-guard finding, and it is the third instance, which suggests a checklist
item rather than three one-offs: any spec that inverts a commented rule must
name the comment.

## R15. MEDIUM - S1 splits Today's own naming rule in two

S1's chain starts `contactDisplayName(contact)`. A15 was accepted, so
`app/src/routes/today.ts:222-228` `nameFromContact` is NOT re-pointed and keeps
serving `resolveContactLabel` (`:370-373`) for placement (`:448, :497, :522`),
tour (`:554`) and AI-suggestion (`:961`) rows.

Those two helpers differ: `contactName.ts:69-71` trims each part before joining;
`today.ts:224-226` joins first and trims the outside. A contact with a padded
`firstName` therefore renders one way in Unreplied and another in Follow-ups, on
the same page, after this branch.

Nothing forces `contactDisplayName` here - `today.ts` holds a full `ContactItem`
from its own memo (`:356-369`), so `nameFromContact` works unchanged and adds no
helper. The spec should name the helper S1 uses and say why. This is a new
inconsistency created by two separately-correct accepted findings interacting.

## R16. MEDIUM - S5 does not say which helper `maskedPartyLabel` adopts, and its output is PERSISTED

`app/src/routes/webhooks/voice.ts:144-146` states that "The STORED
call_party_label, the spoken whisper, thread rendering, and the outbound
originate path all keep the MASKED posture (lib/voiceMasking.ts)". The masked
helper is `contactShortName` - "First L." - at
`app/src/lib/voiceMasking.ts:46-53`. `contactDisplayName` is the unmasked
"First Last".

`maskedPartyLabel`'s output is written into the message record as
`call_party_label` (`voice.ts:993-1002`), so this is a data change, not a render
change. "All five adopt the section-3 rule" does not resolve which helper the
contact rung uses on the one surface that has a documented masking posture and a
purpose-built masked helper.

## R17. MEDIUM - an accepted round-1 item did not land

The adjudication accepted A2 "in full", including its implication that
`dashboard/src/routes/conversation/GroupTextView.tsx:212-221`'s convergence
"needs a stated outcome (once the header is hydrated its `changed` flag goes
permanently false, which is fine, but the invariant its comment at `:195`
asserts stops holding)".

v2 cites `GroupTextView.tsx:200-206` once, for latency (S2 cost note). Nothing
states the convergence outcome, and the comment at `:191-211` - which reasons
explicitly about served-vs-stored inequality and the first-open re-title
flicker - is left describing behavior that will no longer occur.

## R18. MEDIUM - 4.2's client list misses a reader with its own documented invariant

`dashboard/src/lib/recipientLabel.ts:101-139` resolves a delivery-map key to a
member and labels it via `groupMemberLabel(found)` (`:121`) off
`header.participants`. It is not in 4.2's client list. Its docblock at `:95-99`
carries an explicit "must not be 'fixed' in either direction" rule about the
nameless case - which is precisely the case R4's reversal changes, so it is not
an incidental omission.

## R19. MEDIUM - 4.2's writer list misses `provisionMembersOf`

`app/src/services/rosterProvision.ts:106-121` writes `member.name` (`:117`) into
the participants of every newly provisioned relay group, sourced from
`resolveRoster`. On the create path that source is the plan/default branch,
which resolves names from contacts, so the written names are fresh - which is
the fact S4's "honest cost/benefit" paragraph rests on. That makes it a writer
worth naming in the table rather than one to leave out: it is the evidence for
S4's own argument.

## R20. LOW - `collectRosterKeys` returning `phones` is unusable as specified

5.1's `collectRosterKeys` returns `{ contactIds, phones }` up front, but rung 2
is "attempted ONLY for members whose contactId rung missed" - a set not known
until after the batch resolves. The eager phone list is either dead or is the
uncapped list the cap exists to avoid. Return contactIds; derive the phone set
from the misses.

## R21. LOW - two signature mismatches against the primitives

- `getDisplaysByIds` returns `Map<string, ContactDisplayItem>`
  (`app/src/repos/contactsRepo.ts:597`), not a map with `undefined` values;
  5.1's `ReadonlyMap<string, ContactDisplayItem | undefined>` implies a
  distinction the primitive does not make.
- `findByPhone` returns `ContactItem | undefined`
  (`app/src/repos/contactsRepo.ts:592`), not `ContactDisplayItem`, so `byPhone`
  and `resolved` are not the same value type.

5.2's widening claim itself is CORRECT and I checked it:
`ContactDisplayItem` declares `firstName?: unknown; lastName?: unknown`
(`:296-302`), so `contactDisplayName`'s bracket reads
(`app/src/lib/contactName.ts:69-70`) work on it with no index signature.

## R22. LOW - 4.1 omits a reader in the file S6 edits

`app/scripts/measure-unread-contact-coverage.ts:545-546` reads
`participant_display_name`. It is the audit S6 extends, so leaving it off the
reader table is a small inconsistency in a table that claims completeness.

---

## Contesting the adjudications

**B15 - CONCEDED.** The rejection is right. Three drifted write-side
implementations strengthen the case for consolidating on read rather than
weakening it; my framing inverted that. The table correction was the substance
and it is in v2 (with the additions at R6 and R19 still owed).

**A13's partial rejection - the planner's reading is correct, with one
addition.** `app/src/repos/contactsRepo.ts:790-804` does make the
display-vs-outcome ruling in those terms, so "argued, not inherited" did
overclaim; and B4 does show restating it per-consumer was what caught the
outbound case. Worth recording: v2's 5.4 now cites that guidance and then, at
R1, applies it to a job whose idempotency marker makes the `requireComplete`
half unworkable. The per-consumer restatement was right; it needs one more
consumer-specific fact - the marker - to be correct.

**A1's partial rejection - defensible and I did not check it.** I did not read
`services/groupMembers.ts:105-193`; UNVERIFIED from my side.

**No other rejection contested.**

---

## Verified in v2, no finding

- R1's counterpart claim in S1 is sound: the memo (`today.ts:356-369`), the
  gate (`:743`), the emit loop (`:778`).
- 5.2's six precedents and the "prefer `getDisplaysByIds`" rule
  (`contactsRepo.ts:600-605`) are as cited.
- 5.3's soft-delete posture is implementable: `DISPLAY_PROJECTION` carries
  `deleted_at` (`contactsRepo.ts:856-865`) and `isDeleted` takes a
  `Pick<ContactItem,'deleted_at'>` (`:309-311`), so it accepts the display shape.
- S6's new-sources correction is right, and `listGroupTexts` /
  `listRelayGroups` are the correct sources.
- 7.4's `tourReminders.ts:1151-1162` claim, re-checked: length and pool number
  only.
- Section 9's disposition (re-point nothing) removes the round-1 regression
  risk entirely.
- `lib/import/apply.ts:1075` writes rosters with `{contactId, phone}` and no
  `name`, so imported group rosters are NAMELESS rather than stale - relevant
  to R2 and R9, and consistent with the spec's framing.
