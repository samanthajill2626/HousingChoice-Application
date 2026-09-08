> **Closeout update (2026-09-08):** Merged and retired; Cameron confirmed the hosted
> maintenance page appeared during an app deployment. See [README.md](README.md)
> for evidence preservation and the remaining native browser-zoom check. The
> original handback below is the point-in-time verification record.

# Build handback: CloudFront maintenance page

Date: 2026-09-07
Branch: `codex/cloudfront-maintenance-page`
Base main: `f82c149cf8523cbdb2f6d6ff3bdedc6583951ab4`

## Work-map delivery

- S1 shipped. The standalone five-key edge catalog, actual Terraform HTML
  template, escaping coverage, and provider-free actual-template renderer are
  in the committed S1 files and `s1-build-report.md`.
- S2 shipped. The private exact-object S3/OAC origin, exact behavior, only
  502/504 status-preserving zero-TTL mappings, mock contracts, copied dev/prod
  root checks, and five mocked Terraform faults plus one labeled in-process
  source fault are in the committed S2 files and `s2-build-report.md`.
- S3 shipped. Hermetic GET/POST recovery coverage uses the actual renderer at
  narrow and desktop widths, preserves typed 503 client behavior, and proves
  keyboard GET-home recovery without query or request-body replay.
- S4 shipped. `RUNBOOK.md` documents the human-controlled rollout and
  rollback boundary; `e2e/README.md` records local requirements and the mock
  versus source-fixture distinction.

## Review and fix wave

- Initial spec-conformance and plan-blind adversarial reviews found no
  must-fix. Their records are `review-spec-conformance.md` and
  `review-adversarial.md`.
- Parent cold review found F1: the first in-process default-forwarding source
  guard counted the expected policy text inside comments or a null conditional
  expression. F1 was confirmed and fixed in `9ce87b85` by preserving quoted
  strings while removing comments, then requiring one complete active
  assignment. Permanent hash-comment, block-comment, null-expression, and
  quoted-string fixtures cover that distinction. See
  `review-findings-and-adjudication.md` and `fix-wave-report.md`.
- A fresh plan-blind fix re-review found no must-fix and judged the correction
  real. See `review-fix-adversarial.md`.

## Final validation

- `npm run typecheck` exited 0.
- `npm test` exited 0: app 359 files / 6,749 passed / 1 skipped; dashboard
  189 / 3,036; e2e 21 / 499; fake Twilio 34 / 245; fake Twilio web 13 / 111.
- `npm run smoke` exited 0: `1396 import specifier(s) across 246 emitted
  file(s) resolve under plain Node.`
- `node --check scripts/check-maintenance-infra.mjs` exited 0; touched
  Terraform `fmt -check` exited 0; the scoped checker with the approved
  read-only provider mirror exited 0. It passed baseline/restored mock
  contracts, five expected mocked Terraform faults, in-process source
  fixtures, and copied dev/prod init/validate.
- The explicit nonempty changed-file ESLint ratchet exited 0 for five paths.
  `scripts/check-maintenance-infra.mjs` was included in its argv, but the
  repository ESLint config has the documented `.mjs` coverage hole, so that
  green result is not a style-rule assertion for the script. Its Node syntax
  and behavior checks above are separate evidence.
- `npm run e2e` exited 1 after `274 passed (18.3m)`: the unchanged
  `e2e/tests/dashboard-next/outbound-mms.spec.ts:591` failed with the exact
  documented `trigger is not visible` full-suite-only signature. The same
  unchanged spec had already passed an isolated ordinary-harness run, and the
  current failure matches the established main controls in
  `docs/issues/e2e-outbound-mms-viewer-trigger-not-visible.md` and
  `docs/issues/outbound-mms-viewer-trigger-visibility-full-suite.md`.
  Fresh screenshot, video, and error context were preserved before any future
  run can overwrite them at
  `.superpowers/sdd/builder-final-e2e-outbound-mms-20260907T1912/`.

## Self-QA

`self-qa.md` records the actual-template loopback visual and recovery preview:
0px horizontal overflow at 320x800 and 1280x900, no document dependencies,
visible solid 3px keyboard focus, and safe POST-to-502 then fresh GET-home
recovery. Its three PNG pointers resolve under this worktree's ignored
`.playwright-mcp/`. This preview is not dashboard recovery or hosted
CloudFront substitution evidence. Native browser zoom could not be changed by
the available driver: `Control++` left measured viewport width,
`devicePixelRatio`, and `visualViewport.scale` unchanged. The separate
root-font 200 percent observation is labeled accordingly. The owned loopback
listener was stopped and its ephemeral port confirmed closed.

## Mainline and handoff

The prior required main sync was a no-op at `f82c149c`; current main still
equals that revision, so no second merge was performed. The branch was 0
commits behind main before this record. The full branch diff then measured
2,775 insertions and 3 deletions; `git diff --check` reports only pre-existing
blank final lines in `plan-r1-reviewer-b.md` and `plan-r2-reviewer-b.md`.

Human-controlled post-merge operations remain required: dev then prod plan and
apply; healthy initial provisioning, propagation, direct object/page, and
application health checks; separately authorized actual dev 502/504
substitution and recovery evidence; and rollback of only the two mappings if
needed, retaining the maintenance infrastructure. No app redeploy is required.

UNMERGED (human gate). The orchestrator return supplies the exact final commit
hash and current main drift after this record is committed.
