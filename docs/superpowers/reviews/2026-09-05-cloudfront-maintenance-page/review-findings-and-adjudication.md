# Review findings and adjudication: CloudFront maintenance page

Date: 2026-09-07

## Initial review record

- The spec-conformance reviewer found every S1-S4 work-map item CONFORMS and
  recorded no must-fix, partial, or missing item.
- The plan-blind adversarial reviewer found no must-fix issue after sweeping the
  CloudFront configuration, app error readers, page renderer, local browser
  proof, Terraform mock contracts, and operator path.

## F1: default forwarding source assertion accepted comments and expressions

Severity: must-fix. Parent cold review confirmed that the in-process source
assertion in `scripts/check-maintenance-infra.mjs` accepted an active
`origin_request_policy_id = null` when a trailing `#` or `/* ... */` comment
contained the expected policy reference. It also accepted a valid HCL
conditional expression containing the reference that evaluates to `null`.

The previous `split(expectedLine)` check counted text anywhere in the captured
block. It did not distinguish active HCL from a comment or prove that the
policy reference was the entire active assignment.

Adjudication: CONFIRMED. The provider mock cannot retain this default-policy
distinction, so the source assertion remains necessary and is explicitly
labeled in-process. The fix strips `#`, `//`, and block comments only outside
quoted strings, preserving escapes. It then requires exactly one complete
reference-only `origin_request_policy_id` assignment line in the active
`default_cache_behavior` block. Permanent fixtures reject hash-comment,
block-comment, and null-expression bypasses and retain a valid source with
quoted and escaped comment markers including `"/api/*"`.

Resolution: fixed in the Phase 4 fix-wave commit. The five separate Terraform
fault probes remain mocked Terraform assertions; the active-HCL source fault
and parser fixtures remain separately labeled in-process checks.
