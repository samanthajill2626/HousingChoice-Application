# Research findings - S4 (dashboard) and S5.6-S5.12 (e2e, docs, gates) vs the live tree

Reader: live-tree verification of plan
`docs/superpowers/plans/2026-10-13-primary-contact-integrity.md` lines
14029-17523 (S4.1-S4.13, incl. S4.10b) and 19850-20953 (S5.6-S5.12), at
worktree tip 14c2856b (the dashboard, app and e2e trees are byte-identical to
the plan base 0e565b86, and `main` 16ca96cc has no dashboard or e2e diff
against it). Byte-exact quotations, the anchor location table and the full
consumer / binding lists live in the gitignored reference
`.superpowers/sdd/research-S4-S5e2e-reference.md`; this file cites code by
file:line only.

## Summary

- Anchor verification: 0 mismatches. 93 anchors (80 in S4, 13 in
  S5.7-S5.11). 86 are in the live tree exactly once; S4.9 1e is in it exactly
  twice, as its `replace_all` says; the other 6 are text an EARLIER S4 task
  inserts (S4.3 1, S4.8 1, S4.8 3e, S4.8 3f, S4.10 1e, S4.10b 3b-2). Every
  old_string -> new_string pair was applied IN MEMORY, in plan order, per
  file (nothing written): each matched exactly once at its turn. Component,
  prop, function, CSS class, test, helper and fixture names the tasks quote
  all exist as quoted.
- RED/GREEN arithmetic re-derived and correct (S4.2 19 failed | 35 passed
  (54); S4.3 4 | 55 (59); S4.1 1 | 4 (5); S4.4/S4.5 3 failed each; S4.6 2;
  S4.7 4; S4.8 6; S4.9 8; S4.10 2; S4.10b 1; S4.11 1; S4.12 2; S5.7 1 failed
  / 3 passed, then 4 passed).
- Copy: the S4 strings match spec 7.1 (heading + 8 reason lines + 3 link
  labels), 7.2, 7.3 (4 sentences + 503), 7.4 (2 leads, effect line, 3 action
  variants, empty state, 409) and 7.6 word for word.
- Lint, simulated (eslint on the in-memory post-task text via `--stdin`):
  RosterConfirmDialog.tsx, ListingDetail.tsx, PlacementDetail.tsx,
  ListingDetail.test.tsx and RosterConfirmDialog.test.tsx are clean;
  TourDetail.tsx keeps only its pre-existing error (F-8).
- Message catalog: the new copy is staff UI copy and is exempt (reference
  section 4 cites the rule and precedent).
- S5.6's e2e walks were traced against S4's DOM and the routes they call:
  consistent. S5.12 matches the AGENTS.md gate list.
- Findings: all LOW or INFO. None blocks the build.

## F-1 (low, doc drift, no owning task) - dashboard endpoint docblocks describe the replaced rules

Also filed by the S3/S5-app reader as its F5; listed here because these are
the dashboard's own contract docs for the S4 surfaces.

- `dashboard/src/api/endpoints.ts:1037-1041` (`restoreUnit`): "Sole-landlord
  promotion ... the ONE remaining live contact typed landlord ... with zero or
  two-plus, nobody." S2.8 replaces this with `chooseHeir` (the earliest-added
  eligible contact; spec 4.6). The docblock also lists no 503
  `roster_read_failed`, which S4.10b now handles.
- `endpoints.ts:1072-1080` (`addUnitContact`): auto-primary only for "a NEW
  seat on a property with no primary row and no landlordId". Spec 4.4 widens
  this: deleted counts as absent, and an edit of X's own row counts. The error
  list at `:1081-1088` lacks 409 `primary_contact_deleted`.
- `endpoints.ts:1100-1107` (`removeUnitContact`): "promotes the landlord of
  record in its place (or clears the primary entirely when the property has
  no landlordId)". This is now the heir function. The docblock also lacks 503
  `roster_read_failed`.
- S4 owns `dashboard/src/api/types.ts` but not `endpoints.ts`. Suggest a
  comment-only step in S4.9 (or S4.1).

## F-2 (low) - a RosterConfirmDialog test comment pins the old status uniqueness

- `dashboard/src/routes/shared/RosterConfirmDialog.test.tsx:397-398` (in
  'renders nothing when there is no duplicate'): "The block is the dialog's
  ONLY role=status, which is what the e2e locator scopes to". After S4.2 that
  is false: the fallback box is a second `role="status"`.
- The assertion still passes, because the fixture has no `introFallback`.
- S5's cross-slice note (plan 17590-17594) gives this pin to S4, but no S4
  task edits it. One-line comment fix in S4.2.

## F-3 (low) - selectors.md's restore-dialog row is missing the new 503 sentence

- `e2e/support/selectors.md:138` lists the restore dialog's possible failure
  alerts: `The property contacts changed - try that change again.` /
  `Couldn't restore - please try again.`.
- S4.10b adds a third: `Couldn't check the other contacts - try again.` (503
  `roster_read_failed`).
- S5.8 edits rows 87, 98 and 99 and adds rows, but never touches 138.

## F-4 (low) - the GLOSSARY landlord-of-record entry still says the primary contact is dialed

- `documentation/GLOSSARY.md:262-264`: "Deliberately distinct from the
  **primary contact** (who we put on threads and dial)".
- S5.9 rewrites the primary-contact entry above it (no live call routing,
  per spec 9.2) but leaves this entry, so the two now contradict each other.

## F-5 (low) - property-roster.spec.ts comments keep the masked-call framing

