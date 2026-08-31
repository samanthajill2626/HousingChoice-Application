# Adversarial plan review - round 1 A

## 1. BLOCKING - Task 6 leaves an existing image-bearing file-pane test outside the provider and outside every commit

### What is wrong

The plan converts every eligible `MediaGallery` image into a component that unconditionally calls `useImageViewer`, and explicitly forbids a no-provider fallback, but it does not enumerate the existing `files.test.tsx` reader. That test already renders a PNG through the real `TenantFile`/`MediaGallery` path without `ImageViewerProvider`. Task 6's focused checks will therefore give a false green, Task 6 will commit a branch with an existing dashboard test regression, and Task 7's workspace-wide test will discover the failure only after the broken slice has been committed. No later task lists or stages `files.test.tsx`, so a literal builder has no clean commit path for the required repair.

### Evidence

- Existing test harness: `dashboard/src/routes/contact/files.test.tsx:54-90` renders `TenantFile` under `MemoryRouter` only; there is no `ImageViewerProvider`.
- Existing image reader: `dashboard/src/routes/contact/files.test.tsx:319-330` passes an `image/png` `CommsMediaItem`, which necessarily renders the new hook-owning image branch.
- Planned mandatory hook: plan lines 788-807 make the eligible branch call `useImageViewer()` during render.
- No fallback: plan line 912 explicitly forbids making `useImageViewer` work without a provider.
- False focused gate: plan lines 822-829 runs only `MediaGallery.test.tsx`, `UnknownFile.test.tsx`, and `media.test.ts`; it omits `files.test.tsx` and then commits Task 6 at lines 831-836.
- Late discovery with no ownership: the first full dashboard run is plan lines 954-961, while the following commit stages only the six Timeline host tests at lines 963-968.

### What it implies

The plan is not executable task-by-task to a clean branch. Add `dashboard/src/routes/contact/files.test.tsx` to Task 6, wrap its image-bearing render at the production-equivalent provider boundary, run it in Task 6's red/green checks, and stage it in the Task 6 commit.

## 2. HIGH - The planned transform box does not fit or center the image

### What is wrong

The plan makes both the transform wrapper and transform content fill the canvas, but gives the image only `max-width`/`max-height`. That does not size a smaller image to the fitted canvas and does not center any image inside the full-size flex content. At scale 1, the transform engine is centering the already-full-size content box, not the image inside it. A small image stays at intrinsic size at the content's start edge; the repository's actual Playwright MMS fixture is only 2x2 pixels, so the planned browser tests can exercise scale diagnostics while showing a 2x2 image in the corner.

### Evidence

- Locked behavior: spec section 2 decision 4 (`spec:41-42`) and section 5 (`spec:204-215`) require the image to start fitted and centered.
- Planned DOM sizing: plan lines 598-605 set both `wrapperStyle` and `contentStyle` to `width: 100%; height: 100%`, then render an otherwise unsized `<img>`.
- Planned CSS is insufficient: plan lines 624-626 specifies only `max-width: 100%`, `max-height: 100%`, and `object-fit: contain`; `object-fit` cannot create a containing box when the replaced element has no width/height, and no `align-items`/`justify-content` centering is specified for the full-size content.
- Real fixture: `e2e/tests/dashboard-next/outbound-mms.spec.ts:30-32` supplies `e2e/fixtures/tiny.png`; `magick identify e2e/fixtures/tiny.png` reports `PNG 2x2`.
- The proposed component test checks wrapper props and transform numbers (plan lines 548-569), and the browser plan checks dialog geometry and scale/position diagnostics (lines 980-1083), but neither asserts the image's fitted size or centered geometry.

### What it implies

A literal implementation violates the primary viewing contract while its planned tests remain green. The plan must specify the image/content geometry explicitly (for example, a full-canvas image box with `width`/`height` plus `object-fit: contain`, or an equivalent centered content layout) and add a scale-1 browser assertion that the image is centered and contained, including the existing 2x2 fixture.

## 3. HIGH - The plan replaces the spec's final `main` sync with an early-only sync

### What is wrong

The prerequisite genuinely forces one sync before implementation, but the spec also requires a final `main` sync before completion gates. The plan invents an "approved exception," forbids a second sync, and tells the builder to report later drift instead of resolving or blocking on it. If `main` advances during the build, the delivered branch is neither synced as specified nor eligible for the required completion-gate claim.

