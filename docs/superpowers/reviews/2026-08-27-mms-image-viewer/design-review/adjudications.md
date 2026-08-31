# MMS image viewer design adjudications

## Spec round 1

Review inputs:

- `spec-round-1-a.md`: 5 findings
- `spec-round-1-b.md`: 3 findings
- 8 reported claims, 7 unique after combining the duplicated BrowserRouter
  history-state finding

### A1. Raw history marker can corrupt the active React Router entry

- Reviewer severity: BLOCKING
- Decision: ACCEPT
- Adjudication: `BrowserRouter` owns the browser entry shape, and
  `QuickReply.tsx` explicitly warns against raw history mutation that discards
  router state. The spec will require router `navigate` with a namespaced marker
  in `location.state`, preserve pre-existing user state, and derive viewer state
  from `useLocation`.
- Decision changed: yes

### A2. Selected-image renderer unmount has no history cleanup

- Reviewer severity: BLOCKING
- Decision: ACCEPT
- Adjudication: Timeline retry collapse can remove the message component that
  opened the image. Gallery-local ownership is therefore too volatile. The spec
  will move selection, descriptor retention, history ownership, and the portal to
  one provider mounted under `BrowserRouter` and above the route tree. A removed
  trigger becomes a permitted no-focus-restore case, not a stale-history case.
- Decision changed: yes

### A3. Renderer inventory omits four current Timeline consumers

- Reviewer severity: HIGH
- Decision: ACCEPT
- Adjudication: `Timeline` is shared by contact, relay conversation, native group
  text, tour conversation, and placement conversation surfaces. The spec will
  enumerate all consumers and require route-host regression coverage in addition
  to shared component tests.
- Decision changed: yes

### A4. Scroll preservation ignores the actual scroll owners

- Reviewer severity: HIGH
- Decision: ACCEPT
- Adjudication: `AppFrame .content` and `Timeline .stream` are independent nested
  scroll owners, so a body-only lock cannot satisfy the guarantee. The spec will
  require inert background content, snapshot every scrollable ancestor of the
  trigger plus the document scrolling element, intercept canvas gestures, restore
  connected owners before focus restoration, and test both page and Timeline
  positions.
- Decision changed: yes

### A5. MediaGallery accessible fallback is misdescribed

- Reviewer severity: LOW
- Decision: ACCEPT
- Adjudication: current code says `Attachment`, not `Image attachment`. The new
  button conversion will deliberately use the exact trigger name `View image
  attachment` and image alternative text `Image attachment`, with tests naming
  the copy change.
- Decision changed: no; precision correction only

### B1. Raw viewer history can corrupt BrowserRouter entry state

- Reviewer severity: BLOCKING
- Decision: ACCEPT (duplicate of A1)
- Adjudication: Same resolution as A1. Tests will begin from an entry with existing
  router user state and prove it survives open, Back, Forward, and ordinary route
  navigation.
- Decision changed: yes (counted once with A1)

### B2. Forward then reopen leaves an extra dead Back stop

- Reviewer severity: HIGH
- Decision: ACCEPT
- Adjudication: Back moves the cursor; it does not delete an entry. During the
  current app lifetime the provider will retain descriptors by token, so Forward
  to a live marker reopens the viewer and is not a dead stop. After reload the
  registry is intentionally empty; a stale-marker guard performs one router Back
  to the known underlying same-URL entry and never reconstructs the image. A new
  open from an underlying entry truncates its forward branch normally.
- Decision changed: yes

### B3. Exactly-one history invariant lacks a StrictMode-safe lifecycle

- Reviewer severity: HIGH
- Decision: ACCEPT
- Adjudication: The marker push will occur once in the user click callback through
  router navigation, never in the viewer mount effect. The provider derives open
  state from the router location and uses idempotent effects only for focus,
  scroll, and stale-marker handling. BrowserRouter tests will mount under
  `StrictMode` and count entries/dismissals.
- Decision changed: yes

## Spec round 2

Review input: `spec-round-2.md` (3 findings)

### R2.1. Local close on ownership mismatch contradicts location-only state

- Reviewer severity: BLOCKING
- Decision: ACCEPT
- Adjudication: A visible viewer exists only when the current router marker resolves
  to a retained descriptor, so its ownership is already proven. A late dismissal
  callback after the marker changes is a no-op; it does not have a local-close
  transition. An unknown current marker follows the separate normalization path.
- Decision changed: yes

### R2.2. Reload recovery leaves a stale Forward bounce

