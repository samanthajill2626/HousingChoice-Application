# D7 - S5 Tasks 5.1-5.2: decisions record

Dispatch D7 of the feat/last-heard-from build (implementer, 2026-10-13).
Scope: the rebuilt send-roster row (`SendRosterRow`, two lines: identity +
dates, outcome chip + actions) with its CSS and the interim host wiring, and
the per-row setters on `useListing` and `useContactFile`. Plan:
`docs/superpowers/plans/2026-10-12-last-heard-from.md` (S5 Tasks 5.1-5.2;
sections 3.3, 3.4 #1/#4/#9/#10; contract notes N1/N2). Binding corrections
applied: outcome-F2 and outcome-F3 (5.1).

## Commits

- c028ddbd Task 5.1 - `dashboard/src/routes/contact/Card.tsx`
  (`SendRowAction` :215, `interestedModeOf` :220, `SendRosterRowProps` :224,
  private `OutcomeChip` :257, `SendRosterList` :285, `SendRosterRow` :301,
  `<li>` root :332, date spans :342/:344, inline alert :398);
  `Card.module.css` (new rules :219-327); interim hosts
  `dashboard/src/routes/listing/ListingDetail.tsx` (clock :248, list :1143),
  `dashboard/src/routes/contact/TenantFile.tsx` (clock :147, list :316),
  `dashboard/src/routes/contact/PartnerFile.tsx` (clock :83, list :176); new
  `dashboard/src/routes/contact/SendRosterRow.test.tsx`; knowing rewrites in
  `dashboard/src/routes/listing/ListingDetail.test.tsx` (findings C2).
- f82317d9 Task 5.2 - `dashboard/src/routes/listing/useListing.ts`
  (`ListingState.setRecipientRow` :61, `LOADING` :78, state generic :142,
  callback :183, returns :260-261);
  `dashboard/src/routes/contact/useContactFile.ts`
  (`ContactFile.setListingSentRow` :109, callback :126, returns :229-230);
  tests `useListing.test.tsx:241`, `useContactFile.test.tsx:191`;
  `ListingDetail.test.tsx:84` READY gains the new setter.

`npm run typecheck` exited 0 after each commit.

## RED / GREEN evidence

- Baseline (before any edit): 7 host/related dashboard files, 289/289.
- 5.1 RED: 20/20 failed for the stated reason (`SendRosterList` and
  `interestedModeOf` not exported - "Element type is invalid ... undefined",
  "interestedModeOf is not a function").
- 5.1 host check before the rewrites: exactly the two ListingDetail cases
  the plan predicted failed (the textContent-equals-name pin; the tour-chip
  case whose untyped rows carried no `outcome`).
- 5.1 GREEN: SendRosterRow 20/20; the 8 affected files 309/309.
- 5.2 RED: 2 failed ("setRecipientRow is not a function", "setListingSentRow
  is not a function"). GREEN: the same 8 files 311/311.

## Decisions and divergences (all contract-preserving)

1. outcome-F3 / contract N1: both date spans spread `title` only when it is
   non-empty (`Card.tsx:342`, `:344`), never `title=""`. Added case
   `SendRosterRow.test.tsx:90`: a never-heard row's "Last heard from" span
   has no title attribute, and the "Sent" span does carry its stamp.
2. outcome-F2: the partner case's negative anchors on the Interested name
   (`SendRosterRow.test.tsx:129`); the unanchored form would also match the
   required Not interested button.
3. Plan 3.4 #1 held: there is no `onRequestTour`; `requestTourTo` renders a
   react-router Link (`requestTourReplace` for the property page's
   replace-navigation in 5.3).
4. `Card.module.css:161-163` comment: "plain div" became "plain <li>". The
   plan said no edit was needed, but the old wording became false.
5. Cosmetic: the `kind` prop keeps the existing caseworkers D20 doc text;
   the Request a tour link's class uses the module's `?? ''` idiom; each
   host clock carries a one-line comment; PartnerFile's Card import stays on
   one line; the first two ListingDetail fixture rows were reflowed to
   multi-line objects with the plan's four fields.
6. Interim contact-page rows pass the unit label as both `name` and
   `address`, exactly as the plan's 5.1 text says. Every row is
   `actionsDisabled` until 5.4, so no wrong accessible name is reachable.

## Markup delivered (R1-R3, for S8)

- R1: every row root is an `<li>` inside a `SendRosterList` `<ul>` named by
  its label (`Sent to` on the property page until 5.3 splits it into the
  four groups; `Properties sent` on the tenant and partner pages, final).
  The row's first line is a `<div>` holding the identity link and the kind
  label, so `closest('div')` from the identity link still scopes that line.
- R2: chip text `No reply yet` / `Replied` / `Not interested` /
  `Not interested (auto)`; interested renders the TourChip link (or the
  text `Interested` when the row carries no tour, plan 3.4 #5).
- R3: `Mark <name> interested in <address>`, `Mark <name> not interested in
  <address>`, `Undo not interested for <name>`, link `Request a tour for
  <name> at <address>`; in flight the row's buttons are disabled; a failure
  shows `Couldn't save - try again.` or, after a 503 with `saved: true`,
  `Saved - reload to see the change.` in a `role="alert"` paragraph.

## Lint

`npx eslint` on the 11 touched .ts/.tsx files (both commits): exit 0, no
errors.
