# Post-fix-wave adversarial re-review: in-app MMS image viewer

## Verdict

PASS. I found no new must-fix defect in the post-review delta and no unresolved
must-fix from the first review. The auth-boundary, synchronous-open, and
backdrop-coverage repairs are concrete and close `AD-2`, `AD-4`, and `SC-1`.
I agree with the recorded adjudications for `AD-1` and `AD-3`.

This was a read-only review of `fix-wave.diff`, `fix-wave.log`, both prior
review reports, `findings.md`, and the live repository. Per the dispatch I did
not run a test suite or browser lane. Read-only proof included the full
auth-state mutator/consumer sweep, the provider and history import/consumer
sweep, the live focus/inert cleanup paths, and `git diff --check
48d21f60d0a8b4b997d3299371534fc708943142..HEAD` (exit 0).

## What the prior passes might have missed

### Authentication lifetime and principal changes

- The provider now exists only in the authenticated branch at
  `dashboard/src/App.tsx:131-269`. `AuthGate` returns `Login` instead of its
  children when status becomes anonymous (`dashboard/src/app/AuthGate.tsx:10-19`),
  so logout necessarily unmounts the provider and destroys the descriptor map,
  portal node, and refs. This is a real lifetime boundary, not a conditional
  render inside a still-mounted provider.
- I specifically attacked an authenticated-to-authenticated principal swap.
  `AuthContext.refresh()` can replace `me` without first entering `loading`
  (`dashboard/src/app/AuthContext.tsx:27-40`), so the provider is scoped to an
  authenticated epoch rather than keyed directly by `me.userId`. The live
  principal-changing login paths do not exploit that seam: signout transitions
  through `anonymous` (`dashboard/src/app/AppFrame.tsx:43-56`), dev login reloads
  the document (`dashboard/src/routes/Login.tsx:53-60`), and OAuth also returns
  through navigation/reload. The other live `refresh()` caller updates the same
  principal after cell verification. I therefore do not promote this to a
  defect. If an in-document A-to-B session switch is added later, the provider
  should be keyed by user ID or explicitly reset on ID change.
- Public `/join` and `/p/:unitId` routes remain outside `AuthedApp`, but the
  whole-repository consumer sweep finds `useImageViewer()` only in authenticated
  `Timeline` and `MediaGallery` production code. Moving the provider did not
  strand a public consumer.

### History and stale state

- On logout after a normal Close, the retained Forward entry still contains
  only the opaque token/return key, not the source or title. With the provider
  unmounted it cannot render over Login. If authentication later remounts the
  provider on that stale entry, the new empty registry makes it an unknown
  marker and the existing replace-normalization path at
  `dashboard/src/ui/imageViewer/ImageViewerProvider.tsx:150-166` removes it
  without rendering.
- The synchronous latch is set before either registry scheduling or navigation
  (`ImageViewerProvider.tsx:86-120`), so a second same-turn call cannot allocate
  a second token or push a second marker. It resets only after the router commits
  a new location key (`:125-127`); Back to the return entry and independent
  navigation both change the key and therefore do not permanently disable later
  opens. The repository has no navigation blockers (`useBlocker`/prompt) that
  can reject this push while leaving the latch stranded.
- No other production code writes image-viewer markers or calls raw History API
  for this feature. The only production callers are the two button components
  in `Timeline.tsx:628-640` and `MediaGallery.tsx:21-38`.

### Focus and inert state

- The new backdrop regression is a positive backdrop dismissal: its first and
  only initiating event is `mouseDown` on the dialog's backdrop parent
  (`dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx:284-307`). It
  mutates and exactly restores two nonzero, independently scrollable owners and
  proves one `focus({ preventScroll: true })` call on the connected trigger. It
  is no longer the prior Escape-then-backdrop duplicate no-op.
