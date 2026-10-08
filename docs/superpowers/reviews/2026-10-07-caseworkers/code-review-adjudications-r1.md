# Caseworkers code review adjudications - round 1

Date: 2026-10-08. Parent: GPT-6. Reviewed source 5272f85e; review HEAD
76357a5f. Reports are code-review-conformance-r1.md (preserved at d7a38222)
and code-review-adversarial-r1.md (f74bbfca).

## Human continuation instruction

After the orchestration stop, the human explicitly instructed us to continue
until review is finished and ruled that the platform review errors do not count
as recoveries. That overrides the local workflow failure-budget stop. The S6
lifecycle recovery remains counted; the two review platform errors are recorded
but excluded by the human's ruling. This does not authorize evading platform
controls or disguising a blocked operation. No failed experimental operation
will be retried. Both completed written reports are retained; continue with the
local application correctness fix and independently review its code/evidence.

## Complete findings and disposition

### CF-1 / R1-ADV-1: ACCEPT, must fix

Both independent reviewers demonstrated the same missing atomic classification
condition in app/src/routes/contacts.ts. A consistent read is not a write fence.
Overlapping individually permissible type-only and role-only edits can compose
into partner/Caseworker while bypassing the dedicated conversion and its open
placement refusal. This violates D16 and is not covered by the explicit generic
other-kind retype deferral. The reviewers differ on priority (P1 versus P2), not
on the defect or proof. Treat as blocking before handback.

Fix classification-changing PATCH writes against the exact raw classification
revision read for validation, including absent versus stored zero. Compose with
staff-note expectations on the same write. Handle conflicts accurately, preserve
ordinary edits and existing missing/deleted behavior, and prevent post-write
side effects on rejected writes. Pin both orderings of independent read snapshots
and staff-note guard composition. Repository changes are not assumed necessary;
existing real/fake multi-expect support must be verified and both changed if the
fix alters behavior they mirror. Full original-scope review continues afterward.

### R1-ADV-2: ACCEPT evidence, retain explicit approved deferral

An extraction holding a pre-conversion snapshot can restore tenant facts and
publish new suggestions after conversion. The independent report substantiates
this at the real conversion/apply service boundary and correctly states that it
did not run a paused full extraction job. Spec section 12, lines 1360-1362,
explicitly accepts this race for branch B. It is already recorded in
`docs/issues/extraction-in-flight-writes-onto-converted-caseworker.md`, with
RUNBOOK repair instructions. No change is assigned in this wave. This is a known
limitation, not a false-positive finding. A future solution needs commit-boundary
fences; an advisory fresh read alone would still race.

### C6 / Task 10.4: baseline problem retained, proposal unapplied

The populated shared-picker batch has a verified existing below-viewport option
failure. The baseline attribution, saved tested proposal and open user scope
question are documented in C6-picker-proposal.md and S10-report.md. The latest
instruction authorizes continued reviews, not the previously pending optional
scope expansion. Leave the proposal unapplied until specifically approved.
Full-suite green does not invalidate the focused baseline-red evidence.

### Other review observations

No additional confirmed finding was produced. The adversarial report's possible
placement/tour/association change after conversion refusal reads was not
reproduced; existing permissive writers and their approved follow-up issue must
remain visible, without inventing an atomic-refusal guarantee. Both reviewers
must challenge these adjudications during their continued broader review.

## Next owned work

One fresh Astra xhigh implementation child owns the accepted CF-1 fix and its
focused proof. No concurrent source writer. The parent owns aggregate gates,
review adjudication, live hermetic self-QA and handback. The final main sync has
already happened once; do not repeat it. Later main drift is reported only.