- Reviewer severity: HIGH
- Decision: ACCEPT
- Adjudication: Moving Back cannot retire the Forward entry. Unknown tokens will be
  normalized in place with router `navigate(..., { replace: true })`, removing only
  the namespaced marker and restoring the preserved prior user state. The current
  page stays put, Back/Forward traverse ordinary clean entries, and the unavoidable
  same-URL duplicate after reloading an open overlay is documented and tested.
- Decision changed: yes

### R2.3. The portal has no explicit topmost layer

- Reviewer severity: MEDIUM
- Decision: ACCEPT
- Adjudication: Current dashboard CSS tops out at z-index 100 in the portaled
  contact/unit search listboxes. The viewer will own layer 200 and mark every body
  child except its portal container inert while open, preserving each prior inert
  value. Existing portals need not be force-closed; they remain below and inert.
- Decision changed: yes

## Spec round 3

Review input: `spec-round-3.md` (1 finding)

### R3.1. Independent navigation can restore old scroll into the new route

- Reviewer severity: HIGH
- Decision: ACCEPT
- Adjudication: `AppFrame .content` persists across Outlet route changes, so
  connectedness alone is insufficient. The marker/registry will record the exact
  underlying `location.key`. Scroll and trigger focus restore only when dismissal
  lands on that key. Any other location is authoritative: remove the portal and
  inert state, discard snapshots, and do not write scroll or focus.
- Decision changed: yes

## Spec round 4

Review input: `spec-round-4.md`

- Findings: 0
- Decision changes: 0
- Result: terminal round; adversarial spec review converged

## Plan round 1

Review inputs:

- `plan-round-1-a.md`: 5 findings
- `plan-round-1-b.md`: 6 findings
- 11 reported claims, 9 unique after combining the duplicated `files.test.tsx`
  and router-state namespace-collision findings

### P1. Existing image-bearing file-pane test lacks the required provider

- Reviewer severity: BLOCKING (both reviewers)
- Decision: ACCEPT
- Adjudication: `files.test.tsx` renders a real PNG through TenantFile and
  MediaGallery under a bare MemoryRouter. Once the eligible branch owns the
  required viewer hook, that existing test must use the production-equivalent
  provider boundary. Task 6 now owns, runs, updates, and commits that file.
- Decision changed: yes

### P2. Transform geometry does not fit or center the actual image

- Reviewer severity: HIGH
- Decision: ACCEPT
- Adjudication: A full-size transform content box does not center or scale an
  intrinsic 2x2 image by itself. Task 4 now gives the transformed image a
  full-canvas width/height box with object-fit contain and centered transform
  content. Chromium must prove the scale-1 image box is contained and centered,
  including the existing 2x2 fixture.
- Decision changed: yes

### P3. Early prerequisite sync cannot silently replace final main freshness

- Reviewer severity: HIGH
- Decision: ACCEPT
- Adjudication: The media classification prerequisite forces a pre-build sync,
  but completion still requires current main. Task 9 now treats an unchanged
  main SHA as satisfying both conditions. If main advances, the orchestrator
  stops at STATUS: QUESTION before QA/gates/merge-ready claims and asks the human
  whether to authorize a second sync; declining yields a non-merge-ready handback.
- Decision changed: yes

### P4. Router-state removal corrupts pre-existing namespace collisions

- Reviewer severity: MEDIUM/HIGH
- Decision: ACCEPT
- Adjudication: Key presence alone cannot distinguish an owned wrapper from a
  legitimate existing field. Task 2 now uses a versioned owned marker with an
  explicit record/non-record discriminator, retains any prior marker value inside
  the owned envelope, associates wrapped non-record state with the token, and
  round-trips records already containing both reserved names.
- Decision changed: yes

### P5. Generic ancestor counting does not prove the AppFrame owner

- Reviewer severity: MEDIUM
- Decision: ACCEPT
- Adjudication: The desktop test now identifies AppFrame by its semantic main
  element and Timeline by the distinct nested overflow ancestor, deliberately
  makes each scrollable, assigns nonzero positions before open, and compares each
  named owner independently after dismissal.
- Decision changed: no; test precision

### P6. Host fixture invents providerSid instead of the identifier readers use

- Reviewer severity: BLOCKING
- Decision: ACCEPT
- Adjudication: `messageSid` derives the served-media SID from `tsMsgId`, while
  wire Message uses `provider_sid`. Task 7 now supplies a complete TimelineItem
  with a `#MMHOST1` tsMsgId and a complete wire Message factory containing both
  `tsMsgId` and `provider_sid`; the camel-case property is forbidden explicitly.
- Decision changed: no; fixture correction

### P7. Desktop scroll setup occurs after the provider already captured state

