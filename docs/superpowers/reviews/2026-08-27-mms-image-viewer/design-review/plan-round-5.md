# Adversarial implementation-plan review - round 5

## 1. [BLOCKING] The exact wheel configuration jumps to scale 8 on the first planned wheel event

### What is wrong

The plan configures `wheel.step` as `0.2` but leaves the pinned package's top-level `smooth` option at its default `true`. In `react-zoom-pan-pinch` 4.0.4, smooth wheel zoom multiplies `wheel.step` by the absolute browser `deltaY`; it does not treat `step` as the whole increment. The plan's first exact Playwright input is `page.mouse.wheel(0, -80)`, so the package computes a zoom increment of `0.2 * 80 = 16`, targets scale 17 from scale 1, and clamps immediately to 8.

This is both a shipped product failure and an impossible browser test. A conventional discrete mouse-wheel delta jumps directly to the maximum instead of providing multiple intermediate levels. The first stored Playwright value becomes 8, so the second event can never poll above it and the required third value cannot be below 8. Round-3 adjudication described these samples as separately settled without checking the exact package's delta-sensitive step calculation.

### Evidence

- The spec requires multiple intermediate wheel levels, a non-binary zoom path, and a maximum scale of 8 at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:202-207`.
- Task 4 requires `wheel: { step: 0.2 }` in both the mock assertion and production markup: plan lines 631-645 and 700-715. It never sets the top-level `smooth` prop.
- The inspected npm tarball for the pinned `react-zoom-pan-pinch@4.0.4` sets `smooth: true` by default in `package/src/constants/state.constants.ts:26`.
- That exact version calculates `zoomStep = smooth ? step * Math.abs(event.deltaY) : step` in `package/src/core/wheel/wheel.logic.ts:61-67`, then calculates `targetScale = scale + delta * step` and clamps it through the configured bounds in `package/src/core/wheel/wheel.utils.ts:110-137`.
- Task 8 sends exact `deltaY = -80` events and requires three strictly increasing values with the third still below 8: plan line 1316. With the planned config, the arithmetic is `1 + (0.2 * 80) = 17`, clamped to 8 on event one.
- The accepted round-3 adjudication claims separately settled intermediate wheel values at `.superpowers/design-review/adjudications.md:355-363`, but the revised test cannot produce them under the pinned implementation.

### Concrete correction

Make the package behavior independent of wheel-delta magnitude by explicitly setting `smooth={false}` while retaining `wheel.step: 0.2` (or choose and empirically prove a much smaller smooth step against both discrete mouse and trackpad deltas). Add the chosen top-level prop to the controlled-module assertion. Keep the three per-event Playwright samples; once the production config is corrected, they become a real non-binary enforcement rather than an impossible expectation. The live QA must exercise both a discrete mouse-wheel sequence and trackpad-style small deltas.

### Decision / enforcement impact

This does **not** change a product decision: it is required to deliver the already approved non-binary wheel contract. It changes the Task 4 gesture configuration, its component enforcement, Task 8's now-executable browser proof, and the live-QA input surface. The plan cannot be built to green literally until corrected.

## 2. [HIGH] `minScale={1}` and `maxScale={8}` are not hard bounds for pinch or trackpad-pinch

### What is wrong

The plan assumes that setting `minScale={1}` and `maxScale={8}` guarantees the approved 1..8 range, but `react-zoom-pan-pinch` 4.0.4 enables elastic zoom padding by default. Its pinch path deliberately permits `minScale - zoomAnimation.size` through `maxScale + zoomAnimation.size`; the defaults are enabled with size `0.4`. Touch pinch and Ctrl-modified wheel events used for trackpad pinch can therefore report scales from 0.6 to 8.4 before the package animates back inside 1..8 after gesture end.

Neither `centerZoomedOut` nor `limitToBounds` disables this scale padding. The planned configuration omits both `disablePadding` and a disabled/zero-size `zoomAnimation`. As a result, both approved scale bounds are transiently false during direct manipulation, and Task 8's instruction to assert that a large pinch "never exceeds 8" is timing-dependent: an immediate diagnostic sample can observe 8.4, while a late sample after the 200 ms alignment animation can hide the violation. The plan has no corresponding real-browser attempt to pinch or trackpad-zoom below scale 1 at all.

### Evidence

- The spec states maximum scale 8 and scale stays within 1..8 at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:202-209` and `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:443-446`.
- Task 4 sets `maxScale={8}`, `centerZoomedOut`, and `limitToBounds`, but no padding-disabling prop: plan lines 700-715. The controlled mock likewise omits any hard-cap option at lines 631-645.
- In the inspected 4.0.4 tarball, zoom animation defaults to `disabled: false`, `size: 0.4`, and `animationTime: 200` in `package/src/constants/state.constants.ts:69-73`.
- The pinned pinch calculation calls `checkZoomBounds(..., !disabled && !disablePadding)` in `package/src/core/pinch/pinch.utils.ts:88-94`. `checkZoomBounds` explicitly derives padded minimum and maximum scales and returns them at either boundary in `package/src/core/zoom/zoom.utils.ts:46-59`; with the configured 1, 8, and default padding 0.4, those bounds are 0.6 and 8.4.
- Pinch stop only then calls `handleAlignToScaleBounds` in `package/src/core/pinch/pinch.logic.ts:128-138`, so the correction is asynchronous rather than a hard input cap.
- Task 8 applies a large pinch and asks for a never-above-8 assertion without defining a continuous/transient sample or disabling the package overshoot: plan lines 1380-1386.

### Concrete correction

Set `disablePadding` on `TransformWrapper` (or explicitly disable/zero the zoom animation if that is the chosen package-supported hard-bound mechanism), assert that prop in the Task 4 controlled mock, and add real touch plus Ctrl-wheel/trackpad browser checks that inspect every reported diagnostic scale at both bounds during the gesture as well as the settled result. Do not repair only the test by waiting for the animation back inside 1..8; that would preserve the product-contract violation.

### Decision / enforcement impact

This does **not** change the approved 1..8 decision. It corrects Task 4 package configuration and expands component/browser enforcement to cover transient touch and trackpad scale, not only post-gesture settled state.
