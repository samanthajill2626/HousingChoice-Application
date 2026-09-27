# Slice S2 report - dashboard side of staff notes (plan Tasks 2-4)

Date: 2026-09-27
Branch: `feat/staff-notes-past-tours` (worktree `W:\tmp\staff-notes-past-tours`)
Slice base: `1367af79` (the S1 report commit)
Implementer: S2 child, Claude Opus 5.5 (1M context)
Status: DONE - three feat commits, one per plan task; Tasks 3 and 4 went red
before green, Task 2 is types-only with a typecheck gate exactly as the plan
writes it; dashboard typecheck exit 0 before every commit and again at the
slice HEAD.

Byte-exact quotations behind the citations below (run output, the probe, the
Playwright source excerpt) are in the ignored run state
`.superpowers/sdd/slice-S2-reference.md`.

## What shipped (the contract)

### Types (Task 2) - `dashboard/src/api/types.ts`, additive only

- 10 added lines, 0 removed (checked on the diff before staging).
- `Contact.staff_notes?: string` at `types.ts:2009` and
  `Contact.staff_notes_updated_at?: string` at `:2012`, directly after
  `Contact.notes` (`:2005`), with the plan's doc comments (`:2006-2008`,
  `:2010-2011`).
- `ContactPatch.staff_notes?: string` at `:2108`, directly after
  `ContactPatch.notes` (`:2105`), doc comment `:2106-2107`. There is no
  `staff_notes_updated_at` on the patch type; the client never sends one.

### The card (Task 3) - `dashboard/src/routes/contact/StaffNotesCard.tsx`

Props (`StaffNotesCard.tsx:21-29`): `contactId: string`; `value: string |
undefined` (the stored `staff_notes`); `updatedAt: string | undefined` (the
stored `staff_notes_updated_at`); `onContactUpdated?: (updated: Contact) =>
void`. Without `onContactUpdated` the card is read-only.

`formatLastEdited(iso)` is exported (`:37-42`): en-US short month, numeric day,
numeric year ("Sep 26, 2026") via `toLocaleDateString` in the browser's local
zone; `''` for absent or unparseable input.

Read mode:

- Card title "Staff notes" (`:109`).
- Body: when the TRIMMED stored value is non-empty, `NotesText` of the trimmed
  value; when empty or whitespace-only, the `EmptyRow` "No staff notes yet."
  (`:153`).
- "Last edited <Mon D, YYYY>" (a muted `<p>`) ONLY when the trimmed value is
  non-empty AND `updatedAt` parses (`:93-97`, `:154-156`). A cleared box shows
  no line even though the server keeps the stamp.
- Aside (`:98-106`): non-empty -> text "Edit" with aria-label "Edit staff
  notes"; empty -> text "+ Add" with aria-label "Add staff notes". It is a
  `CardAction` button only when `onContactUpdated` is given; otherwise the
  aside is the plain text "Edit" / "+ Add" and the card has no button at all.
  The aside is NOT rendered in edit mode (`:109`).

Edit mode (entered from the aside button; `startEdit` resets the draft to the
stored value and clears any error, `:64-68`):

- A `<form>` (`:111-150`) holding a `<textarea>` (`:127-135`), `rows={4}`,
  prefilled with the stored value, labeled by a SIBLING `<label htmlFor>`
  whose text is exactly "Staff notes" (`:124-126`, visually hidden by the
  module's `.srOnly`). Focused on entry by an effect that only calls
  `.focus()` on a ref (`:58-62`); no state setter runs in any effect.
- Buttons, names exact: "Save" (submit, primary, `:143`) and "Cancel" (button,
  secondary, `:146`). While a save is in flight both are disabled and the
  textarea is read-only (`:134`, `:143`, `:146`).
- Cancel (`:69-72`): back to read mode, no request.
- Save (`:73-91`): when `draft.trim() === stored.trim()` it is a no-op - no
  request, back to read mode (`:74-79`, OD-2 below). Otherwise it calls
  `updateContact(contactId, { staff_notes: draft })` with the RAW draft
  (`:83`), hands the returned contact to `onContactUpdated`, and returns to
  read mode (`:84-85`).
- Failure (`:86-87`): stays in edit mode with the draft intact and renders one
  `<p role="alert">` (`:137-141`) reading exactly "Could not save staff notes.
  Try again." (constant at `:33`). No server code or message is appended.

`StaffNotesCard.module.css` is byte-identical to the plan's Task 3 Step 3
block; all ten tokens it uses are defined in `dashboard/src/ui/tokens.css`.

### Wiring (Task 4) - `TenantFile.tsx`, `ContactDetail.tsx`

- `TenantFileProps.onContactUpdated?: (updated: Contact) => void`
  (`TenantFile.tsx:90-92`), destructured at `:136`, import at `:44`.
- The gate: `contact.type === 'tenant'` renders the card (`:253-263`) directly
  BEFORE the "Preferences & notes" Card (`:265-266`), i.e. after the
  Eligibility intake card. A `team_member` contact (TenantFile serves that kind
  too) gets no card. `value` / `updatedAt` read `contact.staff_notes` /
  `contact.staff_notes_updated_at`; `onContactUpdated` passes straight through.
- Header comment card list updated (`TenantFile.tsx:3-5`).
- `ContactDetail.tsx:1080` passes `onContactUpdated={setContact}` at the
  TenantFile call site (`:1058`), directly after `onEdit` (`:1079`). `setContact`
  is useContact's setter (`:253`), the same one the comms pane already gets
  (`:979`).
- `files.test.tsx` renders TenantFile without `onContactUpdated`, so there the
  card is read-only with the plain "+ Add" aside. No query in that suite or in
  `ContactDetail.test.tsx` collides with the new copy.

## Commits

- `07a53864` feat(dashboard/api): Contact.staff_notes + staff_notes_updated_at,
  ContactPatch.staff_notes (additive) - `types.ts` only.
- `283d4d1f` feat(dashboard/contact): StaffNotesCard - in-place editor for
  staff_notes with Last edited line (spec 3.6) - the three new card files.
- `c4dd9c95` feat(dashboard/contact): Staff notes card on the tenant file above
  Preferences & notes, tenants only (spec 3.6) - `TenantFile.tsx`,
  `ContactDetail.tsx`, new `TenantFile.test.tsx`.
- This report, as its own docs commit: `docs(staff-notes-past-tours): slice S2 report`.

Each commit staged explicit paths only, after a bare `git status --porcelain`
showing only that task's paths and a MERGE_HEAD check that found none.

## Verification (quoted)

All commands run from `/w/tmp/staff-notes-past-tours/dashboard`.

- Baseline before any edit: `npm run typecheck` -> exit 0.
- Task 2: `npm run typecheck` -> exit 0. No unit test by the plan's design;
  the new fields are exercised by Task 3's save call (it would not compile
  without `ContactPatch.staff_notes`) and by both new test files' fixtures.