- Reviewer severity: BLOCKING
- Decision: ACCEPT
- Adjudication: Task 8 now leaves the viewer closed in Step 1, arranges and names
  both real scroll owners in Step 2, records exact positions, verifies the trigger
  remains visible, and only then clicks. The provider and assertion therefore use
  the same pre-open snapshot.
- Decision changed: no; test ordering correction

### P8. Focused Playwright command swallows grep at the root script

- Reviewer severity: MEDIUM
- Decision: ACCEPT
- Adjudication: The focused command is now the repository-documented workspace
  form `npm run e2e -w @housingchoice/e2e -- --grep "Outbound MMS"`; the plan names
  why the shorter nested form is invalid.
- Decision changed: no; command correction

### P9. Retry-collapse follow-up Back is unobservable in one-entry MemoryRouter

- Reviewer severity: MEDIUM
- Decision: ACCEPT
- Adjudication: The retry-collapse case now gets a dedicated BrowserRouter harness
  seeded with observable `/prior` and `/timeline` entries. After the source row
  disappears and the viewer closes, the next Back must render PRIOR ROUTE, proving
  there is no hidden extra viewer entry.
- Decision changed: yes

- Rejected: 0
- Deferred: 0
- Decision changes: 5

## Plan round 2

Review input: `plan-round-2.md` (5 findings)

### R2.1. Timeline attachment fixture omits required s3Key

- Reviewer severity: BLOCKING
- Decision: ACCEPT
- Adjudication: Both TimelineMessage and wire Message require s3Key on every
  media_attachments element. Task 5's concrete PNG fixture now includes a
  deterministic key, so the expected red is the old anchor behavior rather than
  a permanent type error.
- Decision changed: no; fixture correction

### R2.2. Two host seams refer to an undefined message identifier

- Reviewer severity: BLOCKING
- Decision: ACCEPT
- Adjudication: Task 7 now uses the declared `timelineMessage` in ContactDetail,
  ContactCommsPane, TourConversation, and PlacementConversation, while the two
  conversation hosts use the separately declared complete wire-message factory.
- Decision changed: no; identifier correction

### R2.3. Separate mobile test reuses a desktop-scoped trigger

- Reviewer severity: BLOCKING
- Decision: ACCEPT
- Adjudication: The mobile sequence now locates its own Communications and
  activity region and local `View Attachment 1` trigger after its own send, then
  waits for that trigger before opening.
- Decision changed: no; test scoping correction

### R2.4. No-op keyboard reset leaves a stale pending announcement

- Reviewer severity: MEDIUM
- Decision: ACCEPT
- Adjudication: Pinned package source confirms reset returns without onTransform
  when scale and position already equal the initial state. Task 4 now assigns an
  id per keyboard command: onTransform announces and clears it when emitted; a
  microtask fallback reads current ref state and clears a no-op. A test presses 0
  at fit, expects 100%, then proves later pointer input is not announced as that
  command.
- Decision changed: yes

### R2.5. Unbounded filename can displace mobile actions

- Reviewer severity: HIGH
- Decision: ACCEPT
- Adjudication: Existing Modal header flex rules have no shrink floor and stored
  inbound filenames may consume an 8 KiB budget. Task 1 now keeps the full
  accessible heading while visually ellipsizing the media title and making
  Download/Close non-shrinking. Task 8 mutates the real mobile heading to a 2048
  character unbroken filename and measures both actions and overflow.
- Decision changed: yes

- Rejected: 0
- Deferred: 0
- Decision changes: 2

## Plan round 3

Review input: `plan-round-3.md` (4 findings)

### R3.1. Full-canvas bounds can lose letterboxed image pixels

- Reviewer severity: HIGH
- Decision: ACCEPT
- Adjudication: The package bounds its content element, not object-fit pixels
  inside that element. Task 4 now measures natural image and canvas dimensions,
  computes the fitted bitmap box, and gives TransformComponent that exact pixel
  size. The visible image fills the same-aspect box, so package bounds and actual
  pixels coincide. Desktop/mobile high-zoom tests drag toward every boundary and
  require positive real-image overlap.
- Decision changed: yes

### R3.2. Record guard spreads Date and Map into corrupted objects

- Reviewer severity: MEDIUM
- Decision: ACCEPT
- Adjudication: Task 2 now recognizes only plain Object/null-prototype records.
  Date, Map, Set, arrays, and class instances use the owned non-record wrapper;
  Date and Map exact round trips are required tests.
- Decision changed: yes

### R3.3. Repeated equal percentages do not mutate a string-only live region

