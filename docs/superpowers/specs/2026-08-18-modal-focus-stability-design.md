# Modal focus stability after portaled typeaheads - design

**Status:** proposed; awaiting Cameron's review.
**Date:** 2026-08-18.
**Lane:** small bug fix with a written review gate.
**Branch:** `codex/modal-focus-stability`.
**Baseline:** `main` at `a393e4eb` (the second merge of
`feat/contact-create-relay-group`).

## Summary

Typing in the Email page's "Link to contact" dialog stops after one character
because the shared `Modal` component treats every new `onClose` function identity
as if the dialog had closed and reopened. Its effect cleanup returns focus, and
the replacement effect then focuses the dialog container. Controlled inputs cause
ordinary re-renders, so an inline `onClose` makes the input lose focus after the
first change.

This is a shared modal lifecycle defect, not an email-only defect. It affects all
33 current `Modal` call sites whenever their `onClose` identity changes. Three
dialogs create a new close callback on their own controlled re-render and are
directly exposed to the one-character failure:

- Email: Link to contact.
- Email: New contact.
- Record consent before texting.

Other input-bearing dialogs can lose focus when their parent page re-renders. The
contact-create-relay-group work worked around that risk by memoizing close handlers
in both `ContactDetail` and `CreateRelayGroupModal`, but requiring every caller to
know this rule does not fix the shared primitive.

The separate clipped-results defect was fixed on `main` before this design was
written. Commit `db5989b6` portals `ContactSearchField` and `UnitSearchField`
listboxes to `document.body` as fixed-position popovers, outside the modal body's
scroll clipping. Commit `837b5161` also widens the shared dialog to 30rem and
adjusts relay-member-list sizing. This design preserves those merged decisions. It
does not replace the portal with an in-flow list or modify modal sizing.

## Evidence and current failure

### Focus lifecycle

`Modal.tsx` currently has one effect keyed on `[onClose]`. The effect:

1. Captures the previously focused element.
2. Focuses the dialog.
3. Registers a document-level Escape listener that closes through `onClose`.
4. On cleanup, removes the listener and returns focus.

When a render supplies a different close function, React runs steps 4, then 1-3
again. The user's input is no longer active; later keystrokes land on the dialog
container and are dropped.

The original live reproduction typed `Tasha` character by character in the Email
link dialog. It stopped at `T`, `document.activeElement` became the dialog, and the
remaining characters were lost.

The portaled-list merge did not change `Modal.tsx` or the inline close callback in
`EmailTriage.tsx`. A focused Playwright run on current `main` also captured the
dialog as the active accessibility node after `.fill('Tasha')`, confirming that
the focus defect remains.

### Portal test topology

The portal successfully makes the filtered result visible outside the modal's
scroll container. It also deliberately changes the DOM relationship: the listbox
is now a sibling of the dialog under `document.body`, not a descendant of the
dialog.

Twelve existing Playwright selectors across five specs still search for an option
through a dialog-scoped locator. A focused run of `email-triage.spec.ts` on current
`main` produced:

```text
3 passed, 1 failed, exit code 1
waiting for getByRole('dialog', { name: 'Link to contact' })
  .getByRole('option', { name: /Tasha/ })
```

The failure snapshot showed the option rendered and visible in the page-level
listbox. The test could not find it only because its locator still assumed the old
DOM nesting.

## Goals

1. A mounted dialog moves focus into itself only once.
2. A re-render, including one with a new `onClose` identity, never changes the
   operator's current focus.
3. Escape and all other close paths use the latest close behavior.
4. Closing the dialog returns focus to the element that was active when the dialog
   first mounted, exactly once.
5. When a contact or property typeahead list is open, the first Escape dismisses
   the list and leaves the dialog open. A later unhandled Escape closes the dialog.
6. Portaled contact and property results remain visible, selectable, viewport
   bounded, and outside modal scroll clipping.
7. Playwright coverage reflects the portal's real DOM and catches the original
   character-by-character focus failure.
8. Caller-specific focus workarounds and stale issue comments are removed or
   rewritten after the shared fix makes them unnecessary.

## Non-goals

- No replacement or refactor of the fixed-position portal implementation.
- No changes to contact or property filtering, labels, committed-pick behavior,
  keyboard navigation, result limits, or selection data.
- No modal visual redesign. Preserve the 30rem desktop width, `100dvh` maximum
  height, pinned footer, and existing scroll behavior.
- No new focus-trap library and no expansion into Tab-key focus containment.
- No change to the header X busy-state leg recorded in
  `modal-onclose-refocus-trap`; that is a separate legibility improvement.
