# Modal lifecycle live-code audit

Live tree: `feat/mms-image-viewer` at `5b2d3a3741e2260dd9420190c8b0db66eb49d697`. Scope is read-only except for this ignored report.

## Current shared contract

- `dashboard/src/routes/contact/Modal.tsx:12-19` exports exactly:

  ```tsx
  export interface ModalProps {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    footer?: React.ReactNode;
  }
  ```

- `Modal` currently destructures only those four props at `Modal.tsx:21`.
- The dialog is labelled by the visible `h2` through `aria-labelledby` (`Modal.tsx:77-89`), has `role="dialog"`, `aria-modal="true"`, and `tabIndex={-1}` (`Modal.tsx:79-83`).
- The Close control has accessible name `Close` but visible content is the glyph `x`-shaped character, not visible text (`Modal.tsx:90-92`).
- Backdrop dismissal is `onMouseDown={onClose}` (`Modal.tsx:71-76`); the dialog stops that event at `Modal.tsx:84`. Close and backdrop therefore already converge on the same consumer callback.
- The body is a scroll owner (`Modal.module.css:74-85`, `overflow: auto` on `.body`; padding on `.bodyInner`). Footer is a fixed flex row after the body (`Modal.tsx:94-97`, `Modal.module.css:88-95`).
- Default geometry/layer is `.backdrop` fixed at z-index 50 with `var(--sp-4)` padding (`Modal.module.css:3-12`), and `.dialog` is flex-column, width 100%, max-width 30rem, max-height `100dvh - var(--sp-7)` (`Modal.module.css:14-35`).
- `Modal` renders in its caller's React location; it does not portal itself. The future provider's body portal is therefore the only thing that would make the media use a direct `body` child.

The approved plan's additive public shape is recorded at `docs/superpowers/plans/2026-08-27-mms-image-viewer.md:134-148`: optional `variant`, `headerActions`, `trapFocus`, `initialFocus`, `restoreFocus`, and `onDialogKeyDown`, with current behavior as the default.

## Existing dialog stack, focus, and Escape surfaces

All current shared-dialog state is module-global in `Modal.tsx`:

- Stack mutation: `mountedDialogs.push(dialog)` at `Modal.tsx:40`; cleanup finds and splices the same node at `Modal.tsx:52-54`.
- Stack readers: topmost Escape reads the last node at `Modal.tsx:43-44`; cleanup reads whether the removed node was topmost at `Modal.tsx:52`, and reads the next topmost at `Modal.tsx:57`.
- Restore target capture: `previouslyFocusedRef` snapshots `document.activeElement` during render at `Modal.tsx:25-29`, before descendant effects can move focus.
- Initial-focus write: after child effects, the modal preserves any focus already inside; otherwise it focuses the dialog (`Modal.tsx:35-41`). There is no current focus trap.
- Escape reader/mutator: each mounted modal owns a bubbling `document` keydown listener. Only the last `mountedDialogs` entry handles Escape, and only when `event.defaultPrevented` is false; it then prevents default and invokes the latest `onClose` callback (`Modal.tsx:31-33`, `42-51`).
- Restore-focus writes: when the top modal unmounts, focus returns to the prior element if that element is inside the surviving modal; otherwise the surviving dialog is focused. With no surviving modal, the captured element is focused (`Modal.tsx:55-66`). An underlying modal unmounting while a later modal remains performs no focus write (`Modal.tsx:52-55`).
- Topmost is mount/effect order, not visual z-index. The stack stores only DOM nodes (`Modal.tsx:10`); CSS layer is not read by this lifecycle.

Other live global keyboard/focus owners are separate from `mountedDialogs`:

