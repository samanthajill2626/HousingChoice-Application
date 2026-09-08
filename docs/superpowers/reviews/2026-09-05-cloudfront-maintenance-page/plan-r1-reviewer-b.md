# Plan R1 adversarial review - reviewer B

Scope: independent literal-execution review of the approved maintenance-page
spec, implementation plan, and current repository at `f5ce2556`. No app suite,
CloudFront/AWS action, or live port was used. Findings below distinguish the
plan's proposed proof from current-source evidence; no other review or rationale
artifact was read for this round.

## Findings

1. HIGH - The S2 parity contract does not prove preservation of the existing
   app and media origin security/caching surface. Plan lines 374-415 assert app
   targets, allowed methods, two policy IDs, and selected media fields, but omit
   the app origin's `x-origin-verify` custom header and custom-origin settings,
   every behavior's HTTPS redirect/cached-method/compression settings, the
   default behavior's cache and origin-request policies, and the media origin's
   OAC/no-custom-header configuration. Current source makes the app-origin
   secret a security boundary at `infra/modules/cloudfront/main.tf:105-121`,
   protects media through OAC at `infra/modules/cloudfront/main.tf:124-133`,
   and defines the omitted behavior fields at
   `infra/modules/cloudfront/main.tf:151-162`, `169-180`, and `187-195`.
   A literal implementation can accidentally remove those protections while all
   proposed mocked assertions still pass, contrary to the approved spec's
   preservation requirement. Extend the mocked contract to assert the complete
   existing app origin, media origin, dynamic behaviors, and default behavior
   before adding the maintenance behavior. This changes the test/proof surface,
   not product scope.

2. MEDIUM - The plan does not execute the required dev and prod composition
   validation. Its checker copies and validates only
   `infra/modules/cloudfront` (plan lines 464-483); plan line 668 asks only for
   recorded instantiation paths. The real roots independently compose that
   module at `infra/envs/dev/stack.tf:134-149` and
   `infra/envs/prod/stack.tf:134-149`, while the approved spec requires offline
   validation that both environment compositions still match. Module-only
   validation cannot catch a root-to-module/provider composition break. Add
   backend-disabled, disposable-root init/validate checks for dev and prod using
   their existing lockfiles and no state or AWS credentials, or an equally
   executable root-composition check. This changes the validation step and
   evidence, not infrastructure scope.

3. MEDIUM - The actual-document proof omits required catalog/document fields.
   The S1 unit test checks language, heading, body, and href (plan lines 64-78),
   while the browser test checks heading/body/title/action (plan lines 779-785).
   Neither asserts the textual `brand` nor the required viewport metadata; the
   320-CSS-pixel layout check cannot prove a viewport declaration is present.
   The approved spec requires both at lines 30-42. A template that omits either
   can pass all prescribed focused checks. Assert the actual rendered brand and
   a viewport meta element/content in the renderer and/or browser test. This
   changes only acceptance coverage.

4. MEDIUM - The escaping test leaves two independently interpolated copy fields
   unproved. The test substitutes hostile text only for heading, body, and title
   (plan lines 80-91), though the template separately interpolates brand and
   action (plan lines 243-246) and the approved spec requires escaping every
   copy interpolation (spec lines 50-52). A later catalog value containing HTML
   metacharacters, combined with a missed escape at either remaining template
   site, would bypass the stated security proof. Use hostile values for all five
   fields and assert escaped text/no executable markup for every rendered site.
   This changes the focused security test, not the static-page design.