- Task 3 RED: `npx vitest run src/routes/contact/StaffNotesCard.test.tsx` ->
  exit 1, `Failed to resolve import "./StaffNotesCard.js"`, "Test Files 1
  failed (1)", "Tests no tests" - the plan's predicted red.
- Task 3, the plan's component VERBATIM (before OD-2): exit 1, "Tests 1 failed
  | 10 passed (11)". The plan's 10 all passed, `toHaveFocus` included; the one
  failure was the OD-2 pin, for the expected reason ("expected "spy" to not be
  called at all, but actually been called 1 times").
- Task 3 GREEN after OD-2: exit 0, "Test Files 1 passed (1)", "Tests 11 passed
  (11)", no console output. Typecheck exit 0.
- Task 4 RED: `npx vitest run src/routes/contact/TenantFile.test.tsx` -> exit 1,
  "Unable to find an accessible element with the role "heading" and name
  `/Staff notes/`", "Tests 1 failed | 1 passed (2)" (the team_member test is
  vacuously green before the wiring). Typecheck RED as the plan predicts: exit
  2, TS2322 at `TenantFile.test.tsx(42,9)`, "Property 'onContactUpdated' does
  not exist on type 'IntrinsicAttributes & TenantFileProps'".
- Task 4 GREEN: same command -> exit 0, "Tests 2 passed (2)".
- Neighbors (plan + D1-R3):
  `npx vitest run src/routes/contact/TenantFile.test.tsx src/routes/contact/ContactDetail.test.tsx src/routes/contact/files.test.tsx`
  -> exit 0, "Test Files 3 passed (3)", "Tests 133 passed (133)" (TenantFile 2,
  files 35, ContactDetail 96). Typecheck exit 0.
- Slice HEAD `c4dd9c95`, the four suites together (StaffNotesCard, TenantFile,
  ContactDetail, files) -> exit 0, "Test Files 4 passed (4)", "Tests 144 passed
  (144)"; `npm run typecheck` -> exit 0.
- ASCII: whole-file check 0 on `StaffNotesCard.tsx`, `StaffNotesCard.module.css`,
  `StaffNotesCard.test.tsx`, `TenantFile.test.tsx`; added-lines check 0 on
  `types.ts`, `TenantFile.tsx`, `ContactDetail.tsx`. Every touched file is LF-only.
  `TenantFile.tsx:1` (the pre-existing non-ASCII line) was left untouched.
- Not run, per the mission (orchestrator gates): full `npm test`, `npm run
  smoke`, `npm run e2e`, lint. No server or e2e session was started.