- Mobile drawer: focuses its first control, traps Tab, prevents default on Escape, closes, and restores the hamburger (`app/AppFrame.tsx:59-108`). Its document listener does not test `defaultPrevented` (`AppFrame.tsx:83-102`).
- Account menu: closes on every document Escape without testing or setting `defaultPrevented` (`app/AppFrame.tsx:214-227`).
- Status menu: document Escape closes and focuses its trigger, also without a `defaultPrevented` guard (`ui/StatusMenu.tsx:148-167`).
- Contact Call menu (`routes/contact/CallMenu.tsx:60-74`), Contact Actions menu (`routes/contact/ContactActionsMenu.tsx:76-90`), Listing Actions menu (`routes/listing/ListingActionsMenu.tsx:42-56`), Tour Actions menu (`routes/tours/TourActionsMenu.tsx:63-77`), placement action menu (`routes/placements/PlacementDetail.tsx:800-814`), and Reply Target picker (`routes/contact/ReplyTargetPicker.tsx:28-42`) all close on document Escape without a `defaultPrevented` guard.
- Portaled Stage menu closes and focuses its kebab on document Escape (`routes/placements/StageMenu.tsx:61-97`), focuses its first enabled item after portal mount (`StageMenu.tsx:99-108`), and restores the kebab on selection (`StageMenu.tsx:123-129`). It does not test or set `defaultPrevented` on Escape.
- Contact and unit search listboxes handle Escape only on their focused combobox and do prevent default (`routes/contact/ContactSearchField.tsx:184-203`; `routes/contact/UnitSearchField.tsx:157-176`).

Live consequence relevant to the approved topmost contract: inert DOM does not disable these document listeners. If a drawer is already open, its earlier Escape listener can set `defaultPrevented` before `Modal` reads it, so the modal listener's current guard can leave the viewer open while the drawer closes/restores background focus. The other global Escape owners can close their background UI on the same Escape that closes the viewer because they do not consult `defaultPrevented`. This is a reachable compatibility surface named by the spec's pre-existing drawer/listbox-layer cases, but it is not represented in the plan's Task 1 file list.

## Direct Modal importers and compatibility readers

There are 34 production `<Modal>` instances in 23 files. Every one currently consumes only `title`, `onClose`, optional `footer`, and children. Their import/use anchors are:

- `routes/broadcasts/BroadcastsList.tsx:13,186`; `routes/broadcasts/RecipientPreview.tsx:28,514`.
- `routes/contact/ConsentCaptureModal.tsx:13,69`; `ContactCreateForm.tsx:20,237`; `ContactDetail.tsx:54,1183`; `ContactEditForm.tsx:79,415`; `CreateRelayGroupModal.tsx:80,449,465,488`; `EmailManager.tsx:18,103`; `PhoneManager.tsx:17,92`.
- `routes/conversation/ConversationDetail.tsx:33,620,642,681`; `RelayCloseAskDialog.tsx:15,58`.
- `routes/email/EmailTriage.tsx:14,103,173,403`.
- `routes/listing/ListingDetail.tsx:45,1307,1348,1392`; `ListingEditForm.tsx:15,205`; `UnitCreateForm.tsx:23,212`.
- `routes/placements/FollowUpModal.tsx:11,62`; `LostReasonModal.tsx:18,58`; `MovePromptModal.tsx:12,159`; `PlacementCreateForm.tsx:31,269`.
- `routes/settings/ConfirmRemoveDialog.tsx:9,41`; `routes/shared/RosterConfirmDialog.tsx:29,168`.
- `routes/tours/ScheduleTourForm.tsx:45,333`; `TourModals.tsx:25,93,227,310,384`.

Several consumers intentionally make `onClose` a no-op while busy, so Escape/backdrop/header Close all share the same business guard: examples are `ConsentCaptureModal.tsx:69-74`, `ConversationDetail.tsx:642-689`, `ContactDetail.tsx:1183-1191`, `EmailTriage.tsx:103-108,403-408`, `ListingDetail.tsx:1307-1400`, `ConfirmRemoveDialog.tsx:41-44`, and the documented in-flight guard at `RosterConfirmDialog.tsx:168-179`. Default close-event timing and callback convergence are therefore existing compatibility behavior, not just visual behavior.

## Body portals and layer inventory