### Evidence

- Prerequisite sync: spec section 8 (`spec:378-384`) requires the media-fidelity commit on `main` and this worktree synced before viewer implementation.
- Final sync: spec section 12 (`spec:578-587`) says the bare gates run after implementation and final `main` sync.
- Early-only substitution: plan lines 37-61 calls the pre-implementation merge an exception and says never to sync `main` again.
- Incorrect handback behavior: plan lines 1116-1124 instructs the builder to report drift and proceed, not to obtain a human decision and withhold merge-ready completion.

### What it implies

On any mid-build `main` advance, following the plan literally produces a handback that does not meet the spec. The plan must distinguish the mandatory prerequisite sync from completion freshness: either perform the required final sync, or stop at `STATUS: QUESTION`/non-merge-ready if repository concurrency requires a human decision.

## 4. MEDIUM - Router-state removal destroys legal pre-existing record fields

### What is wrong

The state helper does not satisfy its advertised exact round trip. `addImageViewerMarker` spreads a record without recording whether either reserved key already existed. `removeImageViewerMarker` then treats the mere presence of `__hcImageViewerPriorState` as proof that the entire state was a wrapped non-record and returns only that field. A legal record such as `{ from: 'inbox', __hcImageViewerPriorState: 'keep' }` comes back as the string `'keep'`; the `from` field and the record shape are destroyed. Likewise, an existing malformed `__hcImageViewer` field is overwritten and cannot be restored during stale-marker normalization. The proposed tests omit both collisions.

### Evidence

- Exact-state requirement: spec router protocol (`spec:239-248`) requires every existing record field preserved, and testing (`spec:253-254`, `spec:474-487`) requires preservation through reload/stale normalization as well as Back/Forward.
- Faulty add/remove pair: plan lines 233-249 spreads record state, overwrites `__hcImageViewer`, and later returns `state[PRIOR_STATE_KEY]` whenever that property exists.
- Incomplete tests: plan lines 182-202 covers an ordinary record, a non-record string, malformed markers, arrays, numbers, and null, but no pre-existing reserved-key record.

### What it implies

Reload normalization or eviction cleanup can silently corrupt router user state even though the preservation tests pass. The marker envelope needs an unambiguous ownership/discriminant strategy, and tests must round-trip records already containing each reserved key.

## 5. MEDIUM - The Playwright scroll check neither identifies nor arranges the required AppFrame owner

### What is wrong

The spec requires real-browser proof for the Timeline stream and AppFrame content. The plan instead walks ancestors, assigns anonymous ordinal keys to whichever elements happen to overflow, and asserts only that at least two exist. That can pass on two incidental scrollers without proving AppFrame, or fail because the contact detail shell deliberately fills AppFrame and delegates scrolling to its panes. The step never targets the semantic `<main>` AppFrame owner and never arranges enough page overflow to make it scrollable.

### Evidence

- Required real owners: spec section 7.1 (`spec:346-370`) names `AppFrame .content` and `Timeline .stream`; Playwright requirements (`spec:537-550`) explicitly require both to be moved and restored.
- AppFrame owner is identifiable: `dashboard/src/app/AppFrame.tsx:194` renders the content owner as `<main className={styles.content}>`, and `dashboard/src/app/AppFrame.module.css:383-387` gives it `overflow-y: auto`.
- The route is designed to fill rather than overflow that owner: `dashboard/src/ui/twoPaneShell.module.css:11-16` makes the detail page `height: 100%`; lines 54-70 make the body flex and the right pane its own scroller. `dashboard/src/routes/contact/Timeline.module.css:110-118` makes the Timeline stream another independent scroller.
- Vacuous identity check: plan lines 1000-1025 records only generic `data-viewer-test-scroll-owner` ordinals and `expectedScroll.length >= 2`; it never proves that one owner is AppFrame `<main>`.

### What it implies

The planned Playwright result is not evidence for the named cross-layer restoration guarantee. The plan must locate the Timeline region's real stream and AppFrame `<main>` separately, deliberately make each scrollable/nonzero in the hermetic page, and assert each exact position by identity. Runtime AppFrame overflow at the stated 1280x900 fixture is UNVERIFIED; the current plan does not establish it either way.
