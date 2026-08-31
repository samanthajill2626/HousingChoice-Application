# Final review findings and adjudications

## Must fix

1. `SC-1` - The approved scroll/focus coverage requires Back, Close, Escape,
   and backdrop as positive initiating dismissal paths. The existing backdrop
   event happens only after Escape already requested dismissal, so it proves a
   duplicate no-op rather than backdrop restoration. Add a backdrop-only
   provider regression with two nonzero nested scroll owners and exact focus
   restoration.
2. `AD-2` - The new provider is mounted outside `AuthGate`, so its in-memory
   media descriptor survives logout and can render again from a retained Forward
   entry over Login. Mount the provider inside the authenticated side of
   `AuthGate` (or an equally strict principal-scoped boundary), and prove that
   logout plus Forward cannot render the old portal/title.
3. `AD-4` - The reviewer could not execute its micro-probe, but the current
   `openImage` closure reads stale `location.state`; two same-turn activations
   can both navigate before Router commits. Add a failing same-act double-open
   regression and a synchronous latch so one source activation produces one
   viewer history entry.

## Adjudicated, no feature-source repair

1. `AD-1` - The authenticated media route's `private, max-age=3600` response
   is a real security concern, but it is source-identical to `main` (introduced
   before this feature) and existing Timeline thumbnails already fetch the same
   authenticated URL. It is not introduced by this feature. Track separately as
   a high-severity security issue; the provider auth-boundary repair prevents
   the new retained-descriptor Forward path from rendering across logout.
2. `AD-3` - Rejected for this mission: the approved spec explicitly requires a
   disconnected trigger to skip focus restoration, not to synthesize a fallback
   target. Current tests exercise that contract. A broader focus-fallback design
   needs a separate product/accessibility decision.

