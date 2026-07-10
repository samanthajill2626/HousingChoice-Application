---
id: one-off-scripts-missing-account-guard
title: One-off AWS scripts skip the assertHousingChoiceAccount guard (wrong-account write risk)
type: security
severity: med
status: open
area: scripts
created: 2026-07-10
refs: app/scripts/backfillConsentMethod.ts, app/scripts/db-create.ts, app/scripts/s3-create.ts, scripts/lib/hcAws.mjs:39
---

**Problem.** Every orchestrated AWS script in this repo calls
`assertHousingChoiceAccount()` FIRST — it refuses to run unless the active profile
resolves to the pinned HousingChoice account (`HC_ACCOUNT_ID = 938565869261`,
`scripts/lib/hcAws.mjs`). `tf.mjs`, `deploy.mjs`, `bootstrap.mjs`, `secrets.mjs`,
`wipe-dev-data.mjs`, `userInvite.mjs`, and `dev.mjs` all have it. The one-off
`app/scripts/*.ts` operational scripts do NOT — they rely on the operator setting
`AWS_PROFILE` / `TABLE_PREFIX` correctly by hand, with no guard rail.

Why it matters: the machine's DEFAULT credential chain points at an UNRELATED
account (the ABT credential foot-gun). A one-off script run with the wrong (or
default) profile active, but a real `TABLE_PREFIX`/unset `DYNAMODB_ENDPOINT`, would
Scan/Update against the WRONG AWS account with nothing stopping it. Surfaced
2026-07-10 when the broadcast backfill dry-run failed with
`CredentialsProviderError: Could not load credentials from any providers` — benign
that time (no creds at all), but a *wrong-account* credential would not have been.

Affected (AWS-touching, unguarded):
- `app/scripts/backfillConsentMethod.ts` — one-off contact backfill, still live.
- `app/scripts/db-create.ts` — dual-mode (DynamoDB Local by default, deployed env
  when `DYNAMODB_ENDPOINT` is unset).
- `app/scripts/s3-create.ts` — same dual-mode shape.

Explicitly OUT of scope: `app/scripts/backfill-broadcast-list-partition.ts` — the
`byCreated` migration is complete, new rows self-stamp `_listPartition` at write
time, and the deployed tables are backfilled; it will never be run again.

**Suggested fix.** Add the account guard at each script's runnable entrypoint, but
make it CONDITIONAL on actually targeting a deployed env — only assert when
`DYNAMODB_ENDPOINT` is unset (i.e. real AWS), so the everyday DynamoDB-Local dev
loop (which needs no AWS creds) still works with zero friction. The guard logic
already lives in `scripts/lib/hcAws.mjs` (`assertHousingChoiceAccount`,
`HC_ACCOUNT_ID`, `HC_REGION`, `HC_PROFILE`), but that file is `.mjs` under
`scripts/` while these are `.ts` under `app/scripts/` run via `tsx` — so this likely
needs either a small shared guard importable from `tsx`, or the STS
`GetCallerIdentity` + account-id compare replicated in the `app/scripts` layer.
Consider also forcing `AWS_PROFILE=housingchoice` into the process env the way the
orchestrated scripts do, so the operator can't accidentally run under the default
profile.
