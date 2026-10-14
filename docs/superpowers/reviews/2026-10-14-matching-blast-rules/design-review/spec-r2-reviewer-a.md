# Design review r2 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md` rev 2
(@31930df2; diffed against rev 1 @002a34ce). Read alongside
`spec-r1-reviewer-b.md` and `adjudications.md`. Nothing was run. Every claim
about current behavior cites a file:line read in this worktree.

The two product rulings (blank-authority tenants left out and captioned; reach =
default-checked count) are taken as given, not contested. The findings below
are about the mechanisms rev 2 uses to deliver them, and about rev 2's own new
text.

Ordered by severity. Findings 1 and 2 are new defects introduced by rev 2's
rewrites.

---

## 1. [MEDIUM] "Select all uses the server's `checkedByDefault`" breaks the promoted-row rule (share-skip-fix D5), and the note rev 2 keeps on screen becomes false

**What is wrong.** D5 (rev 2): "The dashboard uses `checkedByDefault` for the
initial state and for Select all and no longer computes the rule itself; the
only client-side default left is a row added with Add a tenant, which starts
checked."

There is a third case the spec does not name. Picking an ALREADY-LISTED tenant
in Add a tenant does not add a row. It PROMOTES the existing row to a seed and
checks it (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:294-301`,
`{ ...r, seeded: true, checked: r.hasConsent }`). Today Select all keeps it
checked because the client rule reads `seeded` (`:99-101`, `:243-245`). Under
rev 2, Select all reads the server's flag. The server computed that flag at
preview time, when the row was not seeded and was held, declined or already
sent, so the flag is `false`, and Select all UNCHECKS the tenant staff just
picked by hand.

That contradicts:
- D4: "A hand-picked tenant (... or Add a tenant) is never held";
- the note D7 keeps "as is": "Flagged recipients you picked stay checked;
  'Select all' skips the others."

An existing unit test pins exactly the behavior rev 2 breaks:
`RecipientPreview.test.tsx:315-360` ("promotes that row to a seed - checked,
still flagged, kept by Select all"). Section 7 lists `RecipientPreview.test.tsx`
only for `checkedByDefault` and `:982-988`. A builder following the spec will
"fix" this test into the regression.

D5 also never says what Select all does to a row ADDED by Add a tenant, which
has no server flag at all.

**What it implies.** The dashboard cannot drop its own rule entirely. State
Select all as `seeded-in-session ? hasConsent : checkedByDefault` (or set
`checkedByDefault: true` on promotion and on add). Name the promotion case in
D5 and D7, and add `:315-360` to section 7 as a test that must keep passing.

---

## 2. [MEDIUM] The prefill "settled" gate has no exit when the property fails to load, and it is unconditional where no property exists

**What is wrong.** D3 Timing (rev 2): "Preview stays disabled until the prefill
has settled - the property is loaded and the organization list has loaded or
failed." The organization list gets a failure exit. The property does not:

- A failed property load is swallowed today on purpose:
  `/* property load failed - compose still works without the pre-fill */`
  (`BroadcastComposer.tsx:212`). Under the new gate, that failure leaves Preview
  disabled forever, with no message and no retry. That is a regression from
  today's behavior.
- A resumed draft (`?draftId=`) never has a property on the client.
  `effectiveUnitId` is undefined (`BroadcastComposer.tsx:417` skips the property
  step for a resume), so `unit` stays null and "the property is loaded" never
  becomes true. Read literally, the gate makes a resumed draft impossible to
  preview. Today it can be previewed once a body is typed (`canPreview`,
  `:388-394`).
- The Timing paragraph is not scoped to "the composer has a property and the
  filters are on", which is the condition the prefill itself uses (D3 first
  paragraph). So in seeds-only mode (filters off, a tenant-page send), Preview
  would wait on an organization-list read that send never uses.

**What it implies.** Scope the gate to "a property is attached and the filters
are on". Count a failed property load as settled: no authority prefill, plus a
notice, mirroring the list-failure notice. Say that `?draftId=` and seeds-only
mode are not gated.

---

## 3. [LOW] Reach-at-create runs the full rules read on every debounced MESSAGE edit, and widens a read the code says belongs to the preview alone

**What is wrong.**

- The coordinator brief and rev 2's D8 frame this as "draft create on every
  debounced filter change". The draft's material key includes the message
  body (`useComposerDraft.ts:88-100`, `b: input.bodyTemplate.trim()`). So every
  pause in typing (600 ms) recreates the draft. That now runs the org-wide
  open-tours read (four partition queries, unbounded), `effectiveDeclines`, and
  `priorRecipientKeys`. `priorRecipientKeys` walks every share of the unit and
  resolves each share's recipient states WITH record reads
  (`app/src/services/shareRecipientState.ts:249-263`).
- The reach does not depend on the body, yet every body edit recomputes it.
  `canPreview` requires `!draft.reachPending` (`BroadcastComposer.tsx:388-394`),
  so Preview waits for each recompute.
- The router documents the attempt-record read as preview-only: "the composer
  flag ALONE reads a queued slot's send-attempt record; no other route reads
  it" (`broadcasts.ts:111-114`, `:757-760`). Rev 2 moves that read into create
  without saying so, and section 7 does not list the comments.
- For a `seeds_only` draft, `checkedByDefault` is `hasConsent` alone (D5), so
  the reads cannot change its count. Read literally, D8 still runs them, and
  omits the estimate when one throws (see finding 4).

Goal 5's equality also holds only at the instant of create. The reach line is
not refreshed until a material change, and the preview serves at most 1000 rows
(`broadcasts.ts:785`) while create counts the whole union.

**What it implies.** Low cost at today's volume, but the spec should choose
deliberately. Options: compute the reach only when the audience inputs change
(unit, filter, seeds), or state the per-keystroke cost; skip the rules reads
for `seeds_only` creates; update the "ALONE" comments; and word goal 5 as
"equal when computed".

---

## 4. [LOW] Draft `stats.audience` changes meaning for readers section 7 does not list

**What is wrong.** `estimatedAudience` is stored as the draft's `stats.audience`
(`broadcastsRepo.ts:722`), and drafts show their stored stats
(`broadcastsRepo.ts:266-268`). After rev 2 that value is the default-checked
count, or 0 when a rules read throws (the estimate is omitted and `zeroStats`
stays). Unenumerated readers:

- `BroadcastsList.tsx:47`: a seeds-only row reads `To N recipients`. A 1:1
  draft to a tenant without consent now reads "To 0 recipients". So does any
  seeds-only draft created while a tours or decline read failed, although the
  reads cannot change its count (finding 3).
- `BroadcastsList.tsx:221`: `0/N delivered`.
- `BroadcastResults.tsx:208` and `StatChips.tsx:40`: "Recipients".

**What it implies.** Either keep the reads out of seeds-only creates and say
what the Drafts list shows, or store the estimate separately from
`stats.audience`. Add the readers to section 7.

---

## 5. [LOW] The section 7 rewrite still misses what D8 and the "lane-independent" ruling require

**What is wrong.**

- `org-lists.spec.ts:361` ("Reaches 2 recipients") and `:477` ("Reaches 1
  recipient") count tenants created WITHOUT consent (the helper at `:113-136`
  records none). Under D8 a no-consent row is not checked by default, so both
  read "Reaches 0". The ruling ("e2e tenants get an explicit on-list authority
  and status") does not mention consent.
- "An explicit on-list authority" does not make a spec independent of lane
  leftovers unless the authority is run-unique (`addOrg`, as org-lists already
  does). With `Atlanta Housing Authority`, the scenario specs' Searching,
  Atlanta, 2-BR tenants (`e2e/tests/scenarios/sending-unit.spec.ts:58-66`)
  join every such audience. That defeats the ruling's own "no spec may depend on
  tenants another spec left in the lane" for any exact count or Send-count
  assertion. The new e2e spec should also say its two authorities are
  run-unique.
- `RecipientPreview.test.tsx:315-360` (finding 1).
- Section 7 says the harness fake needs "its `listByType` status support". The
  fake already filters by status (`app/test/helpers/twilioWebhookHarness.ts:2327`).
  What it lacks is range-key ORDER: it returns seed-array order, and its own
  comment defers to `contactsPartitionFake.ts` (`:2330-2341`). So the D1
  "searching read first" unit test cannot be proved on the harness. It belongs
  on `app/test/helpers/contactsPartitionFake.ts`.

**What it implies.** Add consent and run-unique authorities to the e2e ruling.
Correct the fake item, and name the partition fake as the place to test order.

---

## 6. [LOW] The fail-closed boundary leaves the third default-check input failing open, now into the reach count too

**What is wrong.** D5 fails closed when the tours or decline read throws,
because "serving one would check people the rules leave out". `checkedByDefault`
has a third input, `alreadySent`, from `priorRecipientKeys`, which never throws:
a failed `listByUnit` read logs a WARN and returns a PARTIAL set
(`shareRecipientState.ts:264-266`). So a throttled read silently checks tenants
who were already sent this property, in the preview and now in the reach count.
This is today's preview behavior, but rev 2 states one rule for all three
inputs and fails closed on two.

**What it implies.** Either state this as an accepted exposure in section 4, or
make the already-sent read report failure and treat it like the other two.

---

## 7. [LOW] Edited filters carry over silently to a new property, while an edited message is reset with a confirm

**What is wrong.** D3: changing the property re-applies the prefill "unless that
filter has been edited since the last prefill". So a staff edit made for
property P1 (say, authorities trimmed to A) silently targets P2, which may
accept only C. That P2 blast then excludes every tenant in C, and its only
signal is the generic caption. The same component treats an edited MESSAGE the
other way: "An edited message was written for THIS property, so confirm the
discard" (`BroadcastComposer.tsx:333-342`).

**What it implies.** Decide whether "Change property" ends filter ownership, as
it does for the message, or keeps it with a visible hint. State the choice.

---

## 8. [LOW] The new caption's second sentence covers only blank authorities

**What is wrong.** D2 (rev 2) leaves out "a tenant with no housing authority (or
a value that is not a member)". D8's sentence names only "tenants with no
housing authority recorded". A tenant holding an off-list value that the org
cleanup could not resolve (reviewer B r1 #1, `app/scripts/clean-org-names.ts:15-18`)
is also left out while a list is selected, and the caption does not say so.

**What it implies.** Worth one word: "no housing authority, or one not on the
organization list".

---

## Adjudications contested

- A7a (redesign the hold clock to the latest Interested click): concede. The gap
  is now stated in sections 2 and 4.
- A7b (read units in the hold): concede. It is stated as an exposure.
- No other finding of mine was rejected.

## Round 1 fixes: correct, or merely plausible?

- A1 (no-authority tenants): correct to the ruling. The caption is incomplete
  (finding 8).
- A2 (inventory): plausible. Still incomplete for consent, run-unique
  authorities, the promotion test and the harness ordering (finding 5).
- A3 (seeds-only previews): correct for the preview. Create still runs the reads
  for seeds-only drafts (findings 3, 4).
- A4 (path (c)): correct. The set is stated, consent and already-sent are kept,
  and the cap is after the exclusions.
- A5 (truncation copy): correct.
- A6 (Available-only on every entry): correct as ruled.
- A8 (no read cap): correct. The partition claim is fixed.
- A9 (accessible-name format): correct and literal. The existing two-cue strings
  are unchanged.
- A10 (prefill edges): the list-failure, all-off-list, 422-as-edit and
  shape-cap edges are correct. The settle gate is not (finding 2).
- A11 (backdated request): correct. A fresh request is used, and the boundary is
  unit-tested.
- A12 (caption wording): correct.
- A13 (wire normalization): correct. The server sends one shape and the
  dashboard has no twin.
