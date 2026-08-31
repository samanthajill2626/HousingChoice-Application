# Adversarial implementation-plan review - round 4

## 1. [HIGH] The fitted-bitmap transform has no independently sized canvas to measure

### What is wrong

The revised bitmap-aware bounds design measures the outer canvas before it mounts the transform, but the plan never gives that canvas an independently resolved height. The existing Modal is a flex column, yet its body and body-inner are intrinsic-height boxes rather than flex-fill boxes. Giving the media dialog a viewport height therefore does not make its body or the empty canvas consume the remaining height. Before the transform mounts, the canvas has either zero height or only the loading indicator's intrinsic height; after it mounts, the `height: 100%` transform wrapper has no definite containing-block height and can preserve that zero/postage-stamp result. This is circular: the fitted transform needs a positive canvas height, while the canvas is allowed to derive its height from the fitted transform that does not exist yet.

The revised tests bypass the cycle instead of detecting it. The component test directly mocks a 1000x600 canvas. The desktop browser recipe checks only that the image is contained and centered in whatever canvas exists, and the mobile recipe checks the dialog and action geometry, not that the canvas fills the shell's remaining usable area. A 24x24 canvas centered nowhere useful can satisfy those assertions.

### Evidence

- The spec requires a large desktop media dialog with an image fitted to the available canvas, and a mobile canvas below reachable actions, at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:172-190`.
- The current Modal dialog is a flex column, but `.body` only has `overflow: auto` and `.bodyInner` only has padding; neither grows or supplies `min-height: 0`: `dashboard/src/routes/contact/Modal.module.css:14-35` and `dashboard/src/routes/contact/Modal.module.css:74-86`.
- Task 1 specifies media backdrop/dialog and header geometry but no media body/body-inner fill behavior: plan lines 151-153.
- Task 4 reads `canvas.clientWidth/clientHeight` and refuses to mount `TransformWrapper` until both yield a positive fitted box: plan lines 658-660. The shown wrapper is the canvas's only substantial child and uses `height: '100%'`: plan lines 665-688.
- Task 4's CSS instruction specifies overflow, gesture, and bitmap styles but no flex/grid growth, definite canvas height, or media-body layout chain: plan lines 726-732.
- The component test supplies 1000x600 through a mock rather than CSS layout (plan line 640), while the desktop browser assertion accepts any contained, centered image/canvas pair (line 1234) and the mobile geometry assertion measures only the dialog and actions (line 1280).

### What it implies

A literal implementation can remain on the loading shell forever or display the image in a loader-sized canvas inside an otherwise full-height modal. It can also retain the default 30rem desktop width because no concrete large desktop geometry is required. The plan needs an explicit definite-size chain for the media dialog body, body-inner/viewer root, and canvas (including flex growth and `min-height: 0` where required), plus browser assertions that the canvas occupies the available region below the action bar at both viewports.

## 2. [HIGH] Renderer integration tests never load the conditionally mounted viewer image

### What is wrong

The new Task 4 design does not render the meaningful viewer image until an aria-hidden probe image fires `load`. Task 4's own focused test correctly dispatches that event. The later Timeline and MediaGallery tests, however, click the thumbnail and immediately query a globally scoped image role without dispatching probe load or scoping the assertion to the dialog.

Those tests run in jsdom, where the media URL is not a real browser-loaded subresource. Consequently, they have no sound green state: if the background thumbnail is excluded by inert semantics, the promised viewer image never mounts and the task remains red; if the test environment does not model inert in role queries, the global query can match the original thumbnail, which deliberately has the same alt text and source, and pass without any viewer image. The revised load architecture turned these assertions into either a structural failure or a false positive.

### Evidence

- The dashboard test environment is jsdom: `dashboard/vite.config.ts:116-122`.
- Task 4 mounts `TransformWrapper`, and therefore the meaningful `<img>`, only after the hidden probe has loaded and positive natural/canvas dimensions exist: plan lines 658-660 and 665-686.
- Task 4 explicitly fires `load` before asserting successful display: plan line 646.
- Task 5's Timeline tests click and then use `screen.getByRole('img', { name: 'Front porch.jpg' })` without a load event or dialog scoping; the original trigger also contains an image with that exact alt: plan lines 779-787 and 828-839.
- Task 6 repeats the same pattern for `Image attachment`, including an unscoped source assertion, while its trigger thumbnail has the same alt/source: plan lines 884-894 and 902-913, with the production shape at lines 927-944.

### What it implies

Tasks 5 and 6 cannot literally provide the claimed observable proof that each renderer supplied the viewer's image descriptor. Each integration test must locate and load the aria-hidden probe (with natural dimensions and canvas sizing arranged), then assert the meaningful image from within the dialog; otherwise a builder must improvise around a red gate or can ship an integration regression behind a thumbnail-matching false green.
