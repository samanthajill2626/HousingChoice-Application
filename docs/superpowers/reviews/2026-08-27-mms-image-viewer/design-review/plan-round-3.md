# Adversarial implementation-plan review - round 3

## 1. [HIGH] The full-canvas `object-fit` box can be panned until the actual image pixels disappear

### What is wrong

The accepted round-1 geometry repair makes the transform content and the `<img>` element both the full canvas size, then uses `object-fit: contain` to letterbox the actual image pixels inside that box. `react-zoom-pan-pinch` does not know about those inner object-fit pixels: it calculates bounds from the transform content element's `offsetWidth` and `offsetHeight`. At high scale it therefore bounds the full canvas-sized box, not the fitted bitmap. On any axis where the fitted bitmap occupies less than 75% of the canvas, the allowed scale-8 boundary can put the bitmap completely outside the viewport while blank letterbox area remains in bounds.

The planned browser assertion is unable to catch this exact failure. It checks the `<img>` element's bounding box, but that box is deliberately the full transform box; it intersects the canvas at every legal package boundary even when the object-fit pixels inside it are entirely offscreen. The mobile test uses only a scale-1.8 pinch and one 60px drag, so it never drives the square fixture to a high-zoom boundary.

### Evidence

- The spec requires bounded panning such that the image cannot be lost completely off canvas at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:202-209`.
- Plan lines 648-660 set the transform content to `width: 100%`/`height: 100%`, and line 698 sets the child image to the same full box with `object-fit: contain`.
- The pinned library calculates scaled bounds from `contentComponent.offsetWidth`/`offsetHeight`, not the child's rendered object-fit content: [`bounds.utils.ts` v4.0.4 lines 10-24](https://github.com/BetterTyped/react-zoom-pan-pinch/blob/v4.0.4/src/core/bounds/bounds.utils.ts#L10-L24) and [lines 54-57](https://github.com/BetterTyped/react-zoom-pan-pinch/blob/v4.0.4/src/core/bounds/bounds.utils.ts#L54-L57).
- The failure follows directly from those bounds. For a canvas axis `C`, fitted-pixel size `p`, and scale 8, the package permits translation `C - 8C = -7C`. The fitted pixels' far edge is then `-7C + 8(C + p)/2 = 4p - 3C`, which is already outside the canvas when `p < 0.75C`.
- Plan line 1263 checks the transformed `<img>` bounding box rather than the rendered bitmap; lines 1237-1260 exercise only a 1.8 pinch and one short drag.

### What it implies

A normal portrait or landscape attachment can be dragged completely out of sight at high zoom while every planned assertion remains green. Task 4 must make the package's bounded content box match the fitted bitmap aspect ratio (or supply equivalent bitmap-aware custom bounds), and Task 8 must drive an extreme-aspect fixture to each high-zoom pan boundary and verify visible bitmap pixels remain.

## 2. [MEDIUM] The router-state guard still corrupts non-record structured-clone values

### What is wrong

Task 2 promises to retain every non-record router-state value, but its exact `isRecord` guard classifies every non-null, non-array object as a record. A `Date`, `Map`, `Set`, or other structured-cloneable non-record value therefore takes the spread-object branch instead of the owned prior-state wrapper. For example, spreading a `Date` retains none of its value; after marker removal the result is an empty object rather than the original date. The tests enumerate scalar and array non-records but omit the whole object-valued non-record surface that the guard mishandles.

### Evidence

- The spec requires a non-record value to be retained under the namespaced prior-state field at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:239-248`.
- Plan lines 242-244 define `isRecord` solely as `typeof value === 'object'`, non-null, and not an array.
- Plan lines 250-260 spread every value accepted by that guard; a `Date` or `Map` has no enumerable data representing its structured value, so this path discards it.
- Plan lines 197-202 test strings, null, arrays, and numbers plus record-key collisions, but no object-valued non-record.
- The plan itself declares the helper input as React Router user state `unknown` at lines 178-180, so narrowing the contract to JSON/plain objects is not stated anywhere.

### What it implies

Reload normalization of an open viewer can silently rewrite legal pre-viewer state even after the namespace-collision fix. The guard must distinguish plain records from other objects and wrap the latter as non-record state, with at least `Date` and `Map` round-trip tests.

## 3. [MEDIUM] Repeated boundary commands still cannot produce repeated live announcements

### What is wrong

The round-2 fix clears stale pending ownership, but the rendered announcement state remains only a percentage string. Two keyboard commands with the same result - for example pressing `0` twice at the fitted view, `-` repeatedly at minimum, or `+` repeatedly at maximum - both call `setAnnouncement('100%')` or `setAnnouncement('800%')`. After the first command, the second assignment does not change React state or live-region text, so assistive technology receives no new DOM update to announce. The monotonically increasing command id is used only for arbitration and is never represented in the live-region update. The new test presses `0` only once, so it confirms stale-pending cleanup without proving the specified per-command announcement.

### Evidence

- The spec requires the resulting percentage after a keyboard zoom command at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:217-225`.
- Plan lines 669-677 assign only the percentage string in the fallback, and lines 680-693 do the same from `onTransform` and render only `{announcement}`.
- Plan line 617 covers one no-op `0` followed by pointer input; it does not repeat a command whose resulting percentage is unchanged.

### What it implies

The accepted no-op repair still fails on the second identical boundary command. The plan needs a per-command DOM mutation that can re-announce an unchanged percentage without exposing the command id, plus a repeated-`0` and repeated-max/min test.

## 4. [MEDIUM] The browser gate does not prove multiple intermediate wheel or pinch levels

### What is wrong

The spec explicitly rejects binary zoom and requires multiple intermediate wheel and pinch levels. The desktop recipe sends three wheel events but samples only one final scale, asserting merely `1 < scale <= 8`; an implementation that jumps to 8 on the first event and stays there passes. The mobile recipe sends one pinch and likewise samples only the final `scale > 1`. The mocked prop assertion proves that a `step` option was passed, not that real Chromium produces multiple distinct intermediate levels.

### Evidence

- The product contract requires multiple intermediate wheel and pinch levels at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:202-207`.
- The required Playwright proof says to use wheel input at multiple steps and inspect the transform at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:537-543`.
- Plan line 1193 performs three wheel calls before one final poll; no per-event scale is retained or compared.
- Plan lines 1237-1247 perform one pinch and one final above-1 check.
- Plan lines 600-612 only inspect mocked wrapper configuration.

### What it implies

The plan can claim the core non-binary zoom contract from a test that a binary implementation passes. Record scale after successive wheel inputs and at multiple pinch distances, then assert distinct monotonic intermediate values below the maximum before separately proving the cap.
