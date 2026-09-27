# Research findings - dashboard side of Part 1 (plan Tasks 2-4), live-tree drift check

Date: 2026-09-26. Read-only researcher for the build orchestrator of
`feat/staff-notes-past-tours`. Scope: plan Tasks 2, 3, 4 against the live tree
(dashboard code identical to base `0dafe3c1`). Byte-exact quotations backing every
citation below live in the gitignored run state
`.superpowers/sdd/research-dashboard-part1-reference.md`.

Verdict: Tasks 2-4 are sound against the tree. Every Task 2-4 anchor holds except one
line number (R-2). The one substantive correction (R-1) sits in Task 5's e2e, found
while verifying the layout that step depends on. No BLOCKING item.

## R-1 [SHOULD-FIX] Task 5: the 360px overflow check cannot see the Staff notes card

- Where: plan Task 5 Step 2, `tenant-staff-notes.spec.ts`, the 360px step (plan lines
  1239-1245); spec 4.8 ("The e2e asserts no horizontal overflow ... on the tenant file
  with the Staff notes card in edit mode").
- Tree facts: the file-pane cards render inside `.right`
  (`dashboard/src/routes/contact/ContactDetail.tsx:983-986`, composed at
  `dashboard/src/routes/contact/ContactDetail.module.css:186-188`), which is
  `overflow: auto` (`dashboard/src/ui/twoPaneShell.module.css:66-69`), a scroll
  container nested inside the routed `<main>` (`dashboard/src/app/AppFrame.module.css:383-387`).
  `expectNoHorizontalOverflow` measures only `document` and `<main>`
  (`e2e/support/viewport.ts:73-86`), and the same file records that a nested scroll
  container self-contains its content's overflow (`e2e/support/viewport.ts:97-99`).
- Failure scenario: a card-internal overflow at 360px (a textarea or the Save/Cancel row
  wider than the card) scrolls sideways INSIDE `.right`; `main.scrollWidth` does not
  change, the assertion passes, and spec 4.8's check is vacuous for the card it names.
- Correction: in the 360px step, additionally assert
  `expectNoHorizontalOverflowIn` on the `staffCard` locator (the Card `section` is
  overflow-visible, `dashboard/src/routes/contact/Card.module.css:4-9`, so its
  scrollWidth includes descendant overflow; `e2e/support/viewport.ts:93-96,107`), and
  import it from `../../support/viewport.js` beside the existing names. Keep the
  page-level call. Same pre-existing blind spot, not this branch's to fix:
  `e2e/tests/tour-roster.spec.ts:454` over `dashboard/src/routes/tours/TourDetail.tsx:678`.

## R-2 [NOTE] Task 3: ApiError anchor is one line off

- Where: plan line 705-706 cites `dashboard/src/api/client.ts:21`.
- Tree: the class is at `client.ts:13` and the constructor at `client.ts:22`; the
  signature `(status, code, message, body?)` matches the plan, so
  `new ApiError(500, 'boom', 'boom')` is valid.
- Correction: none to code; cite `client.ts:22` in any slice report.

## R-3 [NOTE] Task 4 Step 4: the neighbor run omits the existing TenantFile suite

- Where: plan line 1111 runs `TenantFile.test.tsx` and `ContactDetail.test.tsx` only.
- Tree: TenantFile's other render site is
  `dashboard/src/routes/contact/files.test.tsx:77-99` (tenant fixture, no `onEdit`, no
  `onContactUpdated`, so the new card renders read-only with a plain "+ Add"). Every
  query in that file and in `ContactDetail.test.tsx` was checked against the new copy
  and aria-labels: no collision, no heading count, no snapshot, no `/Add/`, `/Edit/` or
  `/notes/i` query (`ContactDetail.test.tsx:460,964,967,969,991,1340` are the only
  generic ones and none can match). No selector tightening is needed.
- Correction: add `src/routes/contact/files.test.tsx` to the Step 4 vitest command.

## R-4 [NOTE] Spec 3.6 scope: tenant-based custom kinds get the card

- Tree: a custom kind is a `role` layered on a base type
  (`dashboard/src/routes/contact/ContactDetail.tsx:8-9`,
  `dashboard/src/routes/contact/contactProfile.ts:63-68`), so a contact shown as, for
  example, "Case worker" on the tenant base type has `type === 'tenant'` and gets the
  Staff notes card under the planned gate.
- Correction: none (it matches the spec's literal rule and every other tenant gate,
  e.g. `ContactDetail.tsx:800`); name it in the handback as a planner-alone reading.

## Checked and holding (no action)

- Task 2: `types.ts:2005` and `:2098` are the `notes?: string;` lines of `Contact` and
  `ContactPatch`; `updateContact` returns `Promise<Contact>` (`endpoints.ts:1443`).
- Task 3: `Card`/`CardAction`/`EmptyRow`/`NotesText`/`responseClass.muted` exports and
  props match (`Card.tsx:11-52,86,262,300-308`); the Card root is a `<section>` with the
  aside inside its `<h3>` (`Card.tsx:20-24`); Button takes `size="sm"`,
  `variant="primary"|"secondary"`, `type`, `disabled` (`Button.tsx:9-32,67-73`); all ten
  CSS tokens are defined in `dashboard/src/ui/tokens.css:9-77`; there is no global
  visually-hidden class, so the local `.srOnly` follows the per-module convention; the
  focus effect matches shipped precedents (`HousingFairIntake.tsx:16-19`,
  `FlyerPage.tsx:153-156`) and trips no rule of the `recommended-latest` preset
  (`eslint.config.mjs:48-52`).
- Task 4: TenantFileProps' 13 required props all appear in the plan's test
  (`TenantFile.tsx:48-100`); `MemoryRouter` alone suffices because MediaGallery returns
  before its only provider hook when `media` is empty (`MediaGallery.tsx:26-27,55-57`);
  "Add a note" and "No preferences yet" are at `TenantFile.tsx:251,262`; the call site
  is `ContactDetail.tsx:1058` with `onEdit` at `:1079`; `setContact` is
  `(contact: Contact) => void` (`useContact.ts:13`) and is already passed as
  `onContactUpdated` to ContactCommsPane (`ContactDetail.tsx:979`,
  `ContactCommsPane.tsx:54`); team_member routes to TenantFile
  (`ContactDetail.tsx:551-558`); the "View" group and "Profile" button exist
  (`ContactDetail.tsx:946-962`) and the profile pane is `display: none` below 860px
  until pressed (`twoPaneShell.module.css:128,168-170`).
- Spec 3.7: no contacts list, inbox, timeline or export reads contact `notes`; only the
  four file panes and ContactEditForm do (`TenantFile.tsx:164`, `LandlordFile.tsx:116`,
  `PartnerFile.tsx:51`, `UnknownFile.tsx:82`, `ContactEditForm.tsx:153,251`).
