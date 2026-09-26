---
id: ops-scripts-unpinned-dynamodb-endpoint
title: import-apply and rail-verify build their dev/prod DynamoDB client without a pinned endpoint, so an ambient endpoint_url can redirect a guarded run
type: debt
severity: low
status: open
area: app/scripts
created: 2026-09-25
refs: app/scripts/import-apply.ts:254, app/scripts/rail-verify.ts:146, app/scripts/lib/stageClient.ts
---

**Problem.** Both scripts assert the HousingChoice account on the `housingchoice`
profile and then build `new DynamoDBClient({ region, credentials: hcCredentials() })`
with no `endpoint`. The AWS SDK resolves an endpoint from `AWS_ENDPOINT_URL`,
`AWS_ENDPOINT_URL_DYNAMODB`, or an `endpoint_url` in the shared AWS config file
(on the profile or in a `services` entry). Any of those would send a `--env prod`
run's reads and writes to another endpoint (DynamoDB Local, say) while the
account guard passes and the target line still says AWS. Found by the
share-skip-fix slice-1 adversarial review (A-2) and re-review (R2-2), which
closed it for the two new ops scripts only.

**Suggested fix.** Do what `app/scripts/lib/stageClient.ts` now does: pin
`endpoint: https://dynamodb.<HC_REGION>.amazonaws.com` on every dev/prod client
(an explicit endpoint outranks every ambient source), print it in the target
line, and refuse to start while any `AWS_ENDPOINT_URL*` shell variable is set
(a clear refusal beats a silent override). Simplest: have both scripts resolve
their stage through `resolveStageClient` instead of their own copies.
