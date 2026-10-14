# Design review r3 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md` rev 3
(@5893da21; diffed against rev 2 @31930df2). Read with the "Spec round 2"
adjudications. Nothing was run. Every claim about current behavior cites a
file:line read in this worktree.

Verdict in one line: the rev 3 edits are sound in their main paths. The three
findings below sit where two rev 3 edits meet, or where the new e2e rule is
stated more widely than it can apply. None is above LOW. I found nothing new
in the rest of the spec that a literal builder would get wrong at MEDIUM or
above.

---

## 1. [LOW] A failed load of the NEW property leaves the OLD property's filters in place, under a notice that says nothing was filled in

**What is wrong.** Two rev 3 edits meet here.

- D3, "belongs to the property": when staff change the property, both prefills
  "are applied fresh from the new property and earlier edits are dropped".
- D3 Timing: "A failed property load counts as settled: nothing is prefilled
  from it" and the filters show "Couldn't load the property, so its housing
  authorities and voucher size were not filled in."

The composer's filter state survives the trip back to the property step. Today
"Change" only clears the pick and the message (`BroadcastComposer.tsx:333-342`);
`filter` is untouched. The fresh prefill can only run once the new unit loads
(`:202-214`). So when P2's load fails, nothing replaces P1's authorities and
voucher size. P2's draft is then built and counted against P1's filters, under
a notice that reads as though the filters were simply left empty.

The rule as written covers only "applied fresh" and "nothing is prefilled".
Neither says what happens to the old values.

**What it implies.** One sentence: on a property change, the filters reset to
empty (and ownership is cleared) at the moment the property changes, and the
new property's prefill then fills them when it loads. A failed load then
leaves visibly empty filters, which matches the notice.

A related nit: "Change" followed by picking the SAME property again also counts
as a change, so staff lose their edits on a round trip that changed nothing.
Say whether that is intended.

---

## 2. [LOW] The new "failed property load" state needs two rules the spec does not state: an aborted load is not a failure, and the state belongs to one property

**What is wrong.** The only failure hook today is the empty catch on `getUnit`
(`BroadcastComposer.tsx:209-213`). It also catches the AbortError raised when
the effect's cleanup aborts the request (`:214`; `dashboard/src/api/client.ts:125`
rethrows AbortError to the caller). An abort happens when:

- the property changes;
- the composer unmounts;
- on EVERY mount in development, because the app runs under StrictMode
  (`dashboard/src/main.tsx:15`), which runs effects twice. The e2e lane serves
  that development build.

A builder who sets "property load failed" in that catch, as the spec's wording
invites, gets two defects. The notice "Couldn't load the property..." flashes
on every composer mount in dev and e2e. And the D3 gate settles early, so
Preview enables before the real load lands and the prefill applies. The
code-review R3-FE-1 guard then drops that preview as "The audience changed -
preview again.", which is a visible stutter that the gate exists to prevent.
And unless the failure is tied to a property id and cleared on success, a
failure for P1 also settles P2's gate.

**What it implies.** Add one sentence to D3 Timing: an aborted load is not a
failure; the failed state is per property and clears when that property loads.
The org list needs no such rule: `useOrgList` already owns its loading and
error states (`dashboard/src/routes/orgs/useOrgList.ts:1-19`).

---

## 3. [LOW] The e2e ruling's "recorded consent" is broader than the specs it governs, two of which need a tenant WITHOUT consent

**What is wrong.** Section 7 (rev 3): "e2e tenants get an explicit status,
recorded consent, and a RUN-UNIQUE on-list authority ... wherever a spec
asserts a count or a list". Two specs the same section names exist to test a
tenant WITHOUT consent:

- `a2p-compliance.spec.ts` section 8.3 test 1 creates `noConsent` on purpose
  (`:331-333`) and asserts its disabled, badged row and the "without recorded
  consent" count.
- `a2p-compliance.spec.ts:445-510` (path (c)) asserts
  `skipped_no_consent === 1`, which section 7 says to keep.

Taken literally, the ruling gives those tenants consent, and both tests stop
testing the consent fence while still passing.

**What it implies.** Add the exception: "except a tenant a spec deliberately
leaves without consent".

---

## Adjudications contested

- R2-3 (reject a separate reach endpoint or a skip-on-body-change protocol):
  concede. I have no measured cost to set against "the same reads one Preview
  click makes" at today's volume, and skipping on a body change would still
  need the server to compute the reach of each recreated draft.
- R2-7 (planner ruling: a property change drops filter edits, no confirm): a
  ruling, not contested. Finding 1 is about what that ruling does when the new
  property fails to load, not about the ruling.

## Rev 3 fixes: correct, or merely plausible?

- R2-1 (hand picks through Select all): correct. Added rows always have
  consent (`RecipientPreview.tsx:283-286`). A promoted row takes `hasConsent`,
  so a promoted no-consent row stays unchecked, as today
  (`RecipientPreview.tsx:300`). The pinned test (`RecipientPreview.test.tsx:315-360`)
  is named as must-keep.
- R2-2 (scoped settle gate): correct in scope (property attached and filters
  on; resume and seeds-only never gated). Its failure state is under-specified
  (findings 1 and 2).
- R2-3 (seeds-only creates make no rules reads): correct. For a seed,
  `checkedByDefault = hasConsent` whatever the reads return, so skipping them
  loses nothing. The cost is stated. Nit: a third "composer flag alone reads
  it" comment at `broadcasts.ts:1108-1111` (the results route) is not in
  section 7's list (`:111-114`, `:757-760`).
- R2-4 (`stats.audience` meaning): correct. The readers are listed; "To 0
  recipients" is accurate for a 1:1 draft to a tenant without consent; and a
  read failure at create stores 0 until the draft is recreated, as stated.
- R2-5 (inventory): correct for the org-lists counts and the partition fake;
  over-broad on consent (finding 3).
- R2-6 (already-sent fails open): correctly stated as an exposure.
- R2-7 (property change): implemented as ruled; see finding 1 for its
  failed-load edge.
- R2-8 (caption): correct. It now covers missing and off-list values.