- Provider unmount is safe for inertness: the portal effect owns an idempotent
  cleanup that restores every captured body sibling's original boolean and
  removes the portal (`ImageViewerProvider.tsx:189-215`). Normal verified
  dismissal still releases inertness before restoring scroll and focus
  (`:168-187`).
- I re-checked the disconnected-trigger path behind `AD-3`. The provider skips
  focus only when the trigger is no longer connected (`:184-186`), which is the
  approved contract; synthesizing a fallback would be new product behavior.

## Cold review of the fix diff

No new behavioral defect was confirmed.

- `App.tsx` and `main.tsx` leave exactly one production provider. It remains
  under `BrowserRouter`, surrounds every authenticated route consumer, and no
  longer surrounds Login or public routes.
- The auth regression drives the real `App`/`AuthGate`/account-menu logout path
  under `BrowserRouter`, closes to the return entry, signs out, traverses the
  retained Forward entry, and asserts Login remains, the dialog/title are absent,
  and no portal exists (`dashboard/src/App.test.tsx:190-253`). That directly
  exercises the earlier concrete interleaving rather than merely asserting tree
  shape.
- The double-open regression invokes the exposed context callback twice in one
  `act`, proves the first descriptor wins, history advances exactly once, and one
  Close returns to index 0 (`ImageViewerProvider.test.tsx:309-331`). This is the
  appropriate contract-level proof for the stale-closure race.
- The new security issue follows the repository schema and accurately preserves
  `AD-1` as high/open while separating it from this feature
  (`docs/issues/authenticated-mms-media-browser-cache.md:1-27`). A later repair
  must remember that changing the response header cannot retroactively purge
  already-fresh one-hour browser entries; rollout proof should account for that
  residual window. That is implementation work for the tracked issue, not a
  blocker for this branch.

Non-blocking editorial note: the issue's last sentence at
`docs/issues/authenticated-mms-media-browser-cache.md:25-27` says "before no old
bytes can render." "and no old bytes render" would state the intended assertion
more clearly. This does not change the tracked security contract.

## Earlier findings and adjudications

- `SC-1`: CLOSED. The new backdrop-only nested-scroll/focus test supplies the
  exact missing initiating path.
- `AD-2`: CLOSED. The descriptor registry is destroyed at the auth gate and the
  app-level Forward regression proves the reported logout sequence.
- `AD-4`: CLOSED. A synchronous pre-navigation latch plus a same-act regression
  prevents two pushes from the stale callback closure.
- `AD-1`: ADJUDICATION UPHELD. The browser-cache weakness is high severity but
  source-identical to main and already reachable through existing authenticated
  thumbnails. This feature no longer contributes a retained cross-logout
  renderer. The dedicated in-repo security issue is the correct scope boundary.
- `AD-3`: ADJUDICATION UPHELD. The approved behavior explicitly skips focus
  restoration for a disconnected trigger. A fallback target requires a separate
  accessibility/product contract rather than a stealth fix in this mission.

## Attacked but not broken

- Signout cleanup while a descriptor exists: unmount drops registry refs and
  restores inert snapshots; no descriptor is serialized into history.
- Forward while anonymous: no provider means no portal; marker state has no PII.
- Forward after a later authenticated remount: empty-registry normalization
  replaces the stale marker before any viewer can become active.
- Reopen after Close/Back: the return location-key commit clears the open latch;
  the existing new-open branch truncates the prior Forward entry.
- Duplicate activation through both production consumers: both call the same
  latched context function; no host has a parallel viewer-state mutator.
- Background modal focus/inert ordering: verified dismissals release the portal
  before focus, while independent navigation and disconnected triggers retain
  their intentional no-focus behavior.
- Public-route and Login rendering: neither production route imports a viewer
  consumer, so removing the root-level provider does not create a missing-context
  crash.
- `AD-1` source scope: the vulnerable cache header remains untouched at
  `app/src/routes/api.ts:2309`; the fix wave neither hides nor partially repairs
  that separate issue.
