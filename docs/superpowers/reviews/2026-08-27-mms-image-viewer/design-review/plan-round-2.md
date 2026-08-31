# Adversarial implementation-plan review - round 2

## 1. [BLOCKING] Task 5's mandated attachment fixture is not a valid Timeline attachment

### What is wrong

The revised plan's exact eligible-image fixture omits `s3Key`. That is not optional on either `TimelineMessage.media_attachments` or the lower-level wire `Message` attachment shape. The affected test helpers deliberately convert `props.items` to `TimelineItem[]`, so this is not harmless test shorthand: once the literal fixture is put into either image-bearing Timeline tree, dashboard typecheck cannot go green. The Task 5 runtime assertions may fail red for the intended old-anchor reason, but the prescribed implementation cannot reach the task's green checkpoint because the fixture remains structurally invalid.

### Evidence

- Plan lines 717-723 prescribe `{ contentType: 'image/png', filename: 'Front porch.jpg' }` as the eligible attachment.
- `dashboard/src/api/types.ts:2282-2293` defines each `TimelineMessage.media_attachments` item as `{ s3Key: string; contentType: string; filename?: string }`; `dashboard/src/api/types.ts:2104-2121` makes the same field required on wire-message attachments.
- The existing helpers type their items as `TimelineItem[]`: `dashboard/src/routes/contact/Timeline.mms.test.tsx:43-50` and `dashboard/src/routes/contact/Timeline.email.test.tsx:7-12`.
- Existing image fixtures demonstrate the valid shape at `dashboard/src/routes/contact/Timeline.test.tsx:542-548` and `dashboard/src/routes/contact/Timeline.test.tsx:563-568`.
- Task 5 requires dashboard typecheck to exit 0 before commit at plan lines 794-808.

### What it implies

A literal builder stops in Task 5 with a type error rather than a completed renderer slice. Add a deterministic `s3Key` to every prescribed attachment in this test recipe before handing it to implementation.

## 2. [BLOCKING] Task 7 defines `timelineMessage` but tells two host tests to use an undefined `message`

### What is wrong

The revised host-fixture repair introduces `const timelineMessage: TimelineItem`, but the immediately following data-seam instructions put `[message]` into both ContactDetail and ContactCommsPane. No `message` identifier is defined by this recipe. This is not merely imprecise prose because both bullets provide exact mock expressions; copied literally they produce `Cannot find name 'message'` (or a runtime reference error in an untyped insertion) before either named host assertion runs.

### Evidence

- Plan lines 1002-1018 define the only Timeline fixture as `timelineMessage`.
- Plan lines 1044-1045 instead mandate `items: [message]` and `timelinePage([message])`; lines 1048-1049 then refer only generically to "the message" for the remaining person-channel hosts.
- The existing ContactCommsPane helper accepts the item explicitly passed to it and adds no ambient message fixture: `dashboard/src/routes/contact/ContactCommsPane.test.tsx:151-153`.
- Task 7 requires all six focused files and dashboard typecheck to exit 0 at plan lines 1063-1078.

### What it implies

Task 7 is not executable as written. Every Timeline-backed seam must use the declared `timelineMessage` identifier (while the relay/native-group seams continue using `wireImageMessage`).

## 3. [BLOCKING] The new mobile Playwright test clicks a trigger that exists only in the separate desktop test

### What is wrong

Task 8 now explicitly requires a separate mobile 1:1 test, but its first executable viewer action is `await trigger.click()` without locating or declaring `trigger` in that test. The only planned declaration is in the desktop sequence, so it is scoped to another test callback and cannot be reused. The current Playwright case also has no such variable to inherit: it locates the attachment as `img`. The revised test recipe therefore does not compile literally, and the focused command cannot provide the required mobile Back/pinch evidence.

### Evidence

- Plan line 1107 declares `const trigger = ...` as part of the desktop Step 1 sequence.
- Plan lines 1185-1193 require a "separate 1:1 test" and then call `trigger.click()` without a mobile declaration or selector.
- The existing 1:1 test locates `const img`, not a trigger, at `e2e/tests/dashboard-next/outbound-mms.spec.ts:125-137`.
- The spec requires the separate mobile viewer proof at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:552-560`, and plan lines 1231-1237 claim the focused Playwright command will cover it.

### What it implies

Task 8 cannot reach its own focused green state. The mobile setup must explicitly locate its Timeline region and image button after the send, assign that button to a locally scoped `trigger`, and only then open the viewer.

## 4. [MEDIUM] A no-op keyboard reset never announces and poisons the next pointer announcement

### What is wrong

The plan sets a pending-keyboard flag and updates the live region only from the next transform callback. That assumes every keyboard control changes transform state. In the pinned dependency, `resetTransform(0)` returns without animating or emitting a transform when the viewer is already at its initial scale and position. Thus pressing `0` on a freshly opened viewer produces no required `100%` announcement, leaves the pending flag set, and causes a later wheel/pinch transform to be announced as though it were the result of the keyboard command. The mock-driven test never exercises this boundary because it manually invokes a captured transform callback after the command.

### Evidence

- The spec requires the resulting percentage after a keyboard zoom command at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:217-225`.
- Plan lines 613-615 test calls plus a separately driven callback, while lines 627-660 prescribe a pending ref and announcement only from the next callback; there is no no-op or stale-pending case.
- In the exact pinned upstream source, [`react-zoom-pan-pinch` v4.0.4 `resetTransformations`](https://github.com/BetterTyped/react-zoom-pan-pinch/blob/v4.0.4/src/core/handlers/handlers.utils.ts#L136-L149) returns at lines 136-142 when scale and position already equal the initial transform, before `animate` can emit `onTransform`.

### What it implies

The shipped keyboard alternative is observably wrong at the most common reset boundary while all planned tests can pass. The plan needs an explicit no-op command path that announces the current scale and clears pending state, plus a test for `0` at the initial transform followed by a pointer transform.

## 5. [HIGH] Unbounded filenames can push Close and Download out of the mobile viewer

### What is wrong

The plan routes the existing attachment label verbatim into the modal title, but never assigns a task or assertion for title containment in the new header. The current shared Modal header is a flex row whose title has neither `min-width: 0` nor an overflow/wrapping rule. A sender-controlled unbroken filename therefore contributes a large min-content width and can force the following Download and Close flex items outside the 360px shell. This directly violates the mobile no-horizontal-overflow and persistent-action guarantees. Every planned unit/browser fixture uses a short title, so the gates do not catch it.

### Evidence

- Timeline returns a stored filename verbatim from `attachmentLabel` at `dashboard/src/routes/contact/Timeline.tsx:610-617`; the plan then passes that label as `title` at lines 774-785 and renders it through `title={image.title ?? image.alt}` at line 536.
- Stored inbound attachment filenames can be as large as a summed 8 KiB budget: `app/src/services/inboundEmail.ts:114-115` and `app/src/services/inboundEmail.ts:676-685`.
- The current flex header and title rules at `dashboard/src/routes/contact/Modal.module.css:37-50` contain no width floor, wrapping, or overflow containment.
- The spec requires filename titles and reachable actions/no horizontal overflow at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:147-148`, `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:185-190`, and `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:330-334`.
- Task 1 lines 149-151 mention media geometry but no title containment, and Task 8 lines 1185-1198 tests only the short `Attachment 1` title.

### What it implies

A valid existing filename can make the two mandatory actions unreachable on mobile even though every planned check is green. Task 1 must specify media-header shrink/wrap/overflow behavior that preserves the full accessible title, and a 360px test must use a long unbroken filename and assert the shell and both actions stay within the viewport.
