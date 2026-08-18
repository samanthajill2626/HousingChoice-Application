# Modal focus stability after portaled typeaheads - design

**Status:** approved for small-fix implementation.
**Date:** 2026-08-18.
**Lane:** small bug fix with a written review gate.
**Branch:** `codex/modal-focus-stability`.
**Baseline:** `main` at `78cc053d`, including the independently shipped portal
selector repair in `92dcba1a`.

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
adjusts relay-member-list sizing. Commit `92dcba1a` independently repairs the 12
Playwright locators invalidated by that portal and reports all five affected specs
passing. This branch is rebased on that repair. The focus implementation will not
re-edit those selectors, replace the portal with an in-flow list, or modify modal
sizing.

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
`EmailTriage.tsx`. The focused Playwright run used during diagnosis also captured
the dialog as the active accessibility node after `.fill('Tasha')`. The later
selector-only repair did not touch either source component, so the focus defect
remains on this baseline.

### Resolved portal test regression

The portal successfully makes the filtered result visible outside the modal's
scroll container. It also deliberately changes the DOM relationship: the listbox
is now a sibling of the dialog under `document.body`, not a descendant of the
dialog. Before the independent repair, a focused run of `email-triage.spec.ts`
produced:

```text
3 passed, 1 failed, exit code 1
waiting for getByRole('dialog', { name: 'Link to contact' })
  .getByRole('option', { name: /Tasha/ })
```

The failure snapshot showed the option rendered and visible in the page-level
listbox. Commit `92dcba1a` fixed all 12 invalid locators across five specs by
scoping each option through its page-level, accessibly named listbox. That commit
is now on `main` and is a prerequisite baseline, not work owned by this focus fix.

`email-triage.spec.ts` remains an implementation target only because its existing
`.fill('Tasha')` action cannot reproduce per-keystroke focus loss. The corrected
page-level listbox locator in that file must remain unchanged.

## Goals

1. A mounted dialog moves focus into itself only once.
2. If a child establishes focus inside the dialog during mount, the dialog
   preserves that descendant focus instead of moving focus to its container.
3. A re-render, including one with a new `onClose` identity, never changes the
   operator's current focus.
4. Escape and all other close paths use the latest close behavior.
5. Closing the final dialog returns focus to the element that was active when it
   first mounted. Closing the top of a stack keeps focus within the next dialog.
6. When a contact or property typeahead list is open, the first Escape dismisses
   the list and leaves the dialog open. A later unhandled Escape closes the dialog.
7. If more than one dialog is temporarily mounted, Escape closes only the most
   recently mounted dialog and leaves every underlying dialog alone.
8. Portaled contact and property results remain visible, selectable, viewport
   bounded, and outside modal scroll clipping.
9. Playwright coverage catches the original character-by-character focus failure
   without changing the independently repaired portal selectors.
10. Caller-specific focus workarounds and stale issue comments are removed or
    rewritten after the shared fix makes them unnecessary.

## Non-goals

- No replacement or refactor of the fixed-position portal implementation.
- No changes to contact or property filtering, labels, committed-pick behavior,
  keyboard navigation, result limits, or selection data.
- No modal visual redesign. Preserve the 30rem desktop width, `100dvh` maximum
  height, pinned footer, and existing scroll behavior.
- No new focus-trap library and no expansion into Tab-key focus containment. The
  missing containment behavior receives its own linked issue record.
- No edits to the 12 page-level listbox selector repairs in `92dcba1a`.
- No change to the header X busy-state leg recorded in
  `modal-busy-close-affordance`; that is a separate legibility improvement.
- No backend, API, persistence, infrastructure, dependency, or message-catalog
  changes.
- No broad typeahead deduplication between `ContactSearchField` and
  `UnitSearchField` in this fix.

## Design

### 1. Separate current callback state from the modal mount lifecycle

`Modal` will initialize the callback ref at creation with `useRef(onClose)`, so the
mounted callback is available before any effect runs. A small effect keyed on
`[onClose]` updates only that ref after later callback changes. It does not move
focus, register listeners, or perform focus restoration.