- The app root is the `#root` body child (`dashboard/index.html:16`, `dashboard/src/main.tsx:9-20`).
- Contact search suggestions portal directly to `document.body` (`ContactSearchField.tsx:237-285`) at z-index 100 (`ContactSearchField.module.css:59-75`).
- Unit search suggestions portal directly to `document.body` (`UnitSearchField.tsx:209-245`) at z-index 100 (`UnitSearchField.module.css:59-74`).
- Stage menu portals directly to `document.body` (`StageMenu.tsx:145-190`) at z-index 20 (`StageMenu.module.css:33-50`).
- Existing shared Modal backdrop is z-index 50 (`Modal.module.css:3-12`). AppFrame mobile scrim/drawer are z-index 40/50 (`AppFrame.module.css:392-425`); collapsed-nav tooltip is 60 (`AppFrame.module.css:251-260`). Inline menus are generally z-index 30: `CallMenu.module.css:11`, `ContactActionsMenu.module.css:36`, `ReplyTargetPicker.module.css:33`, `ListingActionsMenu.module.css:13`, `TourActionsMenu.module.css:37`, and `ui/StatusMenu.module.css:117,186`.
- The highest currently declared body-portaled layer is the two search listboxes at 100. The spec's media layer 200 statement matches the live CSS inventory.
- Search-list portals own outside-mousedown plus scroll/resize dismissal (`ContactSearchField.tsx:127-155`; `UnitSearchField.tsx:104-130`). StageMenu owns outside-mousedown, global Escape, scroll, and resize dismissal (`StageMenu.tsx:61-97`). These are mutation surfaces whose open state can persist independently of the Modal stack.

## Existing test conventions and coverage boundary

- `Modal.test.tsx` uses Testing Library `render`, `screen`, and `fireEvent`, plus Vitest `vi` (`Modal.test.tsx:1-4`). It uses selected `StrictMode` wrappers for replay/stack behavior (`Modal.test.tsx:49-53,130-134,206-210`).
- Initial focus is asserted semantically on the dialog or an effect-focused child (`Modal.test.tsx:12-31`). A rerender test proves a changing callback does not reset child focus/state (`Modal.test.tsx:33-64`), and a separate test proves Escape calls the latest callback once (`Modal.test.tsx:66-89`).
- Descendant Escape consumption is tested by calling `preventDefault` in a React input handler, then firing Escape at that input (`Modal.test.tsx:91-107`).
- Stack behavior is tested with two simultaneous modals: only top closes and focus returns to the opening control (`Modal.test.tsx:109-146`); removing an underlying modal must not steal focus (`Modal.test.tsx:148-183`); top removal with an outside prior target focuses the surviving dialog (`Modal.test.tsx:185-216`).
- Restore tests create real body buttons, focus them, unmount, assert focus, and remove the fixtures (`Modal.test.tsx:218-250`).
- The current test file contains no CSS/class/geometry assertion for 30rem width, z-index 50, body overflow, the Close glyph, footer layout, or backdrop timing. It contains no Tab/focus-containment test and no concurrent drawer/menu/listbox test.

## Concrete spec/plan drift risks

1. Plan Task 1 says to retain existing default-modal assertions for the 30rem shell and icon presentation (`plan:120`), but the live `Modal.test.tsx` has no such assertions. Those behaviors exist only in source/CSS (`Modal.tsx:90-92`, `Modal.module.css:14-35`).
2. The spec requires Escape to dismiss only the topmost dialog and says covered sibling portals are not force-closed (`spec:127-133,329-344`). The live modal stack coordinates only `Modal` instances; the drawer and nine menu/picker document listeners above are outside that stack. The plan names only the three Modal files for Task 1 (`plan:88-98`) and does not enumerate those Escape mutators.
3. `mountedDialogs` defines topmost by effect order, while layer 200 is CSS. A later-mounted default z-index-50 Modal becomes the stack's top node even if the media layer remains visually above it. No current stack reader considers layer or portal ownership (`Modal.tsx:10,40-44`).
4. Focus containment is not currently shared: Modal has no Tab trap, while AppFrame drawer has its own document-level trap and cleanup focus write (`AppFrame.tsx:59-108`). Portal menus also perform independent programmatic focus writes. These are additional readers/mutators of the focus invariant beyond `Modal.tsx`.
5. The current `.body` is the shared scroll container and `.bodyInner` owns padding (`Modal.module.css:74-85`). The plan's media sizing chain depends on additive overrides for both nodes (`plan:153-175`); any unscoped change would affect all 34 existing modal instances.
6. The default title has no flex growth, min-width, overflow, or ellipsis rules (`Modal.module.css:37-50`), and the close uses `margin-left:auto` (`Modal.module.css:52-62`). The hostile 2048-character media title is new coverage; there is no live default regression test around header action displacement.
7. The current Close accessible name is already `Close`, but its visible content is not text (`Modal.tsx:90-92`). Role/name queries alone cannot distinguish the planned media-visible `Close` text from the default glyph behavior.
