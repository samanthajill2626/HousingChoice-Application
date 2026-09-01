# Adversarial spec review, round 3 - reviewer B

Spec v3: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md` @9151c28f
Adjudications: `design-review/adjudications.md`, `design-review/adjudications-round2.md`
Trees read: `W:\tmp\participant-snapshot-refresh` and `W:\tmp\tour-reminder-ladder-phase-b`,
both read-only.

Treated as new material, per the charge. Round-1/2 items are not re-litigated
except where the scope cut made a carried-forward claim false.

Still UNVERIFIED: section 1's dev/prod measurement (live-table script output;
v3 says so itself).

---

## T1. BLOCKING - S5 cannot size the gap section 3 assigns to it

Section 3 states the gap and hands it to S5: "a `group_text` roster whose member
panel is never opened keeps its stale stored name ... S5's audit will size it."
S5's metrics are: rosters walked; members carrying a contactId; stored name
MISSING while the contact has one; stored name DIFFERS; and "members whose
`contactId` resolves to nothing."

The decisive population is invisible to all five.

`app/src/services/groupMembers.ts:105-119` `stubFor` mints a detection stub with
`type: 'unknown'`, `status: 'needs_review'`, `phone` - **and no `firstName` or
`lastName`**. `app/src/services/groupConvert.ts:189-200` fills a missing
`contactId` with `contactIdForPhone(member.phone)`, and the route comment at
`app/src/routes/api.ts:2029-2041` names the failure verbatim: staff triage that
nameless stub into a real contact and the roster keeps pointing at the stub.

So for that member the audit computes, by the existing shape at
`app/scripts/measure-unread-contact-coverage.ts:527-548`:

- `contactId` resolves to a row -> not counted by "resolves to nothing";
- the row has no name, so `want` is null -> counted by NEITHER
  "MISSING while the contact has one" NOR "DIFFERS";
- the roster's own stale name is never compared to anything.

The member is counted only in "carrying a contactId" - indistinguishable from a
perfectly fresh member. S5 as specified would report a small number and be
believed, which is the exact failure mode round 2's B7 caught in the previous
version of this slice.

The second variant IS catchable: `app/src/services/groupConvert.ts:254-259`
documents a derived id "that has NO ROW BEHIND IT ... nothing re-resolves an
existing thread's roster, so it never self-heals". That is what "resolves to
nothing" measures. It is one of two populations, and the spec's own worked
example is the other one.

S5 needs a metric the spec does not name: members whose `contactId` resolves to
a row with NO name while the ROSTER carries one, and/or a phone-keyed
cross-check (`findByPhone`) against the id-keyed result. The audit is a manual
script, so the phone cost objections that killed the runtime rung do not apply
here.

## T2. HIGH - 5.3's soft-delete posture is defeated by the write-back v3 deliberately keeps

5.3: "A soft-deleted contact supplies NO name; such a member falls to rung 2."
4.2 and S2: `routes/api.ts:2017-2117` "keeps its converge-on-read write
untouched".

That route does not implement 5.3. `app/src/routes/api.ts:2086` selects
`contactName` whenever it is non-empty; the deleted state is recorded only as a
separate flag at `:2095`. So a soft-deleted contact's live name IS used there -
and `:2087` marks the roster stale, and `:2099-2114` **writes that name into
`participants[].name`**.

The consequence is that 5.3's guarantee is unreachable on `group_text`: opening
the member panel once persists the deleted person's live name into rung 2, and
this branch's own hydration then renders it from rung 2 forever, having
correctly refused to render it from rung 1. A builder will write the
`participantNames.test.ts` case "SOFT-DELETED contact supplies no name", watch
it pass, and ship a surface that shows the name.

Either 5.3 is scoped to "rung 1 only, and the stored copy may already carry a
deleted contact's name", or the write-back needs the same guard. The spec
asserts the strong form.

## T3. HIGH - the disposition table contradicts section 2.3

Top table: `group-roster-name-snapshot-never-refreshed` is "CLOSED for every
staff-facing surface; its outbound-content half is OWNED BY ANOTHER BRANCH".

2.3 leaves `webhooks/twilio.ts:727` and `:1810` out - the group and relay
inbound-message PUSH TITLES. A push notification to a navigator's phone is a
staff-facing surface, not outbound content: it is the same class the spec used
in round 1 to argue urgency ("two of which reach a phone's lock screen"), and
2.3 itself calls it "a known remaining gap".

Either the disposition is "CLOSED for every staff-facing surface EXCEPT the two
push titles", or the issue does not close. As written the table and 2.3 cannot
both be true, and the table is what someone reads a year from now.

## T4. HIGH - the cut leaves a single push notification carrying two name sources, which main does not

This is the R6/B6 hazard moved INSIDE one rendered artifact by the scope cut.

- S4 flips `pushSenderLabel` (`app/src/routes/webhooks/twilio.ts:307-315`) to
  contact-first. Its only two call sites are `:728` (relay push body) and
  `:1814-1818` (group push body).
- 2.3 leaves the TITLE at `:727` / `:1810` on the raw roster snapshot.

Today both halves read the snapshot first (`:312-313`), so they AGREE. After
this branch the same notification can read
`"With (555) 010-0002 & Bob" / "Alice Nguyen: running late"` where 010-0002 IS
Alice. That is a disagreement main does not have, on a lock screen, and it is
the only remaining effect of S4's twilio half now that the titles are out.

v2's risk table carried a row for exactly this ("One thread, two names across
surfaces"). **v3 deleted that row** - the mitigation was removed along with the
slice that provided it, while the cut made the underlying risk larger. The risk
table has no successor row.

I am not proposing the titles come back in (2.3's webhook-ack reasoning is
mine and I still hold it). I am saying the spec must price this, and that
"pushSenderLabel is free" is only true of its read cost.

## T5. HIGH - the phase-b boundary in 2.2 is wrong in both directions

**The asserted collision does not exist.** 2.2: "`feat/tour-reminder-ladder-phase-b`
also edits `routes/relayGroups.ts`, in the scheduled-tour-reminder block around
`:333`."

`routes/relayGroups.ts` appears NOWHERE in
`W:\tmp\tour-reminder-ladder-phase-b\docs\superpowers\plans\2026-08-31-tour-reminder-ladder-phase-b.md`
(zero matches, including its per-task `Files: Modify` lists). Its SPEC names the
file once, at
`docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md:653`,
in a table headed "Two OTHER surfaces render the same pending rungs and are
EXPLICITLY EXCLUDED": "`routes/relayGroups.ts` (group scheduled view) | same
shape argument; it renders a group's scheduled sends, not the tour ladder".

So 2.2's co-edit warning, the risk row "Merge conflict in
`routes/relayGroups.ts`", and the "sequence at merge time" instruction all point
at a conflict that phase-b's plan says will not happen.

**The real transitive reach is unflagged.** The charge asked whether anything in
S1-S5 reaches a function phase-b lists under `Files: Modify`. S3 does:

- S3 inverts `describeRoster`'s name precedence
  (`app/src/lib/rosterResolution.ts:544-545`).
- `app/src/services/rosterEdits.ts:514` and `:664` call `describeRoster`, and
  `:546-547` / `:688` build the preview's `recipients[].name` from
  `view.members`.
- phase-b's plan line 788 modifies `buildOpenPreview`, `buildAddPreview` and
  `buildOpenPreviewFromParts`; line 789 re-derives every preview route and call
  site and **re-baselines their pins** ("its pins are re-baselined to UNCHANGED,
  i.e. verified, not moved").

So this branch changes an INPUT to the functions phase-b is rewriting and
re-baselining, in a different file, with no textual conflict and a real ordering
dependency. If phase-b baselines first, S3 moves the recipient names under it;
if this branch lands first, phase-b's "verified UNCHANGED" pins must be taken
against the flipped values.

2.2's rule "Do not touch those three files" is necessary and not sufficient. The
boundary needs a data-flow line, not only a file line: name `describeRoster` as
an input phase-b consumes and say which branch lands first.

## T6. HIGH - the gap is RECURRING, not a one-time residue, and section 1's symptom 2 is not closed for it

Section 3 leans the whole stub case on the existing write-back: "stays owned by
the EXISTING converge-on-read write at `routes/api.ts:2099-2114`, which resolves
by phone and writes the corrected name back - after which this branch's rung 2
reads a fresh snapshot."

The write-back corrects the NAME only. `app/src/routes/api.ts:2101-2105` returns
`{ ...p, name }` - `contactId` is untouched, and nothing else in the tree
re-keys an existing roster (`groupConvert.ts:254-259`: "nothing re-resolves an
existing thread's roster, so it never self-heals").

So for that population rung 1 misses PERMANENTLY, and rung 2 is fresh only until
the next rename. The operator must open the member panel again after EVERY
rename. Section 1's symptom 2 - "renaming a contact does not change group
conversation titles" - is therefore NOT closed for those threads, which is the
same claim T3 objects to from the other side.

The gap statement in section 3 reads as a static residue ("keeps its stale
stored name"). It should read: an unresolvable-id member is stale after every
rename until someone opens the panel.

## T7. HIGH - a second uncovered population the gap statement omits: bare-phone RELAY members

Section 3 names one gap: an un-opened `group_text` panel. There is a second, and
it has no convergence mechanism at all.

- A relay member can be added by bare phone: `app/src/services/relayMembers.ts:73-80`
  `parseRelayMember` sets `contactId: contactId ?? ''`, and
  `app/src/services/rosterProvision.ts:116` writes `contactId: member.contactId ?? ''`.
- 5.1 leaves such a member alone: "A member with no `contactId` (bare phone,
  `''`) keeps its stored name."
- `app/src/routes/relayGroups.ts:470` returns them untouched: `if (!member.contactId) return member;`.
- There is no relay analogue of `api.ts:2058`'s phone resolution and no relay
  write-back, so nothing ever converges them.

Their stored name is permanently stale on every surface, regardless of any panel
being opened. S5 can in principle size it (walked minus "carrying a contactId"),
but the spec does not say so and does not state the population.

## T8. MEDIUM - S2's mandated comment amendment would write a false statement into the code

S2: "**`GroupTextView.tsx:191-211`** ... Once the header is hydrated its
`changed` flag goes permanently false. That is fine, but the comment stops
describing reality and is amended."

It does not go permanently false, and the exception is exactly section 3's gap
population. The two sides resolve by different keys:

- the header will be hydrated by `contactId` (5.1);
- the panel resolves by PHONE (`app/src/routes/api.ts:2058` `findByPhone`);
- the client compares by PHONE
  (`dashboard/src/routes/conversation/GroupTextView.tsx:215`).

For a member whose `contactId` points at a nameless stub, header hydration
misses and the panel hits, so `changed` is TRUE - which is the client
convergence still covering the gap, and is good. The instruction as written
tells a builder to replace an accurate comment with an inaccurate one, on the
one component whose comment already reasons correctly about this.

## T9. MEDIUM - S4's masked-posture guarantee is not delivered by its mechanism

S4 and the risk row "Un-masking a persisted voice label" rest on pinning
`contactShortName` ("First L.") as rung 1 of `maskedPartyLabel`.

Rung 2 is `member.name` - a FULL name (`app/src/routes/webhooks/voice.ts:117`
today, and section 3's chain keeps it). The output is persisted as
`call_party_label` (`voice.ts:993-1002`). So after S4 the same person is stored
"Alice N." when the contact read succeeds and "Alice Nguyen" when it does not,
and the masked posture `voice.ts:144-146` asserts holds on one path only.

Main is at least consistent here (always the full stored name). Holding the
stated posture requires masking rung 2 as well; the spec should either say so or
drop the claim that the flip protects the masking.

## T10. MEDIUM - section 3's rung-3 claim is false for two readers in v3's own client list

Section 3: "Rung 3 already exists client-side (`dashboard/src/lib/groupThread.ts`
`groupMemberLabel` ...), so a server that returns no name still renders a number
rather than a blank."

Both of these are in 4.2's CLIENT list:

- `dashboard/src/routes/shared/rosterPeople.ts:28` -
  `label: m.name ?? contactId`. The fallback is a raw CONTACT ID, not a number.
- `dashboard/src/lib/memberAttribution.ts` `senderLabel` with the default
  `kind: 'relay'` returns `undefined` for a nameless member, deliberately -
  invariant 6, argued at length in its docblock and cross-referenced by
  `recipientLabel.ts:95-99`, the very comment section 3 cites as preserved.
  Relay attribution chips render NOTHING, not a number.

Section 10's `relayGroups.ts` test rationale inherits the error ("no name at all
when neither exists, so the client renders the number"). Rung 3 is a property of
two client helpers, not of the client.

Note this is a claim error, not a regression: rung 2 shrinks the nameless
population relative to main. But the spec uses rung 3 to justify the shape of
rung 1-2, so the justification should be accurate.

## T11. MEDIUM - "reconcile onto one rule" is not achieved for the route 2.1 names

2.1 frames the work as "reconcile these onto one rule". 4.2 marks
`routes/api.ts:2017-2117` "already resolves; reconcile". S2's actual instruction
is to change nothing there but a comment.

That route's rule differs from `withLiveNames` in three ways, all of which now
show as divergence between the group-members PANEL and the hydrated HEADER of
the same thread:

- it resolves by phone (`:2058`), not by contactId;
- it joins without part-wise trimming (`:2081-2083`), where
  `contactDisplayName` trims each part (`app/src/lib/contactName.ts:69-71`);
- it uses a soft-deleted contact's name (T2), where 5.3 refuses to.

Say "reconcile the other surfaces TO it, and here is where they still differ",
or reconcile it. The word "reconcile" in a table row that produces one comment
edit will read to a builder as work that was done.

## T12. MEDIUM - `relayGroupDuplicates` is handed to a branch that has no task for it

Round 2's adjudication moved it IN scope ("`relayGroupDuplicates` moves IN
scope", R7). v3 2.3 moves it back out on a new basis: "it rides the same
`RosterPreview` object `rosterEdits.ts` builds, which is phase-b's file - so it
follows that branch, not this one."

`services/relayGroupDuplicates.ts` appears nowhere in phase-b's plan (zero
matches, same grep as T5). Phase-b modifies the CONSUMER (`rosterEdits.ts`), not
the PRODUCER. So the one-dialog-two-name-sources defect R7 established has been
assigned to a branch whose plan does not contain it, and 2.3 says "Filed, not
fixed" without naming the issue it is filed against.

Either name the issue file, or note in 2.3 that phase-b's plan would have to
grow a task for it.

## T13. MEDIUM - 5.4's own standing requirement is not discharged for `rosterEdits.ts`

5.4 is a standing rule: "Every comment this branch makes wrong is amended in the
same commit that makes it wrong."

`app/src/services/rosterEdits.ts:437-441` documents the two-source split - "the
owner path composes the body from `resolveRoster` (stored names) and the
recipient list from `describeRoster` (backfilled names)" - and `:425-426`
describes the recipient name as one that "may be backfilled from the contact and
so differ from the body name".

S3 changes one of the two sources: after the flip, `describeRoster` names are
contact-FIRST, so the documented "may differ" widens from "differs only when the
roster row had no name" to "differs whenever the contact was renamed". v2 owed
these amendments through S4; the cut removed S4 and the obligation went with it,
but S3 still makes the comments stale.

This is the fourth instance of the pattern 5.4 was written for, and it survived
the commit that wrote 5.4.

## T14. MEDIUM - S5's timing is unspecified, and the disposition depends on it

Section 9's disposition for `today-contact-hydration-fan-out` is "measured, then
resolved", and section 3 says S5 sizes the roster gap. Neither says WHEN the
audit runs.

A run before the branch merges measures the baseline the gap statement needs. A
run after it merges measures residue, against which "S5 sizes the gap" is a
different and weaker claim - and this branch's own hydration does not change
STORED data, so the numbers are stable either way EXCEPT for the group-members
write-back, which fires whenever a panel is opened. Say pre-merge, and record
the number in the Resolution stamp.

## T15. LOW - a padded-name divergence remains inside `group_text`

`app/src/routes/api.ts:2081-2083` joins first and trims the outside;
`app/src/lib/contactName.ts:69-71` trims each part before joining. Both will
render the same thread's members after this branch (panel vs hydrated header),
so a contact with a padded `firstName` shows an interior double space on one and
not the other. Pre-existing in kind, newly visible side by side. Worth one line
in the S2 reconciliation note rather than a fix.

---

## Contesting the adjudications

**R11's sequencing half - CONCEDED, and moot.** The rejection is right on its
own terms: S6 was a deliverable of this branch, so gating a design constant on
it stalls the build behind its own output, and "state the cap as PROVISIONAL"
was my own fallback. It is also moot in v3, which has no cap. The distinction
the rejection draws does hold for section 3's gap statement, which depends on S5
only for a NUMBER, not for a design constant - that is a legitimate forward
dependency and I am not objecting to it (T1 objects to whether S5 can produce
the number, not to the ordering).

**No other rejection outstanding.** A1's partial rejection is now VERIFIED and
correct from my side: `app/src/services/groupMembers.ts:105-119` does mint a
real stub row, so "resolves to NOTHING routinely" was over-broad. That same fact
is what makes T1 a finding.

---

## Verified in v3, no finding

- S1's zero-new-reads premise, re-checked a third time: memo
  `app/src/routes/today.ts:356-369`, gate `:743`, emit loop `:778`.
- S1's `nameFromContact` resolution of R15 is correct: `today.ts` holds a full
  `ContactItem` from its own memo, so nothing forces the canonical helper and
  the same-page split is avoided.
- S4's "both already hold the contact" claim: `webhooks/twilio.ts:728`,
  `:1814-1818`; `webhooks/voice.ts:980-982`, `:990`. Both flips are read-free.
- 5.1's signature now matches the primitive
  (`app/src/repos/contactsRepo.ts:597`), and the bare-phone rule and the
  section-10 test agree (R12 closed).
- 5.2's widening remains feasible: `ContactDisplayItem` declares
  `firstName?: unknown; lastName?: unknown`
  (`app/src/repos/contactsRepo.ts:296-302`).
- Dropping the phone rung removes R2, R9, R10 and R20 cleanly; no residue of it
  survives in 5.1 or section 10.
- 4.1's writer list now carries the two email-path writers
  (`routes/contacts.ts:1909-1912`, `services/inboundEmail.ts:909-917`).
- Seed boundary with phase-b is clean: this branch touches
  `lib/seed/performance.ts`; phase-b's plan touches `matrix.ts`, `live.ts`,
  `lean.ts` (its lines 610-611). No overlap.
- `jobs/tourReminders.ts:1151-1162` reads length and pool number only, for the
  third time.