- No backend, API, persistence, infrastructure, dependency, or message-catalog
  changes.
- No broad typeahead deduplication between `ContactSearchField` and
  `UnitSearchField` in this fix.

## Design

### 1. Separate current callback state from the modal mount lifecycle

`Modal` will keep the latest `onClose` in a ref. A small effect keyed on
`[onClose]` updates only that ref. It does not move focus, register listeners, or
perform focus restoration.

A second effect, keyed on `[]`, owns the mount lifecycle:

- Capture `document.activeElement` once.
- Focus the dialog once.
- Register one document-level keydown listener.
- Remove that listener and restore the captured focus only on unmount.

The keydown listener reads `onCloseRef.current`, so Escape invokes the newest
callback without restarting the focus lifecycle. The backdrop and header X may
continue using the current `onClose` prop directly because they do not own a
long-lived listener.

The effects must be declared in ref-update then lifecycle order so the ref holds
the mounted callback before the key listener can run. The implementation will not
write the ref during render.

### 2. Respect a child that handles Escape

Both shared typeaheads call `preventDefault()` when Escape dismisses an open
listbox. `Modal`'s document listener will close only when the key is Escape and
`event.defaultPrevented` is false.

This produces a deterministic two-level interaction:

1. With suggestions open, Escape dismisses suggestions and keeps the dialog open.
2. With no suggestions open, Escape reaches `Modal` unhandled and closes it.

This check applies to any present or future modal child that owns Escape. It does
not add component-specific knowledge to `Modal`.

### 3. Preserve the merged portal behavior

`ContactSearchField`, `UnitSearchField`, and their CSS are not implementation
targets for this fix. Their fixed-position body portals, scroll/resize dismissal,
outside-click handling, internal list scrolling, and viewport max-height remain
unchanged.

Playwright must query a portaled option through its page-level listbox, for example:

```ts
const suggestions = page.getByRole('listbox', {
  name: 'Search contacts suggestions',
});
await suggestions.getByRole('option', { name: /Tasha/ }).click();
```

Inputs and authored dialog buttons remain scoped to the dialog. Only the portaled
listbox and its options move to page-level scope. The affected selectors are in:

- `e2e/tests/flows/email-triage.spec.ts`
- `e2e/tests/dashboard-next/contact-create.spec.ts`
- `e2e/tests/dashboard-next/contact-create-relay-group.spec.ts`
- `e2e/tests/dashboard-next/placement-create.spec.ts`
- `e2e/tests/dashboard-next/tours-page.spec.ts`

There are 12 dialog-, picker-, or edit-dialog-scoped option locators across those
files on the design baseline.

### 4. Remove caller-side focus discipline

After `Modal` owns focus stability:

- `ContactDetail` no longer needs a memoized relay-group close callback solely to
  protect modal focus.
- `CreateRelayGroupModal` no longer needs `closePicker` memoized solely to protect
  modal focus. Its abort-before-close behavior remains unchanged.
- `RosterConfirmDialog` keeps its inline busy guard, but its
  `TODO(modal-onclose-refocus-trap)` comment is removed.
- The create-relay-group integration test changes its host to supply a fresh close
  callback during the simulated page re-render. Passing then proves the shared
  `Modal` fix rather than a local memoization workaround.

No unrelated callback memoization is removed.

### 5. Resolve the issue record with the implementation

`docs/issues/modal-onclose-refocus-trap.md` remains open during design review. The
implementation commit that proves the fix will set it to `resolved`, add the
resolution date, update references, and record the shared implementation and
regression evidence.

The issue's separate note about a header X that looks active while close is busy
will not be silently marked fixed. Before resolving the focus issue, move that
concern into a new `docs/issues/modal-busy-close-affordance.md` record and link the
two records. This keeps the completed focus work and the still-open affordance work
independently reviewable.

## Error and concurrency behavior

There is no new asynchronous operation or error path. The behavioral invariant is
that re-rendering cannot be interpreted as dialog teardown.

The latest-callback ref is important for busy guards. If `onClose` changes from an
active callback to a no-op guard while an operation is in flight, Escape must read
the guarded callback. A mount-only closure over the first callback would be stale
and could allow dismissal during an irreversible operation.

Portaled listboxes keep their existing scroll, resize, and outside-click behavior.
The modal change must not remount the typeahead or change its `dismissed`, active
option, or committed-pick state.

## Testing

Implementation follows test-first order.

### Dashboard unit and integration coverage

Add `dashboard/src/routes/contact/Modal.test.tsx` with a stateful host that proves:

