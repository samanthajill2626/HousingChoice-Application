# Review R2 - adjudications and the fix-wave-2 list

Date: 2026-09-27
Adjudicator: the build orchestrator (Fable 5.1), overnight unattended rule.
Input: `review-r2-rereview.md` (a fresh reviewer carrying the re-review
charge over the whole feature plus the fix-wave delta 94f89929..359e82c8).

R2 verdict: NO BLOCKING. New: 1 SHOULD-FIX, 4 NOTE. Fix wave 1: 9 correct,
2 plausible-but (F-2, F-9), 0 wrong. Four adjudications contested; every
contest is accepted below.

## Adjudications

| id | grade | disposition | rationale |
|---|---|---|---|
| R2-1 | SHOULD-FIX | FIX (F2-1) | a regression of my own OD-7: the fixed slots cost every Past card ~170px, and the identity-over-meta stacking was keyed to the PAGE at 560px, so in 561-760px panes (a 960px window with the sidebar, a tablet) every tenant name reads "Tas..." - measured, not inferred. The reviewer's fix (a Past-only container block repeating the four stacking declarations, scoped to `.pastRow > .row`) was probed: full names, no overflow, the F-1 pin still holds. I widen the threshold from the proposed 760px to 800px: at 761-800px the probe still shows the name cut to "Tasha Ng..." (86px against 95px needed); a stacked row is better than a cut name, and the page-level 560px rule stays unchanged for Active/Closed. Pin: an e2e check at a 960px viewport (pane in the band) that no text inside any Past row card is clipped |
| R2-2 | NOTE | DONE (orchestrator) | `docs/issues/tours-patch-status-precondition.md` filed in this commit, carrying the adversarial reviewer's P2 facts (canceled -> toured and no_show -> toured are 200 with a "Tour took place" milestone; a rebooked tour's fresh ladder is swept) and the ConditionExpression design |
| R2-3 | NOTE | FIX (F2-3) | contest ACCEPTED: `ContactDetail.tsx:530-536` returns its spinner while `useContact` derives loading, so the file pane (and the card) unmounts on every contact switch; X-1's premise was wrong. The key stays (harmless, defensive) and the three comments are reworded to the true mechanism; the test keeps pinning that the editor state does not cross contacts under TenantFile's own render |
| R2-4 | NOTE | FIX (F2-2) | the fix-wave implementer's own "least sure" item, now bounded: one release point means a throw outside the two per-id try blocks wedges every Past view in the tab until a reload. Two-part fix: (a) the per-id guard phase (the re-read AND the status/time comparison) lives in one try so a malformed re-read reads "Could not check the tour" instead of throwing (no result is ever silent); (b) the runner's publish/reload tail and the flag release sit in `try { ... } finally { setBatchRunning(false); }`. A hung request still holds the flag until it settles (inherent; hosted envs bound it at CloudFront's 30s) - named in the handback |
| R2-5 | NOTE | RECORD | pre-existing class (every in-place `setContact` caller); no data loss; a write token in `useContact` is its own change; named in the handback |
| C-7(ii) | NOTE | contest ACCEPTED - "accepted as specified", not "superseded" | F-7 moved the flag and the reload slot, not the results; a batch that straddles a view or route change never shows its results, which is what spec 4.5 says ("until the next batch, a view change or a navigation away"). Recorded, not fixed |
| OD-7 scope | - | contest ACCEPTED | see R2-1 |
| A-2 filing | - | contest ACCEPTED | see R2-2 |
| F-11 residue | NOTE | RECORD | `routes.ts:126`/`:765` (App.tsx) and `:757` (TenantFile.tsx:152) were already stale on main; not this branch's lines |

## Fix-wave-2 list (complete; small)

- F2-1 (R2-1): `dashboard/src/routes/tours/ToursPage.module.css` - a Past-only
  `@container (max-width: 800px)` block with the four 560px stacking
  declarations (the ones at the existing 560px block for `.row`, `.main`,
  `.property`, `.meta`) scoped to `.pastRow > .row` and its descendants,
  with a comment that says why (the reserved slots narrow the card by ~170px,
  so it stacks at a wider pane than an Active row). Leave the lead and action
  slots beside the card. E2E pin in `tours-past.spec.ts`: at a 960x800
  viewport (pane ~672px with the sidebar), with the three rows listed, for
  every Past row card link no descendant element has `scrollWidth >
  clientWidth` (no clipped text), then restore the wide viewport.
- F2-2 (R2-4): `ToursPage.tsx` `markToured` - (a) fold the status/time
  comparison into the re-read's try so any throw in the guard phase records
  `{ ok: false, message: 'Could not check the tour' }` and continues; (b)
  wrap everything from `setBatchRunning(true)` to the mounted-view reload in
  `try { ... } finally { setBatchRunning(false); }`. Unit pin: `getTour`
  resolving to `undefined` (a malformed re-read) yields the row alert
  "Could not mark toured: Could not check the tour", no PATCH, one reload,
  and every mark control enabled again (red before: the flag wedges).
- F2-3 (R2-3): reword `TenantFile.tsx` (the comment above the keyed card) and
  `TenantFile.test.tsx` (the header comment and the test title) to: the file
  pane unmounts while `useContact` derives loading on a contact switch
  (`ContactDetail.tsx:530-536`), so today the key changes nothing; it is
  defensive against a future caller that swaps the contact in place. Keep
  the key and the test.

Not in the wave (recorded): R2-5, C-7(ii), the two pre-existing stale
citations.
