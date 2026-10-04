# Code review - adversarial, plan-blind - voucher-size fallback fix (feat/properties-available-view)

Reviewer: adversarial plan-blind reviewer (Claude Opus 5.5).
Scope: 71e532fb..HEAD at 8c8c4270 (the fix-beds package: dee9da10, 63e53e8a,
8c8c4270 and docs). No specs or plans were read.
Method: code reading and repo-wide greps for every reader of a property's
`voucher_size_accepted` or `beds`, in the dashboard and in `app/src`. No test
suite or probe file was run, because the gates were running in this worktree;
one `node -e` regex check is cited where it is used.
Versions: react / react-dom 19.2.7, react-router(-dom) 7.18.0.

Severity = consequence if it ships unfixed. **4 findings: 0 BLOCKING, 0 HIGH,
0 MEDIUM, 4 LOW.**

The core rule holds. `acceptedVoucherSizes` (`dashboard/src/routes/listing/listingFormat.ts:100-106`):
- returns a recorded value with at least one finite size;
- otherwise returns finite `beds`;
- otherwise returns `[]`.

`unitVoucherBuckets` reads only through it (`dashboard/src/routes/listings/unitListFacets.ts:176-183`).
So the filter, the summary counts and the not-counted note all come from one source.

The remaining readers that derive a property's voucher size on their own are all
tracked in `docs/issues/unit-voucher-size-readers-diverge.md`:
- the Matching pre-fill and tag (`BroadcastComposer.tsx:219-226`, `AudienceFilters.tsx:62-64`);
- the public flyer (`app/src/lib/unitFields.ts:294-306`).

Every other `beds` reader shows bedrooms as a fact rather than a voucher size:
`LandlordFile.tsx:85`, `TourDetail.tsx:609`, `buildListingFacts`, `mergeFields.ts:64`,
`resolveTemplate.ts:88`, and the `similarUnits.ts` scoring.

---

## FB-1. LOW - Two "the note is gone" assertions became vacuous when the copy changed

**What is wrong.** The not-counted note now reads "... no voucher size or bedroom
count recorded ..." (`dashboard/src/routes/listings/AuthoritySummary.tsx:119-120`).
But the test that checks the note is absent still queries `/no voucher size recorded/i`,
before any size filter and after Not recorded is selected
(`dashboard/src/routes/listings/ListingsList.test.tsx:735` and `:742`). That pattern
cannot match the new sentence. A `node -e` check gives `false` for both the singular
and the plural copy.

**Consequence.** Neither "no note before a size filter" nor "the note disappears once
Not recorded is selected" is pinned in the rendered component any more. A regression
that leaves the note on screen still passes. The model-level 0 is still pinned in
`unitListFacets.test.ts:262-267`; the rendering is not.

**Suggested fix.** Query on a fragment both versions share, e.g. `/is not counted|are not counted/i`,
or the exact new sentence.

---

## FB-2. LOW - Neither the note's new promise nor recorded-over-beds is pinned where the comments say; docs lag the server

**(a) Nothing tests the note with a beds-only property.**
- No summary fixture has `beds`: `unitListFacets.test.ts:227-234`, and `SUMMARY_UNITS`
  at `ListingsList.test.tsx:48`.
- So nothing pins the note's new promise: a property with `beds` that a different
  size chip leaves out must NOT be counted as having "no voucher size or bedroom count".
- A regression that counts excluded properties by their RECORDED size alone would
  pass, and the note would then wrongly blame missing data for imported properties.
- Add a beds-only unit excluded by another size and expect it not to be counted.

**(b) The e2e step cannot tell the two rules apart.**
- Step 6 says the property "whose RECORDED size is 3 drops out" under 2-BR
  (`e2e/tests/dashboard-next/properties-available-view.spec.ts:187-190`).
- That property also has `beds: 3` (`spec:106-109`), so it drops out whether the
  recorded size or the bedroom count decides. Recorded-over-beds is pinned only in
  jsdom (`ListingsList.test.tsx` "a recorded size wins", unitListFacets "a recorded
  voucher size wins over beds").
- Give `both` a bedroom count different from its recorded 3, e.g. `beds: 2`. Then
  steps 4 and 6 fail if beds ever wins.

**(c) Some docs still lag the change.**
- **Docblock and GLOSSARY.** `listingFormat.ts:91-95` and
  `documentation/GLOSSARY.md:326-327` say server code gets the twin "when it first
  needs one". Server code already derives a property's voucher size today: the
  flyer's `voucher_size: beds` (`app/src/lib/unitFields.ts:294-306`). The issue file
  states this correctly.
- **AuthoritySummary comment.** `AuthoritySummary.tsx:114-115` still explains the note
  as "only because nobody recorded their size".

---

## FB-3. LOW - A recorded voucher size now overrides beds, but nothing can clear it

**What is wrong.** Before this change the recorded field was the only source; now it
outranks `beds` (`listingFormat.ts:103-105`). But it can never be unset:
- the edit form skips an emptied number ("clearing a number isn't supported",
  `dashboard/src/routes/listing/ListingEditForm.tsx:101`);
- the unit API's `number` kind rejects `null` (`app/src/lib/unitFields.ts:165-167`).

**Failure scenario.** Once anyone records a size for a property - a guess, a typo, or
a value that later goes stale - the bedroom fallback never returns for it. A later
correction of `beds`, by hand or by re-import, no longer moves the property between
chips. Staff can only overwrite the number, never return to "use the bedrooms".

**Suggested fix.**
- Give `voucher_size_accepted` a clear-to-absent kind, as `tour_type` maps `''`/`null`
  to a REMOVE (`unitFields.ts:180-195`), and let the edit form send it.
- Or record the limitation in the #12 issue. #12's multi-select could treat an empty
  list as "not recorded", which `acceptedVoucherSizes` already does.

---

## FB-4. LOW - The property page shows no voucher size where the list files the property under a bedroom chip

**What is wrong.** The property page shows "Voucher size accepted" only for a
recorded number (`dashboard/src/routes/listing/ListingDetail.tsx:752-754`). A
beds-only property - which every imported one is - therefore shows no voucher size,
while the Properties list files it under its bedroom chip. Staff who open a property
from the 3-BR filter see no voucher size and can read it as unknown.

**Assessment.**
- Reading the raw field is right for the New and Edit forms: they edit what was
  recorded.
- For display, the page no longer says what the list uses.

**Suggested fix.** Keep the raw row for editing, and add an effective line read
through `acceptedVoucherSizes` with its source, e.g. "Voucher size: 3-BR (from
bedrooms)".
