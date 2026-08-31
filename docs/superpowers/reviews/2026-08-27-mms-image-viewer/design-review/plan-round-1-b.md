# Adversarial implementation-plan review - round 1B

## 1. [BLOCKING] The plan introduces a required provider hook into an existing image-bearing test that it never updates or commits

### What is wrong

Task 6 makes every renderable `MediaGallery` image instantiate `MediaImageButton`, and that child unconditionally calls `useImageViewer()` (plan lines 786-812). The plan also expressly forbids a no-provider fallback (line 912). However, the existing shared file-pane test renders a real PNG through `TenantFile` under `MemoryRouter` only, with no `ImageViewerProvider`: `dashboard/src/routes/contact/files.test.tsx:54-92` defines that harness and `dashboard/src/routes/contact/files.test.tsx:324-330` supplies the image. This is not a hypothetical reader; it is an existing test of one of the exact production consumers changed by Task 6.

Task 6's file inventory omits `files.test.tsx` (plan lines 744-752), its focused command does not run it (lines 822-829), and its explicit commit does not stage it (lines 831-836). Task 7 eventually runs the whole dashboard workspace (lines 954-961), at which point the existing test must fail because the hook has no provider. Even if the builder diagnoses and patches that unplanned file then, Task 7's explicit commit list also omits it (lines 963-968), leaving a dirty, uncommitted fix that makes Task 9's quiet-tree precondition fail.

### What it implies

A context-free builder cannot execute this plan to completion literally. Task 6 must enumerate `dashboard/src/routes/contact/files.test.tsx`, wrap its image-bearing harness at the production-equivalent provider boundary, update the stale link-oriented assertion/name as appropriate, run it in the Task 6 focused command, and stage it in the Task 6 commit.

## 2. [BLOCKING] Task 7 prescribes a nonexistent message property and does not set the identifier the renderer actually reads

### What is wrong

The common host fixture in plan lines 918-923 adds `providerSid: 'MMHOST1'`, and the GroupText case literally calls `msg({ media_attachments, providerSid: 'MMHOST1' })` at plan line 930. Neither message shape has that property. `TimelineMessage` contains `tsMsgId` and `media_attachments` but no `providerSid` (`dashboard/src/api/types.ts:2282-2293`); the lower-level `Message` wire shape calls the field `provider_sid` (`dashboard/src/api/types.ts:2104-2121`). The GroupText helper accepts `Partial<Message>` (`dashboard/src/routes/conversation/GroupTextView.test.tsx:661-673`), so the prescribed object literal is an excess-property TypeScript error.

More importantly, the thumbnail URL never reads either spelling: `messageSid` derives the serving SID from the suffix of `tsMsgId` (`dashboard/src/routes/contact/media.ts:12-16`). Thus even a cast that hides the type error makes `MMHOST1` inert and lets the test accidentally use whatever SID its pre-existing helper already supplied.

### What it implies

Task 7 cannot reach its own typecheck as written, and a weakened cast could make the named "host proof" green without proving the intended media identity. The plan must give a valid `TimelineMessage`/`Message` fixture for each seam, with a `tsMsgId` ending in `#MMHOST1` (and `provider_sid` only where the wire `Message` type requires it), rather than inventing `providerSid`.

## 3. [HIGH] The mandated history helper destroys pre-existing router fields that collide with its second namespace key

### What is wrong

The spec requires every field of record-valued router state to be preserved and the underlying state to return exactly after dismissal (`docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:239-248`). The plan's exact helper violates that contract. `addImageViewerMarker` spreads a record and retains any existing `__hcImageViewerPriorState`, but `removeImageViewerMarker` treats the mere presence of that key as proof the entire original state was non-record and returns only its value (plan lines 233-249). For example, `{ from: 'inbox', __hcImageViewerPriorState: 'legitimate' }` becomes the scalar `'legitimate'` on removal, losing `from` and the record shape. Likewise, a pre-existing `__hcImageViewer` field is overwritten on add and deleted on remove.

The planned tests cover an ordinary record and several non-record values but no namespace collision (plan lines 182-202), so all listed gates can pass while this corruption remains.

### What it implies

Stale-marker normalization can silently destroy valid React Router user state, contradicting the central history invariant. The encoding needs an unambiguous record/non-record discriminator and collision-safe preservation of any prior namespaced fields, with explicit collision tests before this exact implementation is handed to a builder.

## 4. [BLOCKING] The desktop Playwright sequence records its expected scroll positions after the provider has already captured different ones

### What is wrong

The spec and provider algorithm capture scroll owners synchronously in the thumbnail open callback (`docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:256-265`; plan lines 421-440). But Task 8 Step 1 clicks the trigger and leaves the dialog open (plan lines 980-997). Step 2 then says "Before opening" and mutates the trigger's ancestor scroll positions (lines 999-1025), even though no second open occurs and the provider already recorded the pre-Step-2 values. Escape must therefore restore the values captured by Step 1, while the test compares against the later Step-2 values (lines 1028-1038).

### What it implies

A correct implementation fails the prescribed browser test, and an implementation that restores the later values would violate the specified capture-on-open behavior. The scroll setup must occur before the Step 1 click, or Step 1 must close and Step 2 must set the owners before a fresh open. As written, Task 8 cannot go green literally.

## 5. [MEDIUM] The focused Playwright command is the repository's documented swallowed-argument form

### What is wrong

Task 8 runs `npm run e2e -- --grep "Outbound MMS"` and claims it delegates the grep through the e2e workspace (plan lines 1090-1096). The root script is itself a nested npm invocation, `npm run e2e -w @housingchoice/e2e` (`package.json:39-42`), while the workspace script is the actual `playwright test` command (`e2e/package.json:6-10`). This repository already documents the required forwarding form as `npm run e2e -w @housingchoice/e2e -- --grep ...` (`documentation/sequence-diagram-to-test.md:75-79`) and explicitly records that bare `npm run e2e -- --grep` is swallowed by the nested script (`docs/superpowers/plans/2026-06-29-sequence-diagram-e2e-scenarios.md:1360-1365`; the same warning appears at `docs/superpowers/plans/2026-08-16-manual-extraction-trigger.md:1794-1797`).

### What it implies

Task 8 can report a misleading focused result without running the changed Playwright cases. The final bare full-suite gate may expose the damage later, but the task-level proof and debugging checkpoint are false. Use the documented workspace-qualified command.

## 6. [MEDIUM] The retry-collapse "following Back is normal" assertion is unobservable in the mandated one-entry MemoryRouter harness

### What is wrong

Task 5 directs image-bearing Timeline tests to use `MemoryRouter -> ImageViewerProvider` (plan lines 663-684), matching the existing `Timeline.test.tsx` helper's single-entry `MemoryRouter` (`dashboard/src/routes/contact/Timeline.test.tsx:15-30`). The retry-collapse step then says to close the viewer, "call browser Back once," and assert ordinary router history behavior (plan lines 686-690). `window.history.back()` does not drive a `MemoryRouter`; and even if the builder invents an exposed `navigate(-1)` control, a one-entry memory history makes the post-close Back a no-op. That cannot distinguish correct single traversal from an extra hidden viewer entry or a damaged prior entry.

### What it implies

The only test tied to source-renderer removal can pass vacuously or be impossible to drive. The plan must specify a real `BrowserRouter` history test for this case, or seed a `MemoryRouter` with a distinct prior entry/current index and expose router Back plus an observable prior-route destination. Without that, the spec's retry-collapse-followed-by-normal-Back guarantee is not actually tested.