- Initial mount focuses the dialog.
- Focusing and typing in a child input keeps that input focused after a host
  re-render supplies a new `onClose` identity.
- Escape calls the newest `onClose`, not the callback from the first render.
- An already-prevented Escape does not close the modal.
- Unmount restores the trigger that was focused before mount.

Update `CreateRelayGroupModal.test.tsx` so the existing page-behind re-render test
uses a fresh caller callback. The input must retain focus and continue accumulating
characters after the page bump.

Run the focused dashboard tests during the red/green loop:

```powershell
npm test -w @housingchoice/dashboard -- Modal.test.tsx CreateRelayGroupModal.test.tsx ContactSearchField.test.tsx UnitSearchField.test.tsx
```

Run the dashboard typecheck after implementation:

```powershell
npm run typecheck -w @housingchoice/dashboard
```

### Playwright coverage

Update all 12 affected option selectors to scope through the page-level named
listbox. In the Email link flow, replace `.fill('Tasha')` with
`pressSequentially('Tasha')` and assert the combobox remains focused before
selecting the visible result. This is the regression for the user's exact failure;
`.fill()` is insufficient because it can set the complete value in one operation
after focus has already moved.

Run only the five affected specs through the e2e workspace:

```powershell
npm run e2e -w @housingchoice/e2e -- tests/flows/email-triage.spec.ts tests/dashboard-next/contact-create.spec.ts tests/dashboard-next/contact-create-relay-group.spec.ts tests/dashboard-next/placement-create.spec.ts tests/dashboard-next/tours-page.spec.ts
```

### Focused live QA

Use a hermetic `npm run e2e:session` lane, never the human's dashboard ports.
Verify:

1. Email Link to contact accepts a full name typed character by character and
   keeps the combobox focused.
2. The adjacent Email New contact name input accepts uninterrupted typing.
3. Record consent's note input accepts uninterrupted typing.
4. Contact and property portal results are fully visible and selectable in modal
   flows.
5. Escape with a list open closes only the list; the next Escape closes the
   dialog and restores focus to its trigger.
6. A simulated page-behind update does not move focus out of the relay-group
   member search.

Stop the hermetic session after QA.

### Review loop

After focused implementation proof, perform an adversarial review of the diff,
apply any must-fixes, and rerun the affected typecheck, unit tests, and targeted
browser checks. Do not run aggregate `npm test` or the full `npm run e2e` suite
for this small fix unless a newly discovered cross-cutting risk justifies asking
for broader verification.

## Acceptance criteria

- Character-by-character typing works in all three directly exposed dialogs.
- Parent page re-renders do not move focus within any mounted modal.
- Escape invokes the latest close callback.
- An open typeahead consumes the first Escape without closing its modal.
- Closing a modal restores the original trigger focus exactly once.
- Contact and property suggestions remain portaled, visible, and selectable.
- All 12 portal-invalid Playwright locators use the real page-level listbox
  topology.
- The five affected Playwright specs pass with real exit code 0.
- Focused dashboard tests and dashboard typecheck pass with real exit code 0.
- Merged 30rem width, `100dvh` sizing, pinned footer, modal scrolling, and relay
  member-list sizing remain unchanged.
- No caller needs memoization solely to avoid modal focus theft.
- The focus issue record is resolved, and the separate busy-X legibility concern
  remains open in its own linked issue record.

## Expected implementation files

- `dashboard/src/routes/contact/Modal.tsx`
- `dashboard/src/routes/contact/Modal.test.tsx` (new)
- `dashboard/src/routes/contact/ContactDetail.tsx`
- `dashboard/src/routes/contact/CreateRelayGroupModal.tsx`
- `dashboard/src/routes/contact/CreateRelayGroupModal.test.tsx`
- `dashboard/src/routes/shared/RosterConfirmDialog.tsx`
- `e2e/tests/flows/email-triage.spec.ts`
- `e2e/tests/dashboard-next/contact-create.spec.ts`
- `e2e/tests/dashboard-next/contact-create-relay-group.spec.ts`
- `e2e/tests/dashboard-next/placement-create.spec.ts`
- `e2e/tests/dashboard-next/tours-page.spec.ts`
- `docs/issues/modal-onclose-refocus-trap.md`
- `docs/issues/modal-busy-close-affordance.md` (new)

No implementation change is expected in `ContactSearchField`, `UnitSearchField`,
their CSS modules, or `Modal.module.css`.

## Rollout

This is dashboard-only code with no dependency, migration, infrastructure, seed,
or deployment-order requirement. Cameron retains merge and deployment authority.
