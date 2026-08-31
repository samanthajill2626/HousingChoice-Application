# Slice 5 - Timeline image renderer integration

## Result

- Shipped commit `d00e6399f4ee724fa1c4883557bcac49ea00a13a` (`feat: open timeline images in the shared viewer`).
- Converted only `isInlineRenderable` Timeline attachments from raw-window anchors to semantic viewer buttons.
- Preserved `messageMediaSrc`, filename/fallback labels, thumbnail alt text, gallery `stopPropagation`, and all non-image `_blank` links, including PDF and HEIC.
- The shared `AttachmentGallery` change covers MMS bubbles and email cards without host-local viewer state.

## TDD evidence

- RED: `npm test -w @housingchoice/dashboard -- src/routes/contact/Timeline.mms.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/contact/Timeline.test.tsx`
  - Exit 1.
  - 138 tests passed and 4 new tests failed because eligible images were still links rather than buttons named `View <attachment label>`.
  - The failing cases covered MMS, email, multi-image close-first selection, and real-BrowserRouter retry-collapse lifecycle.
- First GREEN: the same three-file command exited 0 with 3 files and 142 tests passed.

## Final focused verification

- `npm test -w @housingchoice/dashboard -- src/routes/contact/Timeline.mms.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/contact/Timeline.test.tsx src/ui/imageViewer/ImageViewerProvider.test.tsx`
  - Exit 0; 4 files and 150 tests passed.
- `npm run typecheck -w @housingchoice/dashboard`
  - Exit 0.
- `npx eslint dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.module.css dashboard/src/routes/contact/Timeline.mms.test.tsx dashboard/src/routes/contact/Timeline.email.test.tsx dashboard/src/routes/contact/Timeline.test.tsx`
  - Exit 1 from one pre-existing `react-hooks/set-state-in-effect` finding in `Timeline.tsx`; the CSS file also produced the expected no-matching-configuration warning.
  - Baseline proof: `git show HEAD:dashboard/src/routes/contact/Timeline.tsx | npx eslint --stdin --stdin-filename dashboard/src/routes/contact/Timeline.tsx` was run before the commit while HEAD was Slice 4 and exited 1 with the identical `setNow(fresh)` finding. The three touched test files reported no lint findings. Slice 5 introduced no new ESLint error.
- `git diff --cached --check` exited 0 before commit.
- Full `npm test`, smoke, and e2e were intentionally not run for this slice.

## Lifecycle coverage

- MMS and email tests install a positive 1000x600 ResizeObserver, open the labelled dialog, and load the viewer probe before asserting the meaningful image source.
- The multi-image test proves Front opens alone, no sibling navigation or Kitchen trigger is reachable inside the dialog, Close is required, and Kitchen then opens with its own loaded probe.
- The retry-collapse test uses real BrowserRouter history with `/prior` and `/timeline`. A loaded viewer survives removal of its source trigger, Close skips focus on that disconnected trigger, returns to timeline history index 1, and the next Back reaches `/prior` at index 0.

## Downstream host contract

- Timeline image triggers are buttons named exactly `View ${attachmentLabel}` with `aria-haspopup="dialog"`.
- Opening calls only `useImageViewer().openImage({ src, alt: label, title: label }, trigger)`; renderers do not own viewer state.
- Production-like host tests that render eligible Timeline images must use `MemoryRouter -> ImageViewerProvider`, install `installImageViewerResizeObserver({ width: 1000, height: 600 })` before render, restore it afterward, and call `loadViewerImage(dialog, expectedAlt)` before meaningful image assertions.
- PDF, HEIC, and every other non-inline attachment remain authenticated `_blank` file links.

## Files committed

- `dashboard/src/routes/contact/Timeline.tsx`
- `dashboard/src/routes/contact/Timeline.module.css`
- `dashboard/src/routes/contact/Timeline.mms.test.tsx`
- `dashboard/src/routes/contact/Timeline.email.test.tsx`
- `dashboard/src/routes/contact/Timeline.test.tsx`
