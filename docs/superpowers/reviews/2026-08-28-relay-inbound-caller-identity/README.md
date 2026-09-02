# Mission record - relay inbound caller identity (`feat/relay-inbound-caller-identity`)

Preserved 2026-09-01 when the branch and its worktree were retired. These files
lived under the worktree's gitignored `.superpowers/`.

**This is a point-in-time record, not current documentation.** The design and
plan are frozen at
[`2026-08-28-relay-inbound-caller-identity-design.md`](../../specs/2026-08-28-relay-inbound-caller-identity-design.md)
and
[`2026-08-28-relay-inbound-caller-identity.md`](../../plans/2026-08-28-relay-inbound-caller-identity.md).
For current truth read the code.

## Follow-up left open

[`aws-cli-identity-can-diverge-from-account-guard`](../../../issues/aws-cli-identity-can-diverge-from-account-guard.md)
- open, filed by this work and not discharged by the retirement.
[`e2e-typecheck-masks-ts6142`](../../../issues/e2e-typecheck-masks-ts6142.md) was
resolved on-branch.

## Layout

| directory | what is in it |
|---|---|
| `design-review/` | spec rounds 1-4 and plan round 1, with two reviewers in round 1 of each, plus the planner's adjudications |
| `review/` | spec-conformance and adversarial passes, then the phase-6 conformance and adversarial re-reads |
| `sdd/` | six slice reports, `worklist.md`, `self-qa.md`, `handback.md`, and the two research notes |

## What was deliberately NOT kept

The keeping rule is decisions, findings, adjudications and reasoning - not
anything recomputable from the repo.

- `review/phase4-diff-package.txt` (152KB) - a raw diff git already holds.
- Every gate log, including a **33MB** `sdd/final-gate-e2e.log`.
- `sdd/progress.md` - the timestamped dispatch ledger. Run state.

**Both `research-*.md` files are kept WHOLE.** Neither has a single line inside
a code block - they cite code by `file:line` and reason in prose, and
`research-dashboard-e2e.md` ends in a "Drift / risk assessment" section rather
than a byte-exact survey. That is the same call as the ai-contact-kind and
mms-image-viewer records, and the opposite of the tour-reminder-ladder ones,
which ran 47-66% inside code blocks and had to be split.