- Reviewer severity: MEDIUM
- Decision: ACCEPT
- Adjudication: Announcement state now carries a sequence used only as a keyed
  child. Every keyboard command replaces that hidden child even when its text is
  still 100% or 800%; pointer transforms never replace it. The test presses 0
  twice at fit and checks node identity plus the later pointer non-announcement.
- Decision changed: yes

### R3.4. Final-only scale samples do not prove intermediate levels

- Reviewer severity: MEDIUM
- Decision: ACCEPT
- Adjudication: Desktop now records three separately settled wheel scales and
  requires strict increase below 8 before proving the cap. Mobile records two
  separately settled pinch scales with the same monotonic/intermediate contract
  before applying a larger pinch and boundary pans.
- Decision changed: no; browser-proof precision

- Rejected: 0
- Deferred: 0
- Decision changes: 3

## Plan round 4

Review input: `plan-round-4.md` (2 findings)

### R4.1. Fitted-bitmap transform lacks a definite canvas sizing chain

- Reviewer severity: HIGH
- Decision: ACCEPT - OPEN AT HUMAN HARD-CAP GATE
- Adjudication: Current Modal body/bodyInner are intrinsic-height boxes. Measuring
  the canvas before mounting the transform is circular unless the media dialog,
  body, body-inner, viewer root, and canvas establish a definite flex-fill chain
  with `flex: 1`, `min-height: 0`, and positive remaining height. The proposed
  revision assigns those media-only rules and adds desktop/mobile Chromium checks
  that the canvas occupies the usable region below the action bar, not merely a
  contained postage-stamp region.
- Decision changed: yes; adds the concrete layout surface that owns available
  canvas geometry

### R4.2. Renderer tests do not load the conditionally mounted viewer image

- Reviewer severity: HIGH
- Decision: ACCEPT - OPEN AT HUMAN HARD-CAP GATE
- Adjudication: jsdom does not fetch the media URL. Timeline, MediaGallery,
  UnknownFile, and files.test integration cases must locate the dialog's hidden
  probe, define naturalWidth/naturalHeight and a positive observed canvas size,
  fire load, then scope the meaningful image assertion inside the dialog. A
  global image query can otherwise match the original thumbnail and pass
  vacuously.
- Decision changed: no; integration-test observability correction

- Rejected: 0
- Deferred: 0
- Decision changes: 1
- Result: hard cap reached with a decision-changing accepted finding. Per the
  feature-mission workflow, stop and ask the human whether to authorize the two
  final revisions without a fifth adversarial round or reopen the plan design.
- Human authorization: on 2026-08-27, the user explicitly authorized both
  accepted revisions and one additional adversarial round, overriding the normal
  four-round plan-review cap for this mission. The revisions are incorporated in
  the plan; round 5 remains pending.

## Plan round 5

Review input: `plan-round-5.md` (2 findings)

### R5.1. Smooth wheel arithmetic jumps directly to scale 8

- Reviewer severity: BLOCKING
- Decision: ACCEPT
- Adjudication: The independently downloaded npm tarball for pinned
  `react-zoom-pan-pinch@4.0.4` confirms `smooth: true` by default and computes a
  smooth wheel increment as `step * abs(deltaY)`. The planned `step: 0.2` with
  Playwright `deltaY: -80` therefore targets 17 from scale 1 and clamps the first
  event to 8. Task 4 now sets and unit-enforces top-level `smooth={false}`, which
  makes 0.2 the complete increment regardless of delta magnitude. Task 8 keeps
  the discrete-wheel sequence and separately tests small-delta Ctrl-wheel input;
  live self-QA names both device paths.
- Decision changed: no; corrects package configuration and makes the approved
  multi-level wheel behavior enforceable

### R5.2. Default elastic padding violates hard 1..8 bounds during gestures

- Reviewer severity: HIGH
- Decision: ACCEPT
- Adjudication: The same pinned source confirms `disablePadding: false` and a
  default zoom-animation padding size of 0.4. Pinch and Ctrl-wheel calculations
  can therefore emit 0.6 or 8.4 before settling. Task 4 now sets and unit-enforces
  top-level `disablePadding`; Task 8 records every diagnostic attribute mutation
  during mouse wheel, Ctrl-wheel, and touch pinch, including below-minimum and
  above-maximum attempts, and requires every transient sample to stay within
  1..8. Live self-QA repeats both boundaries.
- Decision changed: no; enforces the already approved hard scale range during
  direct manipulation instead of only after package alignment

- Rejected: 0
- Deferred: 0
- Decision changes: 0
- Result: plan review converged. Round 5 found two enforcement defects and both
  were accepted without changing an approved product decision. It expressly
  found no further defect in the round-4 flex-fill sizing or scoped probe-load
  revisions.