A second effect, keyed on `[]`, owns the mount lifecycle:

- Restore the `document.activeElement` captured once when `Modal` begins its
  initial render, before descendant effects can move focus into the dialog.
- Focus the dialog once only when focus is not already inside it. React runs child
  effects before parent effects, so a present or future form field may establish
  descendant focus during mount. The dialog container is the fallback target, not
  an override for valid child focus.
- Register one document-level keydown listener.
- Remove that listener and apply the captured-focus restoration policy only on
  unmount, subject to the stacked-dialog rule in section 2.

The keydown listener reads `onCloseRef.current`, so Escape invokes the newest
callback without restarting the focus lifecycle. The backdrop and header X may
continue using the current `onClose` prop directly because they do not own a
long-lived listener.

There is no effect-declaration-order requirement. The ref initializer handles the
first callback, and the update effect handles subsequent identities. The
implementation will not assign a new value to the ref during render.

### 2. Respect a child that handles Escape

Both shared typeaheads call `preventDefault()` when Escape dismisses an open
listbox. `Modal`'s document listener will close only when the key is Escape and
`event.defaultPrevented` is false.

The document listener must be registered explicitly in the bubble phase, with a
matching bubble-phase removal. React 19 runs a descendant's synthetic key handler
before the event bubbles to `document`, so the child's `preventDefault()` is
observable there. A capture-phase document listener would run first and close the
dialog before the child could consume Escape, silently inverting the intended
layering.

This produces a deterministic two-level interaction:

1. With suggestions open, Escape dismisses suggestions and keeps the dialog open.
2. With no suggestions open, Escape reaches `Modal` unhandled and closes it.

This check applies to any present or future modal child that owns Escape. It does
not add component-specific knowledge to `Modal`. Unit coverage must exercise a
real descendant React key handler so changing the document listener to capture
phase makes the regression test fail.

Each mounted dialog also registers its element in a module-local stack. A document
listener may consume Escape only when its dialog is the most recently mounted
entry. This matters while the separate Tab-containment gap still permits keyboard
access to page controls behind an open dialog: a second independent dialog can be
mounted before the first is dismissed. Listener registration order must never let
an underlying dialog consume Escape before the visible top dialog sees it.

When the top dialog unmounts, focus returns to its captured target when that target
is inside the next dialog. Otherwise the next dialog becomes the fallback focus
target. Unmounting an underlying dialog does not steal focus from the top dialog.

### 3. Preserve the merged portal behavior

`ContactSearchField`, `UnitSearchField`, and their CSS are not implementation
targets for this fix. Their fixed-position body portals, scroll/resize dismissal,
outside-click handling, internal list scrolling, and viewport max-height remain
unchanged.

The page-level listbox selectors in `92dcba1a` remain the canonical portal testing
pattern. This implementation must preserve them byte-for-byte except for unrelated
main synchronization. The Email regression changes only how text is entered and
what focus is asserted before selecting through the already-correct listbox.

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

The non-goal of trapping Tab focus also becomes an explicit
`docs/issues/modal-tab-focus-containment.md` record linked from the resolved focus
issue. This fix must not imply that `aria-modal="true"` currently provides full
keyboard focus containment.

## Error and concurrency behavior

There is no new asynchronous operation or error path. The behavioral invariant is
that re-rendering cannot be interpreted as dialog teardown.

The latest-callback ref is important for busy guards. If `onClose` changes from an
active callback to a no-op guard while an operation is in flight, Escape must read
the guarded callback. A mount-only closure over the first callback would be stale
and could allow dismissal during an irreversible operation.

The modal stack is mount-local UI state only. It owns no asynchronous work and is
updated in the same effect that registers and removes each document listener.
Underlying listeners neither prevent Escape nor restore focus while a later modal
remains mounted.

Portaled listboxes keep their existing scroll, resize, and outside-click behavior.
The modal change must not remount the typeahead or change its `dismissed`, active
option, or committed-pick state.

## Testing

Implementation follows test-first order.

### Dashboard unit and integration coverage

Add `dashboard/src/routes/contact/Modal.test.tsx` with a stateful host that proves:

