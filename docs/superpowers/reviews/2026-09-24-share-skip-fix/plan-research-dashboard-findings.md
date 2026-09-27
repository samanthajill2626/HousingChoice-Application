# Plan research - dashboard and e2e findings against spec v7 (D5-D8)

Date: 2026-09-25. Branch: `feat/share-skip-fix` at `409540ac`.
Spec: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md`, checked as committed
at `409540ac`. The uncommitted edits in the working tree while this was written
change sections 1, 2 and 8, Appendix A, and D1, D2, D9 and D10. They leave D5-D8 as
they were. Spec text below is cited by decision and bullet, not by line number,
because those edits move the lines.
Scope: claims in D5-D8 (and the section 5 surface list) checked against the
dashboard and e2e code. Read-only research; nothing was edited or run. The
byte-exact code reference for the plan is the gitignored
`.superpowers/sdd/dashboard-reference.md`.

D6, D7 and D8 hold against the code as written (details in the reference file).
The four findings below are all on D5.

## F1 (medium) - D5 says a hand-picked tenant "starts checked"; the in-session add path starts a flagged one UNCHECKED

D5, third bullet ("Everything else about the review list is unchanged, with one
fix: ..."), lists as unchanged behavior that "a seeded row (the one-to-one tenant,
or a hand-picked tenant) starts checked".

- A hand-picked tenant is added in the review step by `addTenant`. A flagged pick is
  appended with `checked: !already` (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:210`,
  `already = priorIds.has(candidate.contactId)` at `:201`, `added: true` at `:211`). So
  a hand-picked tenant who is "Already sent" starts UNCHECKED.
- This is pinned: `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx:251-267`
  ("annotates a manually-added tenant already-sent via priorRecipientContactIds (unchecked)").
- The same tenant starts CHECKED only after the draft is previewed again. The add
  persists the pick to the draft's `seed_contact_ids` (`RecipientPreview.tsx:215-220`), the
  server then returns it with `seeded: true` (`app/src/routes/broadcasts.ts:545-548`), and
  `initialRows` pre-checks seeded rows (`RecipientPreview.tsx:79`). One tenant can
  therefore start unchecked or checked depending on whether the operator went back
  and previewed again.
- The row model has no `seeded` field (`RecipientPreview.tsx:34-46`). `selectAll`
  (`:151-155`) cannot tell a seeded row from any other today, so the D5 fix ("Select
  all skips flagged rows EXCEPT seeded ones") needs a new field. The plan also has to
  decide whether an `added` row counts as seeded.

Why it matters: I4 ("a seeded row stays checked - through Select all too") depends
on what "seeded" means in the dashboard, and the spec's two readings disagree for
added rows. It does not block Sam's #5: the one-to-one share hides the add-a-tenant
search (`RecipientPreview.tsx:427-453`). It affects blasts and seeded shares that
have been opened to filters.

Resolution: pick one reading and state it in the spec.
(a) A hand-added flagged tenant starts checked, like a preview-seeded row (a
deliberate pick, the same reasoning as the comment at `RecipientPreview.tsx:76-78`),
and Select all treats `added` rows as seeded. This flips
`RecipientPreview.test.tsx:251-267`.
(b) "Hand-picked" means only preview-returned seeds. The in-session add stays
unchecked when flagged, and the spec names what Select all does to a flagged `added`
row.

## F2 (low) - D5 does not name the review note that states the old rule

`RecipientPreview.tsx:334-336` renders (the source uses an em dash and curly quotes):
'Already-sent tenants are unchecked - check one to resend. "Select all" skips them.'
The file header comment (`:8-11`) states the same rule.

After D5 this note is false on exactly the share D5 fixes. On a one-to-one share the
only row is flagged "Already sent" AND checked, and Select all leaves it checked, while
the note beneath the toolbar says flagged rows are unchecked and that Select all skips
them. (The first half is already false today for seeded rows, `RecipientPreview.tsx:79`.)

Neither D5 nor section 5 lists this copy. D8's "no new words" applies only to D8, so
the plan needs a copy decision here. This is dashboard copy, not message-catalog copy.
No unit or e2e test pins this text (no grep hits in `dashboard/src` or `e2e`).

## F3 (low) - a second reader of the "already sent" set is not named

The dashboard reads the prior-recipient set in two places:
- the per-candidate flag, `alreadySentThisProperty` (`app/src/routes/broadcasts.ts:542-544`),
  through `initialRows`;
- the hand-add annotation: `preview.priorRecipientContactIds`
  (`RecipientPreview.tsx:92-95`, used at `:201`), returned at
  `app/src/routes/broadcasts.ts:564`.

Both come from ONE repo call (`app/src/routes/broadcasts.ts:516-519` ->
`app/src/repos/broadcastsRepo.ts:524-550`; the union loop is `:536-539`). Section 5 lists
"already sent (D5)" as a single reader. If the skipped-slot filter goes into the
route's per-candidate expression instead of the repo union, a hand-added tenant whose
only earlier slot was `skipped` would still show "Already sent" and start unchecked.

Resolution: the plan should put the rule inside `priorRecipientContactIds` so both
readers get it, and add a hand-add case to the tests.

## F4 (low) - D5's reason for still counting `failed` does not fit three app-internal failure codes

D5, second bullet, keeps `failed` "on purpose: a failed text may have been delivered
by a retry the share never hears about". Three failed slots the fan-out writes itself
were never sent, and nothing retries them:
- `failed/no_contact`: no contact or phone was resolved, so no send was made
  (`app/src/jobs/broadcastFanOut.ts:367-368`).
- `failed/transient_cap` and `failed/enqueue_failed`: `closeBroadcast` overwrites slots
  that are still non-terminal (`:274-289`, called at `:348`, `:593`, `:602`, `:623`).
  Those slots were left `queued` after a transient send error
  (`:546-551`) or were never reached. `dashboard/src/routes/contact/deliveryStatus.ts:896-906`
  describes both codes as "legs still deferred" and "could not be scheduled at all".

Under the interim rule these tenants stay "Already sent" and start unchecked on the
next share of the property, although no text was attempted or accepted. This is the
same harm D5 fixes for `skipped`. It is bounded, and "staff can tick them by hand"
still applies.

Resolution: either (a) record it as accepted in section 8 next to the existing
interim-D5 tradeoff, or (b) exclude `failed` slots that carry `no_contact`,
`enqueue_failed` or `transient_cap` from the union, matching D5's own principle ("no
text was attempted for them").
