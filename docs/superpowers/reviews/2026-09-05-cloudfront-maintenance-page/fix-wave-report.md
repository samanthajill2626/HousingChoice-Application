# Phase 4 fix-wave report: maintenance source guard

Date: 2026-09-07

## Red evidence

Before the fix, this exact in-memory active-null mutation reported a false
pass. The command exited 0 only because the reproduction assertion expected
the bad result:

```powershell
node --input-type=module -e 'import { readFileSync } from "node:fs"; const source = readFileSync("infra/modules/cloudfront/main.tf", "utf8"); const block = source.match(/  default_cache_behavior \{[\s\S]*?\n  \}/)?.[0]; const reference = "origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id"; const changed = source.replace(block, block.replace(reference, "origin_request_policy_id = null # " + reference)); const changedBlock = changed.match(/  default_cache_behavior \{[\s\S]*?\n  \}/)?.[0]; const falsePasses = changedBlock.split(reference).length === 2; console.log("OLD_GUARD_ACTIVE_NULL_TRAILING_COMMENT_FALSE_PASS=" + falsePasses); if (!falsePasses) process.exit(1);'
```

Observed output: `OLD_GUARD_ACTIVE_NULL_TRAILING_COMMENT_FALSE_PASS=true`.

## Green evidence

The checker now removes comments only outside quoted strings and requires one
complete active policy assignment. Its permanent in-process fixtures reject
the hash-comment, block-comment, and null-expression cases and accept the
valid quoted/escaped-string case containing `"/api/*"`.

```powershell
node --check scripts/check-maintenance-infra.mjs
node scripts/check-maintenance-infra.mjs "W:\AI Projects\Housing Choice\HC Application\infra\envs\dev\.terraform\providers"
git diff --check -- scripts/check-maintenance-infra.mjs e2e/README.md docs/superpowers/reviews/2026-09-05-cloudfront-maintenance-page/review-findings-and-adjudication.md docs/superpowers/reviews/2026-09-05-cloudfront-maintenance-page/fix-wave-report.md
```

`node --check` exited 0. The scoped checker exited 0 and reported: module
init/validate, baseline/restored mock contracts, all five expected mock
Terraform failures, the active-HCL source failure, both copied root
init/validate checks, and the final five-mock-plus-in-process-fixtures summary.
Its retained local evidence is under
`.superpowers/maintenance-infra/hc-maintenance-infra-g0x63x/`.

No Terraform plan, apply, provisioner, live state read, AWS credential use, or
cloud operation occurred. The optional provider mirror was read-only input to
the disposable checker copies.