- Initial mount focuses the dialog.
- A child that focuses its input in a mount effect keeps that focus; the parent
  modal effect does not replace it with dialog-container focus.
- Focusing and typing in a child input keeps that input focused after a host
  re-render supplies a new `onClose` identity.
- Escape calls the newest `onClose`, not the callback from the first render.
- A descendant React key handler that calls `preventDefault()` consumes Escape
  before the document bubble listener; the modal stays open. This test must fail
  if the document listener is registered in the capture phase.
- With two dialogs mounted, Escape closes only the top dialog even when the
  underlying close callback is a no-op guard, then restores focus inside the
  remaining dialog.
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

Do not edit the 12 repaired option locators. In the Email link flow, replace only
`.fill('Tasha')` with `pressSequentially('Tasha')`, assert the combobox remains
focused and contains the full value, then select through the existing page-level
listbox locator. This is the regression for the user's exact failure; `.fill()` is
insufficient because it can set the complete value in one operation after focus
has already moved.

Run the directly affected spec during the implementation loop:

```powershell
npm run e2e -w @housingchoice/e2e -- tests/flows/email-triage.spec.ts
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
browser checks.

At the final pre-handback step, rebase onto the latest `main` if it has advanced,
preserve both sides' intent, and rerun the affected focused checks after any
conflict resolution. This remains the repository's small-fix lane: do not run
aggregate `npm test` or the complete Playwright suite merely because the primitive
is shared.

## Acceptance criteria

- Character-by-character typing works in all three directly exposed dialogs.
- A mount-time child autofocus keeps focus inside that child; dialog-container
  focus is only the fallback when no descendant is already focused.
- Parent page re-renders do not move focus within any mounted modal.
- Escape invokes the latest close callback.
- The callback ref is initialized with the mounted `onClose`; correctness does not
  depend on effect declaration order.
- An open typeahead consumes the first Escape without closing its modal.
- With multiple mounted dialogs, only the top dialog handles Escape; an underlying
  busy guard cannot consume the key first.
- The document key listener is explicitly bubble-phase, and the descendant-handler
  regression test fails if it is changed to capture phase.
- Closing the final modal restores its original trigger; closing a stacked modal
  restores within the remaining dialog or focuses that dialog as a fallback.
- Contact and property suggestions remain portaled, visible, and selectable.
- The 12 independently repaired page-level listbox locators are not re-edited.
- The Email Playwright regression types `Tasha` sequentially, retains focus, and
  accumulates the full value before selection.
- Focused dashboard tests and dashboard typecheck pass with real exit code 0.
- The focused Email Playwright regression and hermetic live QA pass before
  handback.
- Merged 30rem width, `100dvh` sizing, pinned footer, modal scrolling, and relay
  member-list sizing remain unchanged.
- No caller needs memoization solely to avoid modal focus theft.
- The focus issue record is resolved, and the separate busy-X legibility concern
  remains open in its own linked issue record.
- Missing Tab focus containment remains open in its own linked issue record.

## Expected implementation files

- `dashboard/src/routes/contact/Modal.tsx`
- `dashboard/src/routes/contact/Modal.test.tsx` (new)
- `dashboard/src/routes/contact/ContactDetail.tsx`
- `dashboard/src/routes/contact/CreateRelayGroupModal.tsx`
- `dashboard/src/routes/contact/CreateRelayGroupModal.test.tsx`
- `dashboard/src/routes/shared/RosterConfirmDialog.tsx`
- `e2e/tests/flows/email-triage.spec.ts`
- `docs/issues/modal-onclose-refocus-trap.md`
- `docs/issues/modal-busy-close-affordance.md` (new)
- `docs/issues/modal-tab-focus-containment.md` (new)

No implementation change is expected in `ContactSearchField`, `UnitSearchField`,
their CSS modules, `Modal.module.css`, or the four other selector-repair Playwright
specs. `email-triage.spec.ts` changes only its input action and focus/value
assertions; its repaired listbox locator remains unchanged.

## Rollout

This is dashboard-only code with no dependency, migration, infrastructure, seed,
or deployment-order requirement. Cameron retains merge and deployment authority.