- `e2e/tests/dashboard-next/property-roster.spec.ts:4-6` ("reaches by masked
  call"), `:17-18` ("silently re-pointing live calls is not acceptable") and
  `:243` (step-4 heading).
- S5.7 replaces only the assertion at `:249-253`. Comment-only; S4 removes
  that framing from the product copy and S4.9 3e-3g from the source.

## F-6 (low) - a ListingDetail restore test keeps the sole-landlord name

- `dashboard/src/routes/listing/ListingDetail.test.tsx:1348-1353`: the
  comment says the restore "makes the one remaining contact typed landlord
  the primary contact", and the test is named "Restore without a landlord
  that promotes the sole landlord-typed contact ...".
- S2.8 replaces that rule with `chooseHeir`. S4.10 1d edits this test's body
  (the re-read mock) but keeps the stale name and comment. Its assertions
  still hold under the heir rule.

## F-7 (low) - the RosterSource doc names the primary contact, not the property contact

- `dashboard/src/api/types.ts:1103`: "`default` = the property's primary
  contact + the tenant".
- After S1, the default people list is the tenant plus the PROPERTY CONTACT
  (the flagged primary, else the landlord of record; deleted contacts
  skipped). S4.1 edits types.ts but not this line.

## F-8 (info, gate 5 attribution) - pre-existing lint errors in S4-touched files

Linted the S4 file set at the base (read-only):

- `dashboard/src/routes/tours/TourDetail.tsx:342:85` `react-hooks/purity`
  (`Date.now` during render). PRE-EXISTING. It survives S4.4 (simulated) and
  must be NAMED in the gate record.
- `dashboard/src/routes/shared/RosterConfirmDialog.tsx:113:5`
  `react-hooks/set-state-in-effect`. PRE-EXISTING, and REMOVED by S4.3 (the
  re-seed effect goes; the simulated post-S4.3 file lints clean). The lint
  backlog drops to 22 errors in 17 files. AGENTS.md ("23 errors across 18
  dashboard files") and `docs/issues/lint-backlog-repo-wide.md` would then
  read one high. Updating them is optional.
- Every other S4-touched dashboard file, and property-roster.spec.ts: clean.

## F-9 (info) - the slice map says "scenario verbs", but S5.6 uses none

- Plan line 285 (slice map, S5): "e2e specs (a)-(c) of spec 10 + scenario
  verbs".
- S5.6 (plan 19940-19945) deliberately uses the dashboard-next dialect with
  no Scenario verbs. That matches the precedent
  (`property-roster.spec.ts:24-28`), so the slice-map wording is the stale
  side.

## F-10 (info) - the dialog mockup's "(opens the property)" hint is not in the spec copy

- Option A in `mockups/dialog-notice.html:47` reads "Set a primary contact
  (opens the property)" and puts Check again on the same line.
- The spec 7.1 table has no hint and puts Check again on the last line. The
  plan follows the spec (C10). No action unless Cameron wants the hint.

## F-11 (info, plan text precision) - S4.10b's blocks are indented

- S4.10b's fenced blocks (plan 17072-17093, 17119-17179) carry a 3-space
  list indent in the raw markdown. Every other S4 block is flush-left. The
  Edit old_strings are the text with those 3 spaces stripped; verified that
  way.
- S4.10b 3b's "delete those lines and the blank line after them": the
  old_string must end with TWO newlines, or one blank line too many is left
  between `PRIMARY_CONTACT_DELETED_COPY` and the notice constants. Cosmetic.

## Checks with no finding (detail in the reference)

- Selector / strict-mode collisions:
  - The open dialog holds two `role="status"` nodes only when the duplicate
    warning ALSO shows; S5.6 and S5.8 filter by text.
  - The one existing dialog-scoped unfiltered `getByRole('status')` in e2e,
    `contact-create-relay-group.spec.ts:397`, is on the standalone dialog,
    which never renders the box (no `introOwner`).
  - The property box (`role="status"`) never coexists with the deleted
    banner. Spinners render only while the page loads.
  - The box button "Make <Name> primary" and the edit-row aria-label "Make
    <Name> the primary contact" do not substring-match each other under
    Playwright's default name matching.
  - "Check again", "Use the updated intro" and "Choose a primary" appear
    nowhere else in dashboard/src or e2e.
- Every timeless-tour open walk will now show the box ("This tour has no date
  and time yet."): `tour-roster.spec.ts:229-298`,
  `roster-quiet-hours.spec.ts:335-376`, `scenarios/steps.ts:1927-1960`. None
  asserts anything the box breaks: footer buttons are scoped and the geometry
  checks are on the footer.
- S5.6 traced end to end:
  - routes: `POST /api/tours` with `scheduledAt` -> 201 `{ tour }`;
    `POST /api/tours/:id/roster/members { contactId }`; `GET .../preview-open`.
  - wiring: relative `/__dev` via `page.request` + `baseURL`; the Vite
    `/__dev` proxy; reseed wipes the seam units.
  - copy: `formatStreet` = line1, which matches `introFallback.street`; the
    intro copy matches the tour intro catalog entry.
  - roster: a heir `name` in First Last form.
  - the box: its eligible-row count in walk (c) is 3 -> "Choose a primary".
- S5.12 vs AGENTS.md:
  - five gates, each bare;
  - redirects, never pipes;
  - gate 4 under `timeout 2700` (R24, exit 124 = failure);
  - gate 5 lists files first and STOPs on an empty list (AGENTS.md says SKIP
    for a docs-only branch; stricter and right here), with baseline
    attribution and the `.mjs` hole noted;
  - AWS-key check; DynamoDB Local; one main sync.
- No test or e2e spec asserts the empty state "No contacts on this property
  yet.", the Delete dialog body, "tours fall back to the landlord of record",
  or any "Make primary" text S4 changes. The complete copy-binding list is in
  the reference, section 2.