Pre-existing noise, NOT this slice's: `ContactDetail.test.tsx` prints React
`act(...)` warnings ("An update to ContactDetail inside a test was not wrapped
in act(...)") from its 28 "Run AI extraction" tests. Attributed by baseline, not
by reading: with the Task 4 wiring reverse-applied, the same file gave 96/96,
82 stderr blocks, 244 act lines, all naming ContactDetail - identical to the
wired run, with an identical per-test list (diff exit 0). The wiring was
re-applied byte-identically (sha1 match).

## Divergences from the plan

1. OD-2 (binding, from the worklist): the no-op check compares
   `draft.trim()` to `stored.trim()` (`StaffNotesCard.tsx:76`) instead of the
   plan's `draft === stored`, with one added comment line saying why (`:75`).
   The server trims every JSON string value at both ends
   (`app/src/middleware/trimStrings.ts:22`, mounted at `app/src/app.ts:142`), so
   a draft differing only by surrounding whitespace would store the same text
   and re-stamp "Last edited". The request still sends the raw draft (`:83`),
   as the plan's unit test asserts.
2. One added unit test pins OD-2 (`StaffNotesCard.test.tsx:144-154`): a
   whitespace-only edit sends no request and returns to read mode. Hence 11
   tests, not the plan's 10. Strict TDD for a behavior the plan's tests do not
   cover; it was shown red against the plan's verbatim component first.
3. D1-R3 (binding): the neighbor run included `src/routes/contact/files.test.tsx`.
4. The header-comment update (plan Task 4 item 5) is the plan's wording
   reflowed over `TenantFile.tsx:3-5` (one line longer than before), so the
   non-ASCII line 1 stays untouched.

Not needed, and not taken: the `autoFocus` fallback (`toHaveFocus` passed on the
first green run); any `ContactDetail.test.tsx` selector tightening (no "Add"
query became ambiguous). Everything else - component, CSS, both test files'
plan blocks, types, wiring, commit messages - is the plan's text (the commit
trailers name the real authoring model in place of the placeholder).

## For S3 (the e2e that drives this card)

DOM shape (unchanged from the plan's; OD-2 changes no markup):

- The Card root is a `<section>` (`Card.tsx:20`). Its `<h3>` (`Card.tsx:21`)
  holds the title text "Staff notes" and, in READ mode only, the aside: a
  `<span>` (`Card.tsx:23`) wrapping the `CardAction` `<button type="button">`
  whose `aria-label` is "Add staff notes" or "Edit staff notes"
  (`Card.tsx:43-50`). The aside button lives INSIDE the heading.
- No ancestor `<section>` wraps the file pane: the cards sit in
  `div.right > div.rightInner` (`ContactDetail.tsx:983-986`) inside `<main>`
  (`dashboard/src/app/AppFrame.tsx:194`).
  So the plan's `page.locator('section', { has: heading /Staff notes/ })`
  resolves to the card root only, in both modes (the locator re-resolves; in
  edit mode the heading is still there, just without the aside).
- Edit mode replaces the body with the form: textarea, then (after a failed
  save only) the `role="alert"` paragraph, then Save and Cancel.

Accessible names:

- Textarea: exactly "Staff notes" (sibling `<label>`), in both engines. In read
  mode no element carries the label "Staff notes" exactly (the textarea is
  gone and the aside's aria-label is longer), so `getByLabel('Staff notes',
  { exact: true })` has count 0 there. Non-exact `getByLabel('Staff notes')`
  would also match the aside button's aria-label - keep `exact: true`, as the
  plan does.
- Heading, READ mode: the name includes the aside, so an EXACT heading name
  "Staff notes" fails in read mode. Testing Library (jsdom +
  dom-accessibility-api) resolves it to "Staff notes + Add" / "Staff notes
  Edit" (probe executed; a nested button contributes its TEXT there).
  Playwright 1.61 uses its own accname code, which takes a descendant button's
  aria-label, so there it should read "Staff notes" followed by "Add staff
  notes" / "Edit staff notes" (read from `playwright-core` source, NOT executed
  - no browser was launched). Either way the plan's `/Staff notes/` regex
  matches, and matches no other heading on the page.
- Heading, EDIT mode: exactly "Staff notes".
- Aside buttons: "Add staff notes" / "Edit staff notes"; edit buttons "Save" /
  "Cancel"; alert text "Could not save staff notes. Try again.".

Behavior worth knowing:

- A save does NOT reload or remount the file pane: `useContactFile`'s effect
  keys on contact id, type and a reload nonce only
  (`useContactFile.ts:212`), so the card stays mounted and re-renders from the
  PATCH response via `setContact`. No spinner flash between Save and the new
  text.
- Enter inside the textarea inserts a newline; only the Save button submits.
- OD-2: a whitespace-only change makes NO request (do not wait for a PATCH on
  one). `fill('')` on a non-empty box DOES send `{ staff_notes: '' }` (the
  trimmed values differ), which is the plan's cleanup step.
- "Last edited" formats the server's UTC stamp in the browser's local zone
  (en-US "Mon D, YYYY"); the plan's anchored regex matches it. It is hidden
  whenever the trimmed value is empty, so after the cleanup the stamp stays on
  the record (S1) but no line renders.
- On a fresh reseed the tenant has no `staff_notes` key (S1 report), so the
  card starts at "No staff notes yet." with the "Add staff notes" aside.

## Recorded, no change (from the worklist)

- D1-R4: a custom kind layered on the tenant base (`type === 'tenant'`) gets the
  card under the literal spec gate.
- Gate 5 attribution: `TenantFile.tsx`'s pre-existing unused `FieldSource`
  import (main line 14) is now at line 15 because the header comment gained a
  line. Attribute by rule and context, not line number, as the worklist says.
