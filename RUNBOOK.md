# HousingChoice RUNBOOK

The operator manual for the two AWS stacks (`hc-dev-`, `hc-prod-`, account **938565869261**, us-east-1).
Everything here runs from the repo root on the operator machine; every mutating script is
account-guarded (see [State & bootstrap](#state--bootstrap)). The AWS console is **read-only by policy**.

Quick reference (authoritative source: `terraform -chdir=infra/envs/<env> output`):

| | dev | prod |
|---|---|---|
| CloudFront | `dev.app.housingchoice.org` (alias of `d2w86qra2rq9iz.cloudfront.net`) | `app.housingchoice.org` (alias of `d3v3fqgxdcoxv9.cloudfront.net`) |
| EC2 instance | `i-0ad45daa858632001` | `i-087fd4eda3e2804c1` |
| ECR repo | `hc-dev-app` | `hc-prod-app` |
| Log groups | `/hc/dev/app`, `/hc/dev/worker` | `/hc/prod/app`, `/hc/prod/worker` |
| Jobs queue / DLQ | `hc-dev-jobs` / `hc-dev-jobs-dlq` | `hc-prod-jobs` / `hc-prod-jobs-dlq` |
| Released-tag pointer | SSM `/hc/dev/app/DEPLOYED_TAG` | SSM `/hc/prod/app/DEPLOYED_TAG` |
| Alerts topic | `hc-dev-alerts` | `hc-prod-alerts` |

---

## Daily operations

### Deploy to dev

```powershell
npm run deploy:dev
```

Builds the ARM64 image from the working tree, tags it `dev-<git sha>-<UTC timestamp>`, pushes to
`hc-dev-app`, then rolls the dev instance via SSM Run Command (no SSH exists anywhere).

**Secrets gate (all deploy paths — `dev`, `--promote`, `--tag`):** before building, the deploy runs
a **read-only** `secrets:check <env>` and **aborts on drift** — i.e. a key present in `.env.<env>`
but not yet pushed to `/hc/<env>/app/`, the Parameter Store path the instance hydrates `/opt/hc/.env`
from on every roll. On drift it prints the per-key table + the reconcile command and builds/rolls
nothing; the gate never writes SSM. This is the guard against the "edited `.env`, forgot
`secrets:push`, shipped a missing key" footgun (it once caught a missing `FOUNDER_CELL` that had
silently disabled founder call-triage on dev — `FOUNDER_CELL` has since been removed; inbound routing
now uses the assigned inbound-voice-line holder's verified cell). Bypass with `--skip-secrets` only when you know SSM is already
correct — e.g. `.env.<env>` isn't on this machine. To clear a real drift, just
`npm run secrets:push -- <env>` then re-run the deploy.

### DynamoDB schema changes (apply BEFORE deploying code that uses them)

DynamoDB tables/GSIs are IaC: `app/src/lib/tables.ts` is the source of truth; `npm run gen:tables`
regenerates `infra/envs/{dev,prod}/tables.auto.tfvars.json`, which Terraform turns into real tables.
A new table or GSI lands in a real env via **`npm run plan -- <env>` + `npm run apply -- <env>`** —
NOT via `deploy:<env>` (which only rolls the app image). **Apply the schema BEFORE deploying the code
that reads/writes it**, or the new endpoints 500 against a missing table/index.

**New-dashboard backend-slice schema — APPLIED TO DEV (2026-07-01); PROD applies at the M1.11 go-live cutover.**

| Change | Table | Kind | Powers |
|--------|-------|------|--------|
| BE2 activity/event log | `activity_events` | **new table** — PK `contactId`, SK `tsEventId` | contact timeline + milestone log |
| BE4 listings-sent | `listing_sends` | **new table** — PK `unitId`, SK `contactId`, GSI `byContact` (`contactId`+`sentAt`) | "Sent to tenants" / "Properties sent" |
| BE3 related units | `units` (existing) | **GSI add** — `byProperty` (sparse, hash `propertyId`) | duplex/building "Related properties" |
| Broadcasts already-sent | existing table | **GSI add** — `byUnit` (see `app/src/lib/tables.ts`) | "already sent this property" annotation |

All are in both `tables.auto.tfvars.json` files and have been `terraform apply`'d to **dev**. **Prod is not
applied yet** — it lands as part of the go-live cutover (M1.11): `npm run plan -- prod` (review the adds) →
`npm run apply -- prod` → the prod promote. All are **online** operations (no recreate, no data migration);
the new tables started empty. BE1/BE5/BE6 added NO schema — multi-phone is an item-shape change on
`contacts` (phone-pointer items live in the existing table), and media/similar/today are read-only
aggregations over existing tables.

**Placement deadline-model schema — NOT YET APPLIED (as of 2026-07-03; feature branch `feat/placement-deadline-model` unmerged). Apply to DEV after merge; PROD rides the M1.11 cutover.**

| Change | Table | Kind | Powers |
|--------|-------|------|--------|
| First-class deadlines | `placementDeadlines` | **new table** — PK `deadlineId` (`${placementId}#${type}`), GSI `byPlacement` (hash `placementId`), GSI `byDueAt` (fixed hash `_deadlinePartition` + range `at`) | one-query Today `needs_you_now`/`follow_ups`; computed `next_deadline` chip; `voucher_expiration` clock |
| Single-slot retirement | `placements` (existing) | **GSI drop** — `byNextDeadline` | the overloaded single `next_deadline` slot is retired (superseded by `placementDeadlines`) |

Both are in the regenerated `tables.auto.tfvars.json` files. **Online** operations — no recreate, **no data migration**: the new table starts empty, and any old `next_deadline_type`/`next_deadline_at` attributes left on existing placement rows simply go unread (flexible-doc). Post-merge on **dev**: `npm run plan -- dev` (review the `placementDeadlines` add + `byNextDeadline` drop) → `npm run apply -- dev`. **No reseed/backfill** — deployed envs hold no demo fixtures (`db:seed` targets DynamoDB Local only, never AWS), so the new table starts empty and dev placement deadlines simply **accrue naturally** as placements enter `awaiting_landlord_submission` (rta_window) and as tenant voucher dates are set. (To exercise the feature with seed data, reseed a **local** stack — `npm run dev -- --local --seeded`, or a running `e2e:session` + `npm run e2e:reseed` — both target DynamoDB Local.) **Prod** rides M1.11 (`npm run plan -- prod` / `npm run apply -- prod` at the cutover).

**Relay-group inbox truncation fix schema — NOT YET APPLIED (as of 2026-07-06; feature branch `feat/relay-group-view` unmerged). Apply to DEV after merge; PROD rides the M1.11 cutover.**

| Change | Table | Kind | Powers |
|--------|-------|------|--------|
| Relay-group status index | `conversations` (existing) | **GSI add** — `byRelayStatus` (sparse, hash `relay_status` = `relay_group#<status>`, range `last_activity_at`) | `listRelayGroups(status)` reads relay groups DIRECTLY — no longer diluted out of the `byLastActivity` `'open'` partition by open 1:1 volume (relay-inbox-open-groups-truncation) |

In the regenerated `tables.auto.tfvars.json` files. **Online** operation — no recreate, **no data migration required**: the write path stamps `relay_status` on create/close/reopen, so new + touched relay groups populate the index automatically. Existing open relay groups predating the GSI lack `relay_status` until re-stamped, but **dev is reseeded** (`db:seed` stamps `relay_group#open` on the seeded open relays) and **prod relay-group volume is ~none**, so no backfill is needed. Post-merge on **dev**: `npm run plan -- dev` (review the `byRelayStatus` add) → `npm run apply -- dev`. **Prod** rides M1.11 (`npm run plan -- prod` / `npm run apply -- prod` at the cutover).

**Broadcasts team-wide list schema — NOT YET APPLIED to dev (as of 2026-07-08, on `main`). Apply to DEV with the next dev deploy; PROD rides the M1.11 cutover.**

| Change | Table | Kind | Powers |
|--------|-------|------|--------|
| Team-wide list index | `broadcasts` (existing) | **GSI add** — `byCreated` (fixed hash `_listPartition` = `'broadcasts'` + range `created_at`) | ONE newest-first query serves the dashboard's All tab AND its status tabs (FilterExpression) |
| Old list indexes retired | `broadcasts` (existing) | **GSI drop ×2** — `byStatus` (unsorted) + `byCreatedAt` (per-creator) | `byCreatedAt` silently scoped the All tab to the acting user, so All showed a SUBSET of its own status tabs (2026-07-08 bug); `byStatus` returned arbitrary order |

In the regenerated `tables.auto.tfvars.json` files. **Online** operations, but this one HAS a small **backfill**: rows created before the migration lack `_listPartition`, and un-stamped rows are invisible to the dashboard's Broadcasts list (all tabs) — they stay readable by id and via `byUnit`. On **dev**, in order:

1. `npm run plan -- dev` (review: `byCreated` add + `byStatus`/`byCreatedAt` drops — DynamoDB takes one GSI change per UpdateTable, so the provider applies them sequentially; if the apply errors mid-sequence, re-run plan+apply to converge) → `npm run apply -- dev`.
2. Backfill (idempotent; `--dry-run` first to see counts): `npx tsx app/scripts/backfill-broadcast-list-partition.ts --dry-run` then without the flag, with the dev env/profile active (it resolves the table via `TABLE_PREFIX`).
3. Deploy the app image built from this `main`. NOTE: between the apply (drops the old GSIs) and the deploy, the currently-running dev app's `GET /api/broadcasts` errors — do the two together. Prod has no such window (empty table, apply+deploy both ride M1.11; the backfill is then a no-op but harmless to run).

Rehearsed end-to-end on DynamoDB Local 2026-07-08 (GSI add → backfill 4 rows → re-run skipped 4 → GSI drops → dashboard verified team-wide). **Local stacks:** a persisted DynamoDB Local table predating this change lacks `byCreated` (`db:create` never retrofits GSIs — docs/issues/e2e-lane-tables-stale-schema.md) and the Broadcasts list 500s; either redo the dev-stack sequence above by hand (as rehearsed) or just delete the stale `hc-local-…-broadcasts` table and reboot the stack (recreate + reseed). Mind the lane-key trap: e2e lane tables are namespaced by ACCESS KEY (no `-sharedDb`), so aws-cli must use the lane's `accessKeyId=hclane<L>` (printed at boot) or the table is invisible — this cost two red e2e runs on 2026-07-08.

**Email channel v1 schema (SES two-way email) - NOT YET APPLIED (feature branch `feat/email-channel`, Phase A merged). Apply to DEV after merge; PROD rides the M1.11 cutover.**

| Change | Table | Kind | Powers |
|--------|-------|------|--------|
| Inbound address -> contact | `contacts` (existing) | **GSI add** - `byEmail` (sparse by data, hash `email`) | resolve an inbound sender + manage a contact's email addresses (the `byPhone` analog) |
| Email thread identity | `conversations` (existing) | **GSI add** - `byParticipantEmail` (sparse, hash `participant_email`) | the `email#<addr>` claim arbiter + `createOrGetByParticipantEmail` find the ONE email 1:1 thread for an address |
| Unknown-sender side-door | `unmatched_email` | **NEW TABLE** - PK `unmatchedId`; GSI `byStatus` (hash `status`, range `received_at`; sparse - `block#<address>` blocklist pointer rows never index); **TTL** on `expires_at` (epoch seconds: linked/dismissed/quarantined rows expire +90d, unmatched rows never) | the `/api/unmatched-email` triage feeds + the sender blocklist B2's tier 3 reads (B3) |
| Parked-event reaper (email) | `messages` (existing) | **TTL enable** - `expires_at` (epoch seconds) | reaps orphan F12 parked SES events (`emailevent#<sesId>`, a 7d backstop) the post-send consumer never claimed; real conversation messages never set `expires_at`, so nothing else is touched. Online, no recreate, no backfill (fix-wave adv M3). |

All FOUR changes are already in both `tables.auto.tfvars.json` files (GSIs regenerated in Phase A; the `unmatched_email` table in B3; the `messages` TTL in the fix wave). **Online** operations - no recreate, **no backfill**: both GSI adds are sparse and populate as email participation is written (existing phone-only threads and contacts without an email never carry the indexed attribute, so they never index), the new table starts empty, and enabling `messages` TTL only reaps future orphan parked events. Post-merge on **dev**: `npm run plan -- dev` (review: two GSI adds + one new table with TTL + one TTL enable on `messages`) -> `npm run apply -- dev`. **Prod** rides M1.11 (`npm run plan -- prod` / `npm run apply -- prod` at the cutover).

### Unit photos: direct-upload CORS (apply BEFORE the upload path works)

**Infra change - `feat/unit-photos` MERGED to main (@05aba86). DEV: CORS APPLIED 2026-07-16 (upload path live on dev). PROD: rides the M1.11 cutover (still to apply).**

Property photos upload **directly from the browser to the media S3 bucket** via a presigned POST (the EC2 app never touches the bytes). A cross-origin browser POST to S3 is blocked until the bucket carries a CORS rule allowing it. That rule is IaC in `infra/modules/s3_media` (`aws_s3_bucket_cors_configuration`, method POST only, `ExposeHeaders ["ETag"]`), guarded by the new `dashboard_origins` module variable.

| Change | Resource | Kind | Powers |
|--------|----------|------|--------|
| Direct-upload CORS | `hc-<env>-media-<account>` bucket | **CORS rule add** - method POST from `dashboard_origins`, `ExposeHeaders ["ETag"]` | browser -> S3 presigned-POST photo upload (no bytes through EC2) |

`local.dashboard_origins` is wired to the deployed dashboard origin (`https://${local.custom_domain}`) in `infra/envs/{dev,prod}/main.tf`; add any additional deployed origins there. **The upload path is BROKEN in a deployed env until this rule is applied** - the browser POST to S3 is CORS-blocked, so photos never store and the gallery shows an inline error. This is IaC applied via **`npm run plan -- <env>` + `npm run apply -- <env>`** (NOT `deploy:<env>`, which only rolls the app image). **Online** operation - no recreate, no data migration; the rule attaches to the existing bucket. **Dev: DONE 2026-07-16** (`npm run plan -- dev` -> `npm run apply -- dev` applied the `aws_s3_bucket_cors_configuration` add). **Prod** still rides M1.11 (`npm run plan -- prod` / `npm run apply -- prod` at the cutover). GET is deliberately absent from the rule: image reads are `<img src>` (presign-per-read), not fetch, so they are not CORS-gated; the public-access-block is untouched (a presigned POST is authenticated).

**Local dev needs NOTHING here** - the harness MinIO allows all CORS origins by default (spike-verified 2026-07-15, `.superpowers/spike/phase0-results.md`), so `s3-create.ts` adds no CORS step and no local config is required. The new app-workspace dep (`@aws-sdk/s3-presigned-post`) rides `npm install` on deploy.

### Outbound MMS media transcoding (2026-07-16): npm install owed; NO new infra

The MMS composer upload moved to the same direct-to-S3 presign/confirm pattern, and confirm now transcodes webp/pdf/oversized images into a Twilio-deliverable JPEG (fixes Twilio error 12300). Post-merge:

- **`npm install` is owed on merge** - new app-workspace runtime deps `sharp` + `@hyzyla/pdfium` (the arm64 `npm ci --workspace app --omit=dev` was container-proven on the branch; the lockfile carries `@img/sharp-linux-arm64`).
- **No new Terraform.** The MMS upload uses the SAME media bucket + the SAME `s3_media` CORS rule as unit photos (already applied on dev); prod CORS rides the M1.11 cutover apply above. Reads/writes use the existing EC2 role `s3:GetObject`/`s3:PutObject` on `MEDIA_BUCKET`.
- The busboy `POST /api/media/uploads` endpoint is REMOVED (superseded by `/api/media/presign` + `/api/media/confirm`); nothing operational referenced it.

### Promote to prod — never rebuild for prod

```powershell
npm run deploy:prod -- --promote <dev-tag>     # e.g. dev-351537e-20260612025557
```

Prod runs the **same image bytes** dev verified, always. `--promote`:

1. Verifies `<dev-tag>` exists in `hc-dev-app` (refuses otherwise).
2. Copies the image into `hc-prod-app` under the same tag **at the registry level** — manifest +
   blobs via the ECR registry API, no `docker pull/push`, no rebuild — and hard-verifies the
   prod digest equals the dev digest before continuing. Idempotent: re-promoting an
   already-promoted tag skips the copy; a same-tag/different-digest collision is a hard refusal.
3. Continues as a normal existing-tag deploy against prod (SSM roll + health gate + CloudFront
   verification below).

Building directly into prod (`npm run deploy:prod` with no flags) works mechanically but is **not
the process** — prod images come from dev via `--promote`, period.

### Listing what exists / what is running

```powershell
npm run deploy:dev -- --list      # last 10 hc-dev-app tags + current dev DEPLOYED_TAG
npm run deploy:prod -- --list     # same for prod
```

The currently-released tag is marked `<== DEPLOYED`.

### Wipe dev data (clean slate)

Empty the **deployed `dev`** data stores back to nothing — DATA only, never infra or
secrets. Use when you want the dev environment to start fresh.

```powershell
npm run wipe:dev            # DRY RUN (default): lists exactly what WOULD be deleted, counts only
npm run wipe:dev -- --yes   # EXECUTE (destructive): actually deletes
```

- **Wipes:** every item in the 14 `hc-dev-*` DynamoDB tables; every object + version +
  delete-marker in the `hc-dev-media-<account>` S3 bucket; the `hc-dev-jobs` queue + its
  DLQ (purge); and the log STREAMS in `/hc/dev/app` + `/hc/dev/worker`.
- **Never touches:** SSM Parameter Store (`/hc/dev/app/*` — all Twilio/Google/VAPID/session
  secrets **and** the Terraform-managed config), and every Terraform-managed resource
  *definition* (the tables, bucket, queues, log groups themselves stay). It deletes
  CONTENTS, not resources.
- **No fixture re-seed** — the env is left EMPTY of demo data. The ONE exception: it
  **auto-re-invites the operator** (`cameron@abt-industries.com`, admin) so login still
  works (auth is invite-gated and the wipe empties the users table) — identical to
  `npm run user:invite -- dev cameron@abt-industries.com admin` (idempotent; activates on
  first Google sign-in). Invite anyone else with `npm run user:invite`.
- **Guards:** hard-pinned to `dev` (no prod path); runs `assertHousingChoiceAccount()` first
  (named `housingchoice` profile must resolve to the pinned account, else it refuses); only
  the 14 known app tables are targeted (never "all `hc-dev-*`", so the TF state/lock can't be
  caught); missing resources are skipped, not fatal. Always do a dry run first.
- Tables keep `deletion_protection` (we clear rows, not tables), so a wipe needs no Terraform
  change and the next deploy is unaffected. Script: `scripts/wipe-dev-data.mjs`.

### Secrets

Operator-managed secrets (Twilio etc.) live in the gitignored `.env.dev` / `.env.prod` at the repo
root — templates: `.env.dev.example` / `.env.prod.example` (copy, rename, fill in) — and reach AWS
by script only. Nobody hand-runs `aws ssm put-parameter`:

```powershell
npm run secrets:sync -- dev       # mirror .env.dev to .env.dev.example (comments/structure), values kept
npm run secrets:push -- dev       # .env.dev -> SecureString /hc/dev/app/<KEY> (account-guarded)
npm run secrets:check -- prod     # read-only diff: exit 0 in sync, 2 drift, 1 error
npm run secrets:prune -- dev      # delete SSM params no longer in .env.dev (DRY RUN; add --yes to delete)
```

The flow: edit `.env.<env>` → `secrets:push` writes each key as SecureString under
`/hc/<env>/app/` (prints a created/updated/unchanged summary; values only ever appear masked, like
`AC…1234`) → the **next deploy** hydrates them into `/opt/hc/.env` on the instance. Pushing alone
restarts nothing — follow with a deploy (re-deploying the current `DEPLOYED_TAG` works) to make new
values live. `secrets:check` is the drift report: per-key missing/differs/matches against Parameter
Store, plus any unexpected extra params under the path (report-only). The **deploy runs this same
check as a gate** and aborts on drift (see [Deploy to dev](#deploy-to-dev)), so a forgotten push
can't ship — but pushing then deploying is still the normal flow; the gate is the backstop, not the
mechanism.

**Removing a secret:** deleting a key from `.env.<env>` and re-running `secrets:push` does NOT remove
it from Parameter Store — push only ever creates/updates, so the old value lingers under
`/hc/<env>/app/` and keeps hydrating onto the box. `npm run secrets:prune -- <env>` deletes those
orphans: everything under the path that is neither in `.env.<env>` nor Terraform/deploy-managed. It is
a **dry run by default** (lists what it would delete, masked) and only deletes with `--yes`
(`npm run secrets:prune -- <env> --yes`); `MANAGED_BY_OTHERS` params are never touched, and a
missing/empty `.env.<env>` hard-fails before anything is computed (it can't read "no file" as "delete
everything"). `secrets:check` reports the same orphans read-only (with a `→ secrets:prune` pointer)
but never deletes and never fails on them. After a prune, deploy so the box re-hydrates without the
removed key.

Terraform/deploy-managed keys (`CF_ORIGIN_SECRET`, `JOBS_QUEUE_URL`, `LOG_LEVEL`, `MEDIA_BUCKET`,
`NODE_ENV`, `PORT`, `PUBLIC_BASE_URL`, `SCHEDULER_ROLE_ARN`, `SCHEDULER_TARGET_ARN`,
`TABLE_PREFIX`, `DEPLOYED_TAG`) are **refused** in the .env files — those belong to `plan`/`apply` and the deploy
script, and this tool can never overwrite them. `.env.dev` / `.env.prod` are gitignored; never
commit them.

**Template-first rule:** the committed `.env.<env>.example` is the source of truth for
comments + structure + key-set; the gitignored `.env.<env>` holds the real values. The workflow is:

1. Edit `.env.<env>.example` — add a key with its comment, OR change an existing key's comment.
2. `npm run secrets:sync -- <env>` — the real file now mirrors the template's comments/structure,
   your existing values preserved byte-for-byte, any new key present but empty, and any key not in
   the template parked under a generated `# --- Keys not in the template (review/remove) ---`
   section (never silently dropped). Values are never printed — the summary is key names + counts.
   If `.env.<env>` does not exist yet it is created from the template with all values empty.
3. Fill in any new values in `.env.<env>`.
4. `npm run secrets:push -- <env>` (then a deploy — see above) to land them in Parameter Store.

`npm run secrets:sync` replaces the old fragile hand-appending, which kept missing new-key comments
and comment edits to existing keys. `npm run secrets:sync -- <env> --check` is the read-only drift
check (exit 0 in sync, 2 drift, 1 error): unlike `secrets:check` (which compares the real file's
VALUES against Parameter Store) it catches comment/structure drift between the real file and its
template, including a comment edited only in the template. `secrets:push`/`secrets:check` also print
a key-set drift warning, but they do not see comment drift — `secrets:sync` is what fixes it.

**Rotating `SESSION_SECRET`** (the sealed-session-cookie key; Terraform-generated, NOT an `.env`
key): taint the generator, re-apply, deploy —

```powershell
$env:AWS_PROFILE = 'housingchoice'
terraform -chdir=infra/envs/<env> taint module.params.random_password.session_secret
npm run plan -- <env>; npm run apply -- <env>          # writes the new SecureString
npm run deploy:<env> -- --tag <current DEPLOYED_TAG>   # hydrates it onto the instance
```

Effect: every outstanding session cookie stops opening = **forced global logout** (everyone signs
back in via Google). No data loss — sessions live only inside the cookies themselves. Rotate on any
suspicion the secret leaked.

### Relay number release (`RELAY_NUMBER_RELEASE_ENABLED`)

`RELAY_NUMBER_RELEASE_ENABLED` is an app-behavior flag (an `.env.<env>` key like
`RELAY_LIVE_PROVISIONING`: push it with `secrets:push` then deploy; it is NOT a
Terraform-managed key). It is **OFF by default in every deployed env and STAYS
OFF until Cameron turns it on.** While off, pool numbers are never handed back to
Twilio: a closed relay group keeps its number forever (that is what lets a later
text from a closed-group member intercept into their 1:1 thread), and the
retirement sweep no-ops silently.

Turning it on (`RELAY_NUMBER_RELEASE_ENABLED=true` in `.env.<env>` -> `secrets:push`
-> deploy) does two things:

- A lazy retirement sweep runs at the top of every relay-group provisioning (the
  moment a number is assigned to a new group), releasing any now-eligible numbers.
- It makes `npm run pool:retire` actually release numbers; with the flag off that
  command is a no-op that only reports.

**Eligibility (all four must hold):** the number is `active`, has ZERO open groups
on it, its newest group closed at least 180 days ago, and it has hosted at least
one group (never release a fresh, never-used number). Burn/audit records are KEPT
forever after release (they are our record; the storage cost is trivial).

**Manual ops run** (the `pool:retire` script lives in the app workspace):

```powershell
npm run pool:retire --workspace app
```

It builds the pool service, runs the eligibility sweep once, and prints the
released numbers plus a count (or a no-op notice when the flag is off).

**Stuck `releasing` number.** The sweep claims a number into a transitional
`releasing` state before dropping it at Twilio (a TOCTOU fence). If the process
dies mid-release, a number can be left in `releasing` - HARMLESS to routing (it
just cannot be reused or released) but it will never retire on its own. Operator
remedy: put it back in service by resetting its `lifecycle_state` to `active`
(DynamoDB `pool_numbers` item, PK = the E.164) - the next sweep re-evaluates it.

**A2P / Messaging Service caveat.** Release is a Twilio `IncomingPhoneNumbers`
DELETE (the new adapter capability). A released number ceases to exist on the
account, so it drops out of any Messaging Service sender pool / A2P campaign
association automatically - there is no separate de-registration step. Even so,
after the FIRST production retirement spot-check the Messaging Service sender
list in the Twilio console: A2P throughput and per-number cost scale with the
number count, so confirm the sender pool shrank as expected and the campaign is
still healthy.

### Users & access (invite-first)

Access is **invite-first** (operator decision 2026-06-12, README deviations). A Google login
succeeds ONLY if an admin has already created a user record for that email — the login path never
auto-provisions. A verified, allowlisted Google account with **no invite is refused with a 403
"not invited"** (distinct from the domain-allowlist 403). The OAuth domain allowlist
(`OAUTH_ALLOWED_DOMAINS`) is retained as a second fence (defense-in-depth), not as the access grant.

Invite a user (account-guarded; idempotent — re-inviting is a no-op that leaves the role unchanged):

```powershell
npm run user:invite -- <dev|prod> someone@housingchoice.org va     # or admin
```

The invite writes an `invited` record (email + role + `session_epoch` 1, no `google_sub`) plus a
`user_invited` audit event. The user's **first** Google login activates it (writes `google_sub`,
flips `status` → `active`, audits `user_activated`); later logins just stamp `last_login_at`.

**Bootstrap the first admin** (do this once per env, before anyone can sign in — the order vs.
deploy does not matter, the record just has to exist before the user logs in):

```powershell
npm run user:invite -- <env> <your-workspace-email> admin
```

**Promote / demote** an existing user (never creates — invite first):

```powershell
npm run user:role -- <dev|prod> someone@housingchoice.org admin
```

`user:role` bumps `session_epoch`, so a role change revokes the user's active sessions within ~60s
and the new role applies at their next sign-in. `user:role` against a non-existent email refuses and
points you at `user:invite`.

In-app user management (list / invite / role-change behind `requireRole('admin')`) is coming in
**M1.4** — it will wrap the same `usersRepo.invite` + `usersRepo.setRole` these scripts use, and is
the first admin-only `/api` surface. Until then these npm scripts are the only invite/role path.

### Twilio

The messaging stack (M1.1) has a Twilio-console side that Terraform does NOT manage — this wiring
must hold or messages silently stop flowing:

- **Messaging Service inbound webhook** → `https://<cloudfront>/webhooks/twilio/sms` (the
  Messaging Service's Integration settings, "Send a webhook").
- **Delivery status callback** (same Integration page) → `https://<cloudfront>/webhooks/twilio/status`
  — without it, delivery outcomes (including failures that trigger retries/contact flags) never
  arrive.
- **The phone number must sit in the live A2P campaign's sender pool** of that Messaging Service —
  a number outside the pool can't send campaign traffic.
- **The NUMBER-level "A message comes in" URL is unused** while the number sits in the Messaging
  Service (the service's webhook wins). It may still show Twilio's demo default
  (`demo.twilio.com/welcome/sms/reply`) - cosmetic; do not "fix" it expecting behavior to change.
- **Voice URLs on the number** — calls ARE handled by the app now (Voice Phase 1: inbound
  founder-bridge + outbound masked calling). On the number's Voice configuration:
  - **"A call comes in"** → `https://<canonical>/webhooks/twilio/voice` (HTTP **POST**)
  - **"Call status changes"** → `https://<canonical>/webhooks/twilio/voice/status`

  Use the canonical custom-domain host (e.g. `https://dev.app.housingchoice.org/webhooks/twilio/voice`).

The env keys that feed the app live in the gitignored `.env.<env>` and reach Parameter Store via
`npm run secrets:push -- <env>` (then a deploy to go live — see [Secrets](#secrets)):
`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` (REST), `TWILIO_AUTH_TOKEN`
(webhook signature validation ONLY), `TWILIO_MESSAGING_SERVICE_SID`, and `OUR_PHONE_NUMBERS`.

**Inbound voice routing has NO env var.** An inbound call to a business number bridges to the
assigned **inbound-voice-line holder's verified cell** — assigned in **Settings ▸ Team** (the holder
must verify their cell first). There is no `FOUNDER_CELL` fallback (removed). With **NO holder
configured**, an inbound call is **NOT bridged**: the app emits an ERROR log (→ the
`hc-<env>-error-logs` alarm, so ops is notified) and the caller hears the "please send us a text
message" greeting. The holder is a ONE-TIME, PER-ENVIRONMENT manual assignment stored as a single
pointer row in that env's users TABLE (not config): it survives deploys and normal terraform
applies, but a users-table recreate/restore loses it, and a fresh environment starts WITHOUT one
(deployed envs have NO data seeding - only the hermetic LOCAL stack auto-assigns the seeded admin).
Observed 2026-07-18: cloud dev had no holder despite inbound "working" before - the fallback
greeting masks it. **If inbound falls back to the text-us greeting, check Settings > Team first**
and re-assign.

**`OUR_PHONE_NUMBERS` must list EVERY number we own** (comma-separated E.164): it is echo/author
defense #1 — an inbound webhook whose From matches is our own outbound projected back. A missing
number degrades that defense to SID-dedupe alone; in production with the twilio driver an EMPTY
list refuses to boot.

#### Voice Intelligence transcription + platform voicemail

Business-line CALL recordings (the founder bridge) and platform VOICEMAILS are transcribed by Twilio
**Voice Intelligence (VI)** - a paid, account-configured service. Transcription is OFF until an
operator sets it up per env; recordings and voicemails still work regardless (they just carry no
transcript). Masked relay calls are NEVER recorded or transcribed (standing privacy invariant).

**Operator setup (per env - once for dev, once for prod; each env gets its OWN VI service so
completion webhooks never cross environments). THIS IS A PROD GO-LIVE STEP: prod has no VI service
until an operator runs this, and transcription stays silently OFF there.**

1. `npm run twilio:vi -- <env> --webhook-base <canonical env host>` - idempotent
   create-or-reconcile (`scripts/twilioVi.mjs`; add `--check` for a read-only drift report). Creates
   the bare `hc-<env>-voice-transcription` service with our completion webhook wired, autoTranscribe
   OFF, and NO operators/capture/Orchestrator, and prints the **`GAxxxx` sid**. Do NOT use the
   Twilio console wizard instead: it steers into the Conversational-Intelligence Orchestrator
   (capture rules + billed language operators) that we do not use - verified 2026-07-20; a leftover
   Orchestrator configuration from a partial wizard run fires junk events at our webhook.
2. Put the sid in **`TWILIO_VI_SERVICE_SID`** template-first: confirm the key in `.env.<env>.example`,
   `npm run secrets:sync -- <env>`, fill the real value in `.env.<env>`, `npm run secrets:push -- <env>`,
   then deploy (see [Secrets](#secrets)). Leaving it unset keeps transcription OFF for that env.
   Webhook-only changes (re-pointing the URL) are Twilio-side and live IMMEDIATELY - no push/deploy.
3. **When the env's canonical host changes** (staged-cutover phase 2), the VI service webhook is one
   of the URLs that must re-point: re-run `npm run twilio:vi -- <env> --webhook-base <new host>`.

**Cost:** VI is billed per transcribed hour. Only business-line bridge calls + voicemails are
transcribed (masked relay never is), so the spend tracks real founder-line call/voicemail minutes.

**How a transcript flows (background behavior, no operator action):** a completed recording mirrors to
S3, the call entry is stamped `transcript_status: pending` (the conversation shows a live
"Transcribing..." note), and the app creates a VI transcript INLINE. VI processes the audio and calls
the webhook above with a transcript sid; the app fetches the sentences and persists the transcript
text on the call entry (SSE-live). Twilio is NEVER in the read path - the conversation loads only our
DB/S3.

**Reconcile safety net:** if that completion webhook is lost, a delayed reconcile job re-checks Twilio
(~10 min in prod; a tiny delay in the hermetic lane) and persists the transcript anyway - so a lost
webhook DELAYS a transcript, it never loses it. If VI reports the transcript failed, or reconcile
gives up, the call entry stamps `transcript_status: failed` and the conversation shows "Transcript
unavailable" (the recording stays playable); a very late webhook can still upgrade failed to completed.

**Latency the founder/staff see (useful when triaging "where is my transcript"):**

- Call entry: at RING time (SSE-live); outcome stamped at hangup.
- Recording playable: ~5-30s after hangup (Twilio processing + our S3 mirror), SSE-live.
- Transcript visible: typically ~1-2 min after hangup (scales with audio length); short voicemails
  often under a minute. The "Transcribing..." note bridges the wait so it is visible, not confusing.

**Voicemail (business line only):** a MISSED inbound business-line call now plays a voicemail prompt
and records up to a 2-minute message; when a message lands the founder gets a **"New voicemail"** push
and the message is transcribed like any bridge recording. The missed-call auto-text still fires as
before (it catches callers who hang up without leaving a message; a sub-2-second recording is
discarded and the call simply stays "missed"). OUTBOUND unanswered calls and masked relay calls get NO
voicemail.

**Hermetic stack:** in dev/e2e the fake-twilio host impersonates the VI REST API + fires the signed
completion webhook, so local transcription exercises the REAL VI wire shapes (no real Twilio, no VI
spend). The fake's voice scenario grows `viWebhook` (`deliver`|`drop`; `drop` exercises the reconcile
leg) and `voicemail` (`{durationSec?}`|`false`) knobs, and `transcript` now feeds the VI sentences.
`TWILIO_VI_SERVICE_SID` + `VOICE_TRANSCRIPT_RECONCILE_SECONDS` are wired into the hermetic stack
(`scripts/e2e-session.mjs`, and `scripts/dev.mjs --mock`); the app's Intelligence API calls ride the
same `TWILIO_API_BASE_URL` redirect as the rest of Twilio (prod stays locked to real hosts).

### fake-twilio (HTTP-seam messaging mock)

**Dev/e2e only — NEVER deployed.** `fake-twilio` (workspace package `@housingchoice/fake-twilio`,
`fake-twilio/`) is a standalone service that impersonates Twilio's REST API and POSTs
correctly-signed webhooks back at the app, so the app's **real** `TwilioMessagingDriver` and
`twilioSignature` middleware run unchanged against a local impersonator — no real Twilio account,
full HTTP-seam fidelity. It is its own artifact (not in the Docker image / deploy bundle), **refuses
to boot under `NODE_ENV=production`**, and the app's `TWILIO_API_BASE_URL` redirect is **rejected by
the prod config validator** (three independent guards — see `fake-twilio/src/config.ts`,
`app/src/lib/config.ts`).

**How it runs in the stack.** `scripts/e2e-session.mjs` starts it first, on **port 8889**, then
points the app at it. The app runs the real driver (`MESSAGING_DRIVER=twilio`) redirected via
`TWILIO_API_BASE_URL=http://localhost:8889`, with a **shared** `TWILIO_AUTH_TOKEN` (the HMAC key both
sides use), `SMS_SENDING_ENABLED=true` (the A2P kill-switch defaults OFF under the twilio driver, so
it must be forced on), and `OUR_PHONE_NUMBERS=+15550009999`. The Twilio SID/secret values are
Twilio-shaped dummies (the fake never authenticates them). `e2e:restart` also bounces the fake so a
code change to it is picked up.

**Control API (port 8889)** — the scripted-scenario surface (also `GET /health`):

| Verb | Purpose |
|---|---|
| `POST /control/send-as-party` | Inject an inbound text/MMS as a party → fires a signed `/webhooks/twilio/sms` at the app |
| `GET  /control/threads` | List every thread (both directions + delivery status) — the `/__dev/outbox` superset |
| `POST /control/personas/ad-hoc` | Mint a throwaway caller number |
| `POST /control/delivery-outcome` | Set the next outbound message's delivery profile (normal / stall / fail + ErrorCode) |
| `POST /control/reset` | Clear threads + cancel in-flight status timers (wired into `e2e:reseed`) |
| `GET  /control/dispatch-errors` | The dispatcher's error ring buffer — asserts a signing/middleware regression is observable, not swallowed |

**Sign-vs-deliver split (the crux).** The dispatcher **signs** each webhook against
`APP_PUBLIC_BASE_URL` (the app's `PUBLIC_BASE_URL`, **:5173**) — because the app's signature
middleware reconstructs the signed URL as `${PUBLIC_BASE_URL}${req.originalUrl}` — but **POSTs** to
`APP_BASE_URL` (the app's real address, **:8080**). It also mirrors the dev `x-origin-verify`
header (from `CF_ORIGIN_SECRET`) so the app's origin-secret gate (which fronts `/webhooks/*`) lets it
through. **`403`s in the app log mean drift** in one of: the shared `TWILIO_AUTH_TOKEN`,
`PUBLIC_BASE_URL`, or `CF_ORIGIN_SECRET` between the two sides.

> **Version-pin caveat (from the spike).** The redirect relies on twilio v6's internal
> `RequestClient` (a **private** API), verified against **`twilio@6.0.2`**. Keep `twilio` pinned and
> **re-run `app/test/twilioHttpClient.test.ts` on any twilio upgrade** — that test is the contract
> that the host-rewrite still works.

#### Fake-phones UI

**Dev/e2e only — NEVER deployed.** A standalone React UI (workspace package
`@housingchoice/fake-twilio-web`, `fake-twilio/web/`) that lets you act as the **simulated
parties** (landlords / tenants / PMs) and watch the **real** dashboard react. It is served as a
static build by the fake-twilio host itself — **only when `FAKE_TWILIO_UI_DIST` points at the build**
(`fake-twilio/web/dist`); the host leaves it inert otherwise, so nothing about it ships (it is not
in the Docker image / deploy bundle, and the host already refuses to boot under
`NODE_ENV=production`). Staff is intentionally **not** a panel here — staff is the real dashboard,
which is what you watch react.

**How to open it.** `npm run e2e:session` builds the UI once and serves it from the host; open
**`http://localhost:8889/`**. (`npm run dev -- --mock` also runs the mock + fake-phones UI locally
and redirects the app's messaging to it — open the same **`http://localhost:8889/`**. The dev
launcher's flags are **orthogonal, single-purpose**: `--local` controls DynamoDB (hermetic Local vs
the live AWS dev backend) and `--mock` controls Twilio (redirect to this local fake vs real Twilio),
and they compose freely. `--local --mock` is the **fully hermetic** combo — the fake's seeded
`+1555…` personas match the hermetic seed data; `--mock` alone redirects Twilio against the **live
dev backend**, where those seeded personas won't map to real dev contacts.) Pick a persona from the
roster (grouped Landlord / Tenant / PM, each
with its number + unread badge; **＋ Ad-hoc number** mints a throwaway caller), type and **Send** to
fire a signed inbound webhook at the app, flip the per-thread **delivery-profile** toggle (Normal /
Stall at sent / Fail) to script the next outbound message's status callbacks, and attach a **canned
dev image** for MMS. Watch the real dashboard (**:5173**) react, and the thread's **status chips**
tick `queued → sent → delivered` (or a red `failed`/`undelivered` with its `ErrorCode`).

**Iterating on the UI itself.** `npm run dev -w @housingchoice/fake-twilio-web` runs Vite on
**:5174** with HMR, proxying `/control` + `/health` to a **running** :8889 host (start the stack with
`e2e:session` first). The served build is what `e2e:session` ships; only re-run a build (or
`e2e:restart`/re-session) to refresh the static copy the host serves.

**Live updates** ride **SSE** (`GET /control/events` on the host) — the panel reflects webhooks as
they fire. On every (re)connect the UI re-fetches personas + threads (`useFakePhones` `onOpen →
refresh`), so an SSE gap can't silently desync the view; the reconnect just re-syncs full state.

#### Voice (fake-twilio)

**Dev/e2e only — NEVER deployed.** The same fake-twilio host (**port 8889**, `FAKE_TWILIO_URL`)
also impersonates Twilio's **voice** runtime: it places a call, fetches the app's `/voice` TwiML,
plays the whisper Gather to the answering leg, injects the DTMF gate digit, and posts the `<Dial
action>` summary — driving the app's **real** voice webhooks end-to-end. Everything is deterministic
(ids from a counter, timing on an injected clock, outcome from a scripted scenario). The fake-phones
**voice UI is a separate future plan** — not built here; today's surface is the control API below.

**Founder triage is fully enabled** in the mock/e2e stack because the reseed **seeds the founder/admin
as the inbound-voice-line holder** with a verified cell (`+15550000001`) — the hermetic scripts
(`scripts/dev.mjs`, `scripts/e2e-session.mjs`) pass that value in `FOUNDER_CELL` purely as the LOCAL
seed source (there is NO `FOUNDER_CELL` fallback in the app itself). With that holder plus the
business number (`OUR_PHONE_NUMBERS=+15550009999`), an inbound call to the business number runs the
full founder bridge (whisper → press-1 → answer → record-to-MinIO → transcribe) rather than degrading
to the "text us" fallback; a no-answer scenario fires the real missed-call push + autotext job.

**Voice control API (port 8889)** — drives the `CallEngine`:

| Verb | Purpose |
|---|---|
| `POST /control/place-call` | `{from,to,scenario?}` → `{callSid}` — place a masked (`to` ∈ pool) or founder (`to` ∉ pool) call |
| `GET  /control/calls` | `{calls: CallState[]}` — every call (sid, status, legs, recording/transcript) |
| `POST /control/calls/:sid/press` | `{digit}` → `{call}` — inject a DTMF gate digit on a paused call |
| `POST /control/calls/:sid/answer` | `{leg?}` → `{call}` — mark a leg answered (bare/team dial, no whisper) |
| `POST /control/calls/:sid/hangup` | `{call}` — caller/callee hangs up before answer → no-answer |

**Scenario knobs** (all optional; the engine fills sensible defaults — first leg answers, digit `'1'`,
answered): `answerLeg` (`callee`/`founder`/`team` — advisory; the first dialed leg answers today, and
`team` is reached via the press-0 whisper-gate escape, not leg selection), `digit` (`'0'`/`'1'`/`null`
— `null` models "no press" → gate timeout → no-answer), `outcome` (`answered`/`no-answer`/`busy` —
forces the terminal `<Dial action>` status), `ringMs` (auto-run delay on the injected clock),
`record` (advisory only — see below), `transcript` (the founder-bridge transcription text). These
drive **masked vs founder** behavior: the **masked relay never records** (the app's TwiML returns
`record="do-not-record"` with no recordingStatusCallback → recording + transcription skipped); the
**founder bridge records + transcribes on answer** (TwiML returns `record="record-from-answer-dual"`
with a callback → recording fires, then transcription if `scenario.transcript` is set). Recording is
driven **entirely by the app's returned TwiML** — `scenario.record` is advisory and does not force it.

**Recording media** is fetched by the app FROM the fake: the `CallEngine` mints a `RecordingUrl` of
`${recordingServeBase}/recordings/:callSid/:recordingSid.mp3` (the serve base is the fake's own
`PUBLIC_BASE_URL`), and the app's `getRecordingStream` fetch resolves there via the **`TWILIO_API_BASE_URL`
media-host SSRF dev-override** (`url.origin === twilioApiBaseUrl origin` is allowed locally only).
**Prod stays locked to `api.twilio.com`** — the override is rejected by the prod config validator.
The fake serves the canned MP3 at `GET /recordings/:callSid/:recordingSid.mp3` (`audio/mpeg`).

**Number provisioning is now real in the fake** (was a `501` stub): `GET
.../AvailablePhoneNumbers/US/Local.json` lists mintable pool candidates and `POST
.../IncomingPhoneNumbers.json` commits a chosen number into the `NumberRegistry` (with `GET`/`POST
:sid.json` for lookup + voice/sms-webhook update) — so masked-relay **pool setup works end-to-end**: a
number purchased via REST is then recognized as a pool number by an inbound masked call.

**RCS is contract-only.** The Content-API REST path + `POST /control/send-rcs` are thin `501` seams
that point at [docs/RCS-integration-contract.md](docs/RCS-integration-contract.md); there is **no
real RCS behavior** in the fake.

### Jobs (async delivery path)

Since M1.2 every job flows: `jobs.enqueue()` (app) → one-off EventBridge Scheduler schedule
(`ActionAfterCompletion: DELETE`, named `hc-<jobName>-<jobId>`; fires no sooner than ~60 s out —
Scheduler rejects past times, so "run now" is clamped to its floor) → SQS `hc-<env>-jobs` (the JSON
job envelope IS the message body) → worker long-poll → `dispatchJob()` → handler. A failed handler
does **not** delete the message: it redelivers after the 120 s visibility timeout and dead-letters
into `hc-<env>-jobs-dlq` after 5 receives, which trips `hc-<env>-jobs-dlq-depth`.

Inspect queue/DLQ depth (queue URLs: `terraform -chdir=infra/envs/<env> output`):

```powershell
aws sqs get-queue-attributes --queue-url (terraform -chdir=infra/envs/dev output -raw jobs_queue_url) --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --profile housingchoice --region us-east-1 --no-cli-pager
aws sqs get-queue-attributes --queue-url (terraform -chdir=infra/envs/dev output -raw jobs_dlq_url) --attribute-names ApproximateNumberOfMessages --profile housingchoice --region us-east-1 --no-cli-pager
```

Peek at dead-lettered envelopes (read-only — peeked messages reappear after the visibility timeout):

```powershell
aws sqs receive-message --queue-url (terraform -chdir=infra/envs/dev output -raw jobs_dlq_url) --max-number-of-messages 10 --profile housingchoice --region us-east-1 --no-cli-pager
```

**DLQ redrive** (after fixing the cause — messages move back to the jobs queue and the worker
retries them; omitting `--destination-arn` means "back to the source queue"):

```powershell
aws sqs start-message-move-task --source-arn arn:aws:sqs:us-east-1:938565869261:hc-dev-jobs-dlq --profile housingchoice --region us-east-1
aws sqs list-message-move-tasks --source-arn arn:aws:sqs:us-east-1:938565869261:hc-dev-jobs-dlq --profile housingchoice --region us-east-1 --no-cli-pager
```

**Local dev:** `JOBS_QUEUE_URL` / `SCHEDULER_*` are unset, so the app uses the in-memory scheduler
(enqueues are accepted with a boot WARN but never delivered) and the local worker starts no poll
loop — exercising handlers locally is what the test suite's `InMemorySchedulerAdapter.deliverAll`
is for. To consume REAL dev-queue messages from a local worker, set `JOBS_QUEUE_URL` in `.env`
(live mode) — note it then competes with the deployed dev worker for messages.

#### Worker clock polls (durable-row ladders)

Separate from the SQS job path, the worker runs 60-second `setInterval` polls over durable
DynamoDB rows — state survives restarts because it lives in the table, never in process:

- **Tour reminders** (`tourReminders` table, `jobs/tourReminders.ts`): the tour-reminder ladder
  (confirmation / day-before / morning-of / en-route / no-show check-in). Armed at booking,
  re-armed on reschedule, canceled on cancel/close. Group-routed for landlord-led/PM tours.
- **Placement nudges** (`placementNudges` table, `jobs/placementNudges.ts`): the Post-Tour &
  Application ladder — one stage-keyed chase per awaiting stage (tenant: application received /
  completed; landlord: approval check at +24h, RTA 48h-window-closing at +36h). Armed/canceled by
  the status-transition choke point on every stage move; always the party's 1:1 thread, never the
  group. The RTA hard clock itself (`rta_window`, +48h) is a placement `next_deadline`, visible on
  the Today board.

Both polls use claim-before-send (a row is atomically stamped `sentAt` before the outbound send),
so a double-started worker cannot double-text. Deterministic e2e/dev seams (hermetic-LOCAL-only):
`POST /__dev/tour-reminders/tick { now? }` and `POST /__dev/placement-nudges/tick { now? }`.
If a ladder seems dead in a deployed env: check the worker service is running (one process runs
both polls), then look for `… poll error` lines in the worker logs.

### AI extraction (conversation fact extraction)

On every fresh inbound SMS from a tenant/unknown 1:1 conversation, a debounced worker poll runs
one structured-output LLM call over the recent transcript and applies a guarded write policy to
the contact (write empty fields with provenance, suggest on conflicts, append secondary facts to
notes). It is a **durable-row poll** like the two above (state in the new `ai_extraction` table,
never in process): a third 60-second `setInterval` in the worker, gated on `AI_EXTRACTION_ENABLED`.

A saved **voice transcript** (a completed call OR a voicemail) ALSO schedules an extraction run -
channel `voice`, with **no debounce** (the transcript lands minutes after the call, so it fires at
once). Extraction windows are therefore **channel-mixed**: recent texts AND transcribed calls in one
chronological transcript. Bridge-call speaker attribution is fixed in three layers - source-attributed
`Staff:`/`Client:` line prefixes when the leg roles are known at ring time; in-call role inference
otherwise; and any window containing inferred-role (`Speaker N`) lines **demotes every field write to
a suggestion**, so an unattributed transcript can only ever suggest a profile FIELD, never silently
write one (additive `notes` appends are not field writes and are never demoted).

**Environment flags** (all in `.env.<env>`, pushed via the [Secrets](#secrets) flow):

| Key | Default | Purpose |
|---|---|---|
| `AI_EXTRACTION_ENABLED` | `false` in production, `true` otherwise | Master kill switch. When off, the webhook schedules nothing and the worker starts no poll - the feature is inert. |
| `EXTRACTION_DRIVER` | `anthropic` in production, `console` otherwise | LLM driver. `anthropic` = real call; `console` = logs a summary and returns nothing (keeps local dev offline); `fake` = deterministic test seam. **`fake` is REFUSED by the prod config validator** (throws at boot). |
| `AI_EXTRACTION_MODEL` | `claude-opus-4-8` | Model id for the anthropic driver. |
| `AI_EXTRACTION_DEBOUNCE_MS` | `30000` | Sliding debounce: each inbound text slides the due time out this far, so a burst yields one run. Unparseable/non-positive -> WARN + default. |
| `ANTHROPIC_API_KEY` | (unset) | Anthropic REST key. Required when `AI_EXTRACTION_ENABLED` and `EXTRACTION_DRIVER=anthropic` in production, or the config fails fast at boot. |

**Manual tick in local dev** (hermetic-LOCAL-only, never reachable in a deployed env):
`POST /__dev/extraction/tick` runs `runDueExtractions` immediately against a clock advanced past the
debounce (so you need not wait it out) and responds `{ processed, failed }`. This mirrors the
`tour-reminders` / `placement-nudges` dev ticks. In-app ticks reach SSE clients; the worker poll's
`suggestion.updated` emits do not (single-instance seam) - poller-driven changes surface on the
dashboard's next fetch.

**Smoke test (address target).** The extracted fields are the eight scalar profile fields plus the
client's structured **CURRENT address** (written into the contact's Details "Current address" row).
Quick manual check on the dev stack once live: as a **TENANT**, text the business line a current
address, run a tick (`POST /__dev/extraction/tick`) or wait out the debounce, and confirm the
Details "Current address" row fills in with an **Auto** badge (a conflicting value surfaces a review
chip instead). Address extraction is TENANT-only. **OWED dev LIVE retest:** the fake e2e driver
proves the pipeline + UI end-to-end but CANNOT exercise real model judgement - the key risk is a
property/unit address the client is asking about, touring, or applying to (or a previous/future
address) being mis-written as their current address. Before trusting the address target in a
deployed env, run one real extraction over a live conversation that mentions a unit/property address
and confirm it does NOT land in the Current-address row.

**Owed ops on deploy (in order).** The feature ships **DORMANT** in deployed envs - `AI_EXTRACTION_ENABLED`
defaults **off** in production, so until these steps run nothing extracts and **nothing breaks** (the
webhook and worker simply skip the extraction path). To turn it on in an env:

1. **`npm run plan -- <env>` + `npm run apply -- <env>`** for the new `ai_extraction` table (single-key
   table + 3 sparse GSIs `byDueAt`/`byOwner`/`byPending`; registered in `app/src/lib/tables.ts`,
   regenerate via `npm run gen:tables`). **Online** op - the table starts empty, no data migration.
   Apply BEFORE deploying code that reads it (per [schema changes](#dynamodb-schema-changes-apply-before-deploying-code-that-uses-them)).
2. **`npm install`** - new app-workspace runtime dep `@anthropic-ai/sdk` (pure JS, no arm64 binary).
   The lockfile carries it; `npm ci --workspace app --omit=dev` picks it up on the image build.
3. **Push `ANTHROPIC_API_KEY`** via the secrets flow: add it to `.env.<env>`, `npm run secrets:push -- <env>`.
4. **Set `AI_EXTRACTION_ENABLED=true`** (and confirm `EXTRACTION_DRIVER=anthropic`, `AI_EXTRACTION_MODEL`)
   in `.env.<env>`, then `npm run secrets:push -- <env>`.
5. **Deploy** so the app + worker roll and re-hydrate the new env keys (a re-deploy of the current
   `DEPLOYED_TAG` suffices) - the worker then starts the third poll and the webhook starts scheduling.

Dev applies after merge; **prod rides the M1.11 cutover**. If extraction seems dead in a deployed env:
confirm `AI_EXTRACTION_ENABLED=true` is hydrated on the box, the `ai_extraction` table exists, and look
for `extraction poll error` lines in the worker logs.

**Post-merge LIVE verification (voice Layer 1 attribution).** The `Staff:`/`Client:` line prefixes on a
bridge transcript come from a channel->role map stamped at ring time on the assumption that a Twilio
dual-channel `<Dial>` records the parent leg as channel 1 and the dialed party as channel 2 (inbound
founder bridge: channel 1 = the caller/client, channel 2 = the dialed staff cell). This is doc-verified
but NOT yet confirmed against a real recording. AFTER the operator VI services + `TWILIO_VI_SERVICE_SID`
secrets are configured and deployed (see the voice-transcription runbook), place **ONE** real dev
founder-bridge call, let it transcribe, and confirm the stored transcript's `Staff:`/`Client:` prefixes
match who actually spoke. **This is a HARD gate before trusting voice attribution in prod.** An
ATTRIBUTED call (source-stamped roles) DIRECT-WRITES fields on the assumed orientation, so an inverted
channel->role guess would silently mis-attribute a staff statement to the client and write it with an
Auto badge - no review. Layer 3 (demote-to-suggestion) only protects UNATTRIBUTED windows (legacy
`Speaker N` transcripts with no role map); it does NOT cover the attributed path. The orientation is
doc-verified (Twilio: parent leg = channel 1), so the risk is low - but confirm it empirically here
before relying on voice attribution. Nothing writes until `AI_EXTRACTION_ENABLED` is on, so this gate
sits comfortably ahead of any real extraction.

### What the health-check gate does

Every deploy (build, `--tag`, `--promote`) runs this gate **on the instance** before declaring success:

1. `curl localhost:8080/health` until 200 (up to 12 × 5 s).
2. Both containers (`app`, `worker`) must be in state `running`.
3. The worker must have printed its `worker ready` boot line (it has no health endpoint).
4. **Only after** all three pass does it `docker image prune -af` (the 10 GB root volume depends
   on pruning happening only on success — a failed deploy never prunes the previous image).

Then the **operator side** verifies `https://<cloudfront>/health` returns 200 (up to 8 × 5 s), and
only then writes the released tag to SSM `/hc/<env>/app/DEPLOYED_TAG`.

### What a failed deploy looks like

- The script exits non-zero, prints the instance's compose state + last 50 container log lines,
  and prints the exact rollback one-liner (using the image that was running before).
- **`DEPLOYED_TAG` is NOT flipped** — it only ever records deploys that passed both the
  on-instance gate and the CloudFront check. So `DEPLOYED_TAG` always answers "what was last
  *successfully* released", even mid-incident.
- The previously running image is not pruned, so rollback is a fast re-pull (cached layers).
- Lifecycle log lines (`app listening`, `worker ready`, shutdown) carry a per-process `bootId`
  as their correlationId, so container starts do NOT trip the orphan-log alarm (fixed
  2026-06-12; images tagged before that date still have the transient ALARM→OK wart).

### Troubleshooting: disk full after repeated failed deploys

Images are this box's only meaningful disk-growth vector (builds happen on the operator machine;
container logs ship to CloudWatch via the awslogs driver, not to local files). The deploy script
runs `docker image prune -af` **only after a successful health-gated deploy** — failures
deliberately don't prune, so a long streak of consecutive failed deploys can fill the 10 GB root
until the next image pull itself fails (`no space left on device` in the SSM/deploy output).

Recovery (~2 minutes, no data at risk — rollback images live in ECR, not on disk):

```powershell
aws ssm start-session --target <instance-id> --profile housingchoice --region us-east-1
```

then on the box:

```bash
sudo docker image prune -af     # frees everything not used by a running container
df -h /                          # confirm
```

Exit and re-run the deploy. A successful deploy's own prune also sweeps ALL accumulated junk
(every image not in use by the now-running containers), so the disk resets to ~one image on
every green deploy — this section is only needed when the failure streak wins the race.

## Push notifications (PWA install + heads-up setup)

The founder's pre-ring/missed-call alert is only useful if it **pops up on screen** (a "heads-up"
banner, like a text), not just lands silently in the notification shade. Whether it pops is an
**OS-level** decision driven by notification *importance* — the app sends the strongest signals it
can (every push goes out `urgency: 'high'`, and the service worker attaches a `vibrate` pattern +
`requireInteraction` for `missed_call`/`pre_ring` — see [app/src/adapters/webPush.ts](app/src/adapters/webPush.ts)),
but the final gate is a per-device setting the founder must enable. Run this once per device during
onboarding.

**Prerequisites (both platforms):**

1. **Install the PWA to the home screen** — web push does NOT work from a browser tab. On Android
   (Chrome) "Install app" creates a *WebAPK* (its own entry in Settings → Apps); on iOS use
   Share → "Add to Home Screen".
2. **Open the installed app** (not the browser) and **grant the notification permission** when
   prompted (or via the in-app settings toggle).
3. Send a **test push** (admin → push test, the `kind:'test'` send) to confirm delivery. On Android
   this also *creates the notification category* you configure in the next step — the category does
   not exist in settings until the app has posted at least one notification.

### Android (installed PWA = WebAPK)

The installed PWA is **its own app**, so its notification settings live under **Settings → Apps →
[the PWA's name] → Notifications** — *not* under Chrome, and Chrome's per-site notification controls
do **not** apply to it.

- **Samsung (One UI 6.1+) — this is the most common gotcha:** Samsung **disables per-app
  notification categories by default**, so the installed PWA shows only a single master on/off
  toggle with **no importance / sound / vibration controls** (exactly the "there's nothing to set"
  symptom). Re-enable them first: **Settings → Notifications → Advanced settings → turn on "Manage
  notification categories for each app."** Then go to **Settings → Apps → [PWA] → Notifications**,
  tap the notification **category**, and set it to **Alert** (not Silent) with **pop-up** and
  sound/vibration on.
- **Stock Android / Pixel:** **Settings → Apps → [PWA] → Notifications** → tap the notification
  **category** → choose **Alerting** → turn on **"Pop on screen."** (Equivalently, set the
  category's **Importance** to **Urgent**.)
- Make sure **Do Not Disturb / a Focus/Bedtime mode is not active** — it suppresses heads-up
  banners regardless of these settings.
- **If it's stuck silent and won't change:** Android locks a category's importance once created and
  the app can't raise it afterward. If toggling the category doesn't take, **uninstall and
  reinstall the PWA** to recreate the channel fresh, then re-grant permission.

### iPhone (installed PWA, iOS 16.4+)

There is **no code lever for heads-up on iOS** — banners are governed entirely by the per-PWA
notification settings, so this checklist *is* the fix:

- The PWA must be **added to the Home Screen** (push does not work from a Safari tab).
- **Settings → Notifications → [the PWA's name]:** **Allow Notifications ON**, **Banners ON**,
  **Banner Style → Persistent** (the default *Temporary* auto-dismisses after a moment — Persistent
  stays until dismissed), and **Sounds ON**.
- Confirm **no Focus mode** is active (Focus silences banners and may route them to the summary).

> Push subscriptions are **origin-scoped** — see [PWA re-install + push re-grant](#pwa-re-install--push-re-grant-origin-change):
> after a domain cutover every device must re-install the PWA and re-grant permission, then redo
> this setup.

## Rollback

One-liner per env (re-deploys an EXISTING ECR tag — no build, ~20–25 s end to end):

```powershell
npm run deploy:dev  -- --tag <previous-dev-tag>
npm run deploy:prod -- --tag <previous-prod-tag>
```

How to find the previous tag:

1. `npm run deploy:<env> -- --list` — newest-first tag list; `<== DEPLOYED` marks the current one.
   The previous tag is usually the next line down.
2. Every deploy's summary also prints `previous tag:` and the exact rollback command — scroll up
   in the terminal of the deploy you are reverting.

The rollback goes through the same health-check gate and CloudFront verification, and flips
`DEPLOYED_TAG` only on success.

## Reading logs

CloudWatch Logs Insights, region us-east-1. Select **both** log groups `/hc/<env>/app` and
`/hc/<env>/worker` so you see the full picture (the queries below work across both). Every line is
pino JSON; Insights auto-discovers the fields (`level`, `msg`, `correlationId`, `requestId`,
`jobRunId`, `err.stack`, ...). `@logStream` is `app/<container-id>` or `worker/<container-id>`,
which tells you which process said it.

**(a) Everything for one correlation ID** (a request and all logs it caused in that process):

```
fields @timestamp, @logStream, level, msg
| filter correlationId = 'PASTE-CORRELATION-ID'
| sort @timestamp asc
```

**(b) All errors (pino level >= 50) in the last hour, with stack traces** — set the console time
range to 1h (or keep the filter line):

```
fields @timestamp, @logStream, correlationId, msg, err.stack
| filter level >= 50 and @timestamp > now() - 1h
| sort @timestamp desc
```

**(c) Orphan lines (no correlationId)** — these should be **ZERO**, always, and they alarm
(`hc-<env>-orphan-logs`). Boot/shutdown lines carry a `bootId` correlationId since 2026-06-12,
so ANY hit from this query is a real bug — a code path logging outside the context gates:

```
fields @timestamp, @logStream, level, msg
| filter not ispresent(correlationId)
| sort @timestamp desc
```

**(d) One request's full journey, including job hops.** The correlation context is stamped into
every `jobs.enqueue()` payload, so worker lines for jobs caused by a request still carry that
request's `requestId` (their `correlationId` becomes the `jobRunId`, but `requestId` survives the
hop). Filter on `requestId` to stitch the whole story across app **and** worker:

```
fields @timestamp, @logStream, correlationId, jobRunId, msg
| filter requestId = 'PASTE-REQUEST-ID' or correlationId = 'PASTE-REQUEST-ID'
| sort @timestamp asc
```

## Drift

```powershell
npm run drift             # dev (default)
npm run drift -- prod
```

This is `terraform plan -detailed-exitcode` (read-only — it never changes anything):

| Exit code | Meaning |
|---|---|
| 0 | Clean — real infrastructure matches state and configuration |
| 2 | **DRIFT DETECTED** — the diff is printed above the message |
| 1 | The check itself errored (credentials, init, syntax) |

On drift: **investigate what changed in the console/out-of-band, then revert it via Terraform —
never console-fix.** Concretely: read the printed diff, figure out who/what made the change
(CloudTrail if needed), then `npm run plan -- <env>` + review + `npm run apply -- <env>` to push
reality back to the declared configuration. If the drifted value is actually *desired*, change the
`.tf` code instead and apply that. The console stays read-only either way.

Note: SSM `/hc/<env>/app/DEPLOYED_TAG` is written by deploys and is **unmanaged by Terraform on
purpose** — it never shows up as drift.

## Alarms

14 alarms (7 per env), all notifying SNS `hc-<env>-alerts` (email) on both ALARM and OK.

> **SNS subscription note:** email subscriptions need a one-time confirmation click.
> `hc-dev-alerts` is confirmed; **`hc-prod-alerts` is still `PendingConfirmation`** as of
> 2026-06-11 — until the "AWS Notification - Subscription Confirmation" email is clicked, prod
> alarms fire into the void. Re-send if lost: `aws sns subscribe --topic-arn
> arn:aws:sns:us-east-1:938565869261:hc-prod-alerts --protocol email --notification-endpoint
> <email> --profile housingchoice`.

| Alarm (dev / prod) | Fires when | What it means | First response |
|---|---|---|---|
| `hc-dev-orphan-logs` / `hc-prod-orphan-logs` | `OrphanLogs` sum > 0 over 5 min | A code path logged outside the correlation context (binding guideline #4 says this must be zero) | Run Insights query (c) above to find the offending lines. If they are only the `app listening` / `worker ready` boot lines, this is the known deploy-time artifact — it clears at the next 5-min evaluation that sees log traffic (observed: ~6–15 min; with zero traffic it can linger until the next request, so hit `/health` once to hurry it). The boot-log correlation fix shipped 2026-06-12, so any orphan hit now is a real bug. Anything else: find the code path and fix the gate (route the log through the correlation context / `jobs` envelope). |
| `hc-dev-error-logs` / `hc-prod-error-logs` | `ErrorLogs` sum >= 5 over 5 min | App/worker emitting error/fatal (pino level >= 50) at volume | Insights query (b) for the stacks; every error line carries a `correlationId` — pivot to query (a)/(d) for the full story. Roll back (`-- --tag <previous>`) if a deploy caused it. |
| `hc-dev-status-check-failed` / `hc-prod-status-check-failed` | EC2 `StatusCheckFailed` >= 1 (missing data = breaching) | Instance or underlying AWS hardware/network problem — also fires if the instance stops reporting entirely | Check SSM: `aws ssm describe-instance-information --profile housingchoice --region us-east-1`. If unreachable, reboot **via CLI** (console stays read-only): `aws ec2 reboot-instances --instance-ids <id> --profile housingchoice --region us-east-1`. Containers restart on boot (`restart: unless-stopped`). If the instance is truly dead, `npm run plan/apply -- <env>` will recreate it; then re-deploy the current `DEPLOYED_TAG`. |
| `hc-dev-jobs-dlq-depth` / `hc-prod-jobs-dlq-depth` | `ApproximateNumberOfMessagesVisible` > 0 on `hc-<env>-jobs-dlq` | A job envelope failed all 5 worker dispatch attempts and was dead-lettered — reminders/follow-ups are revenue-critical (doc §9 "Job/DLQ depth") | Worker ERROR logs first: Insights query (b) — the `job failed` lines carry `jobName`, stack, and the originating request's correlation IDs. Peek the DLQ to see the stuck envelopes, fix the handler/data (deploy), then redrive — exact one-liners in [Jobs](#jobs-async-delivery-path). The alarm clears once the DLQ drains. |
| `hc-dev-disk-used` / `hc-prod-disk-used` | `disk_used_percent` (root, CWAgent) > 80% | 10 GB root volume filling — usually Docker images/layers | Inspect via SSM Run Command (no SSH): `docker system df`, then `docker image prune -af` (safe: the running containers' images are in use). The deploy's prune-on-success keeps disk in check during normal operations (post-deploy: ~26% used). |
| `hc-dev-mem-used` / `hc-prod-mem-used` | `mem_used_percent` (CWAgent) > 80% sustained 15 min (3 × 5-min) | Host memory pressure on the 2 GB t4g.small — slow leak or gradual creep in the app/worker Node containers | Via SSM Run Command: `free -m` (current totals) and `docker stats --no-stream` (per-container breakdown). Check app and worker logs for memory-leak symptoms (growing heap, GC pressure). The box survives a container OOM kill via `restart: unless-stopped`; this alarm is the leading-indicator warning before OOM. |
| `hc-dev-mem-used-critical` / `hc-prod-mem-used-critical` | `mem_used_percent` (CWAgent) > 90% for 5 min (1 × 5-min) | Acute near-OOM spike on the 2 GB t4g.small — container(s) likely imminently OOM | Via SSM Run Command: `free -m` and `docker stats --no-stream`. Identify the leaking container; the box survives a kill via `restart: unless-stopped` but an OOM loop will degrade service. Check app/worker for a memory leak and redeploy a fix. If the box is unresponsive, reboot via CLI: `aws ec2 reboot-instances --instance-ids <id> --profile housingchoice --region us-east-1`. |

### CloudWatch agent

The CloudWatch agent collects two host metrics that the log-derived metrics cannot see:

- **`disk_used_percent`** — root volume (`/`) usage; `drop_device:true` so the alarm
  dimensions are `InstanceId`, `path`, `fstype` (no device node, which varies by instance).
- **`mem_used_percent`** — total host memory (RSS + buffers + cached), reported as a percent
  of the 2 GB t4g.small total.

The agent also runs **two OTLP receivers**: one on
`0.0.0.0:4318` forwarding spans to **AWS X-Ray** (traces pipeline), and one on `0.0.0.0:4320`
publishing metrics to **CloudWatch metrics** under the `CWAgent` namespace (metrics pipeline). The
app and worker containers export to the host agent via `host.docker.internal` — the compose
`extra_hosts: host.docker.internal:host-gateway` alias makes the host reachable from inside each
container. See [OTLP wiring — apply and verify](#otlp-wiring--apply-and-verify) below for the
one-time apply steps.

The agent config lives on the instance at
`/opt/aws/amazon-cloudwatch-agent/etc/hc-agent.json` and is written by the EC2 `user_data`
script at first-boot. rsyslog ships `/var/log/messages` (kernel ring buffer, OOM-killer lines)
to the CloudWatch log group `/hc/<env>/system`; the agent ships those log lines alongside the
metrics. The System Status page surfaces OOM events from `/hc/<env>/system` in two flavors:

- **Kernel OOM-kill** — lines matching `Out of memory: Killed process` in the
  `/hc/<env>/system` log group (written by rsyslog from `/var/log/messages`).
- **V8 heap OOM** — lines matching `FATAL ERROR: Reached heap limit` emitted by Node in the
  `/hc/<env>/app` and `/hc/<env>/worker` log groups.

**One-time install for an already-running instance** (EC2 `user_data` runs only at first boot;
use this when the instance pre-dates the agent config). Fill `<instance-id>` with the real ID
from the Quick Reference table above. For prod use `/hc/prod/system` as the log group name
(dev uses `/hc/dev/system`).

```powershell
# Step 1: install rsyslog + agent, enable rsyslog. $installCmd is plain JSON (single-quoted,
# real double-quotes preserved). Backtick-escaped quotes build the --parameters JSON safely.
$installCmd = '["dnf install -y rsyslog amazon-cloudwatch-agent","systemctl enable --now rsyslog"]'
aws ssm send-command --profile housingchoice --region us-east-1 --instance-ids <instance-id> --document-name "AWS-RunShellScript" --parameters "{`"commands`":$installCmd}" --comment "install rsyslog+CWAgent" --no-cli-pager

# Step 2: write the agent config + start the agent. The JSON is base64-encoded locally, then
# decoded on the instance — base64 has no quotes/backslashes/shell-special chars, so it embeds
# cleanly with zero escaping hazard. $json is single-quoted so its real double-quotes and the
# literal ${aws:InstanceId} placeholder (the agent expands it at runtime) are preserved as-is.
$json = '{"agent":{"metrics_collection_interval":60,"run_as_user":"root"},"metrics":{"namespace":"CWAgent","append_dimensions":{"InstanceId":"${aws:InstanceId}"},"metrics_collected":{"mem":{"measurement":["mem_used_percent"]},"disk":{"measurement":["disk_used_percent"],"resources":["/"],"drop_device":true},"otlp":{"grpc_endpoint":"127.0.0.1:4319","http_endpoint":"0.0.0.0:4320"}}},"traces":{"traces_collected":{"otlp":{"grpc_endpoint":"127.0.0.1:4317","http_endpoint":"0.0.0.0:4318"}}},"logs":{"logs_collected":{"files":{"collect_list":[{"file_path":"/var/log/messages","log_group_name":"/hc/dev/system","log_stream_name":"{instance_id}"}]}}}}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
$configCmd = "[`"echo $b64 | base64 -d > /opt/aws/amazon-cloudwatch-agent/etc/hc-agent.json`",`"/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/hc-agent.json`"]"
aws ssm send-command --profile housingchoice --region us-east-1 --instance-ids <instance-id> --document-name "AWS-RunShellScript" --parameters "{`"commands`":$configCmd}" --comment "write CWAgent config + start" --no-cli-pager
```

> **Why two separate SSM commands?** SSM Run Command executes all `commands` array elements in
> a single shell script, but Step 1 installs packages (longer; can take 30–60 s). Running them
> separately lets you verify Step 1 completes before writing the config. Check command status
> with `aws ssm list-command-invocations --command-id <id> --details --profile housingchoice --region us-east-1 --no-cli-pager`.

> **Why base64.** The agent JSON is base64-encoded in PowerShell and decoded on the instance
> (`base64 -d`). base64 output is only `[A-Za-z0-9+/=]` — no quotes, backslashes, heredocs, or
> shell-special characters — so it passes through the PowerShell layer and SSM's JSON transport
> with zero escaping hazard. `$json` is single-quoted, so its double-quotes and the literal
> `${aws:InstanceId}` placeholder (expanded by the agent at runtime) are preserved verbatim. The
> `--parameters` JSON uses PowerShell's backtick quote-escape (`` `" ``), the correct PS escape.

> **Prod note.** Change `/hc/dev/system` to `/hc/prod/system` in `$json` before running
> against the prod instance at M1.11 cutover.

### OTLP wiring — apply and verify

**What changed (2026-07-02).** The CloudWatch agent now also acts as
an OTLP receiver: traces on `0.0.0.0:4318` → AWS X-Ray; OTLP metrics on `0.0.0.0:4320` →
CloudWatch metrics (`CWAgent` namespace). The app and worker containers export to the host agent
via `host.docker.internal:4318` (traces) and `host.docker.internal:4320` (metrics). Two new IAM
actions (`xray:PutTraceSegments` etc., mirroring `AWSXRayDaemonWriteAccess`) were added to the
instance role; the `PutMetricData` grant already covered `CWAgent` metrics. Telemetry only flows
when both the agent config and the env vars are in place — apply them in the order below.

#### 1. Apply Terraform (IAM + user_data — new instances and the instance role)

```powershell
npm run plan -- dev
npm run apply -- dev
```

> **Prod:** rides the M1.11 cutover — `npm run plan -- prod` / `npm run apply -- prod` at that
> milestone, consistent with all prod-infra deferrals in this runbook.

#### 2. Update the agent config on the already-running dev instance

`user_data` runs only at first boot. Push the new config (which includes the two OTLP receiver
sections) to the running instance via SSM and reload the agent. This is identical to the one-time
install snippet above, with `$json` already set to the current config (including OTLP). Run Step 2
only (the agent is already installed):

```powershell
# Re-apply the agent config with the OTLP receiver sections. $json is single-quoted so its
# double-quotes and the literal ${aws:InstanceId} placeholder are preserved verbatim.
$json = '{"agent":{"metrics_collection_interval":60,"run_as_user":"root"},"metrics":{"namespace":"CWAgent","append_dimensions":{"InstanceId":"${aws:InstanceId}"},"metrics_collected":{"mem":{"measurement":["mem_used_percent"]},"disk":{"measurement":["disk_used_percent"],"resources":["/"],"drop_device":true},"otlp":{"grpc_endpoint":"127.0.0.1:4319","http_endpoint":"0.0.0.0:4320"}}},"traces":{"traces_collected":{"otlp":{"grpc_endpoint":"127.0.0.1:4317","http_endpoint":"0.0.0.0:4318"}}},"logs":{"logs_collected":{"files":{"collect_list":[{"file_path":"/var/log/messages","log_group_name":"/hc/dev/system","log_stream_name":"{instance_id}"}]}}}}'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
$configCmd = "[`"echo $b64 | base64 -d > /opt/aws/amazon-cloudwatch-agent/etc/hc-agent.json`",`"/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/hc-agent.json`"]"
aws ssm send-command --profile housingchoice --region us-east-1 --instance-ids i-0ad45daa858632001 --document-name "AWS-RunShellScript" --parameters "{`"commands`":$configCmd}" --comment "apply OTLP receiver config" --no-cli-pager
```

> **Prod note.** Change `/hc/dev/system` to `/hc/prod/system` and use the prod instance ID
> (`i-087fd4eda3e2804c1`) when running against prod at M1.11 cutover.

After sending, confirm the command succeeded and that the agent log shows both receivers started
cleanly (see Troubleshooting below).

#### 3. Set the OTLP env vars and deploy

Telemetry starts flowing only when both ends are in place (agent config live + env vars set). Do
step 2 first; then:

1. Merge BOTH new keys from `.env.dev.example` into the real `.env.dev`:
   - `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318`
   - `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://host.docker.internal:4320/v1/metrics`

   Both must be set together — if the metrics var is missing, metrics fall back to `:4318` and
   collide with the traces receiver, silently losing metrics.

2. Push to Parameter Store and deploy:

```powershell
npm run secrets:push -- dev
npm run deploy:dev
```

#### 4. Verify in the console

Hit a few routes in the app first to generate traces and metric data points.

**Traces → X-Ray.** In the CloudWatch console: **Application monitoring → Traces** (or the
classic X-Ray console → **Traces** / **Service map**), region us-east-1. Look for service names
`housingchoice-app` and `housingchoice-worker`. Allow a minute for the first segments to appear.

**Metrics → CloudWatch metrics, namespace `CWAgent`.** In the CloudWatch console: **Metrics →
All metrics → `CWAgent`**. App OTel instrument metrics appear here alongside the existing host
`mem_used_percent` / `disk_used_percent` metrics (same namespace). Dimensions include `InstanceId`.

#### Troubleshooting

- **Both OTLP receivers listening?** Via SSM Run Command on the instance:
  `ss -ltnp | grep -E '4318|4320'` — both HTTP ports must be bound. If one is missing, the agent
  log will show "address already in use" (stale single-port config) or a receiver startup error.
- **Agent log clean?** Check
  `/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log` (via SSM) after running
  fetch-config. Both OTLP receivers must show a successful start with NO "address already in use"
  error — that error means a port collision (a stale config still occupying a port).
- **Both env vars in the container?** Via SSM Run Command:
  `docker compose exec app env | grep OTEL` — expect `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318` AND `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://host.docker.internal:4320/v1/metrics`. If either is missing, re-run `secrets:push` and redeploy.
- **`host.docker.internal` resolving?** Via SSM:
  `docker compose exec app getent hosts host.docker.internal` — must resolve to the host gateway
  IP. If not, the compose `extra_hosts` alias is missing (verify the deployed `docker-compose.yml`
  has `extra_hosts: ["host.docker.internal:host-gateway"]` on both `app` and `worker`).
- **IAM applied?** Confirm `npm run apply -- dev` completed (exit 0) after this branch merged.
  Without the `XRayTraces` IAM statement, the agent will receive spans but fail to PUT them to
  X-Ray (access-denied errors in the agent log).
- **`OTEL_SDK_DISABLED` must NOT be set** in deployed envs (it disables the SDK entirely). It is
  `true` only in `.env.example` for local/hermetic runs — confirm it is absent from `.env.dev`
  and `.env.prod`.

## Costs

Honest monthly estimate **at idle, both stacks combined** (us-east-1, on-demand, 730 h/mo):

| Item | Unit | Monthly |
|---|---|---|
| 2 × EC2 t4g.small (24/7) | ~$0.0168/h each | **$24.53** |
| 2 × public IPv4 (EIP) | $0.005/h each | **$7.30** |
| 2 × 10 GB gp3 root volume | $0.08/GB-mo | **$1.60** |
| CloudFront, DynamoDB (on-demand+PITR, empty), S3, ECR storage, CloudWatch logs/alarms/dashboards, Parameter Store, SNS, SES | idle traffic ≈ 0 | **≈ $0–1** |
| Route 53 | none (no hosted zone) | $0.00 |
| **Total** | | **≈ $33–34/mo** |

That is **materially above the architecture doc's "~$25/mo" expectation** (~35% over). The gap is
simply that the doc's number doesn't fully price two always-on stacks: the second instance and the
two public IPv4 charges dominate. Options if/when it matters (NOT actioned — decide first):

- **Single-stack idle:** stop the dev instance when not developing (saves ~$12.3/mo compute; the
  EIP of a *stopped* instance still bills, and an unattached EIP bills the same $3.65).
- **t4g.micro for dev** (~$6.1/mo): halves dev compute; fine for Phase 0 workloads.
- **Release the dev EIP** while dev is down (saves $3.65/mo, but the origin DNS changes on
  re-create → requires a Terraform apply + CloudFront update).

The Terraform `budget` module already emails at 80% actual / 100% forecast of a **$40/mo** budget,
so an honest ~$33 idle baseline leaves little headroom — expect 80% (= $32) budget emails as normal.

## Custom domain & TLS

Change Order 3 puts the platform on custom hostnames in front of the existing CloudFront distributions:

| | dev | prod |
|---|---|---|
| Custom host | `dev.app.housingchoice.org` | `app.housingchoice.org` |
| Distribution | `d2w86qra2rq9iz.cloudfront.net` (`E1GRFFQ3LDD8HU`) | `d3v3fqgxdcoxv9.cloudfront.net` (`E17AV6DZTTJUS6`) |

**What's in Terraform vs. by hand.** The per-stack ACM certificate (us-east-1, DNS-validated) and the CloudFront alias + cert attach are Terraform (`infra/modules/acm`, wired in `stack.tf`; SNI-only, min TLS 1.2). **DNS is NOT** — the `housingchoice.org` zone lives at **Namecheap**, so the records below are entered by hand in Namecheap → Advanced DNS. This is the one deliberate deviation from zero-drift IaC (README deviations table); migrating the zone to Route 53 is parked (doc §14).

### Namecheap record inventory

⚠️ **Namecheap auto-appends the base domain.** Strip the trailing `.housingchoice.org` (and any trailing dot) from the Host before pasting. ACM gives a name like `_abc123.dev.app.housingchoice.org.` → Namecheap **Host = `_abc123.dev.app`**.

| Env | Type | Host (Namecheap) | Value | Notes |
|---|---|---|---|---|
| dev | CNAME | `_<hash>.dev.app` | `_<hash>.acm-validations.aws.` | ACM validation (`terraform output acm_validation_records`). **Leave forever** — ACM reuses it for auto-renewal. |
| dev | CNAME | `dev.app` | `d2w86qra2rq9iz.cloudfront.net` | App CNAME. Cut ONLY after the cert is issued + attached (phase 1). Low TTL while testing. |
| prod | CNAME | `_<hash>.app` | `_<hash>.acm-validations.aws.` | ACM validation. Leave forever. |
| prod | CNAME | `app` | `d3v3fqgxdcoxv9.cloudfront.net` | App CNAME. |

Exact values print at the end of `npm run apply`, or read them ad-hoc (the S3 backend pins the `housingchoice` profile, but set it anyway — the repo never uses the default chain): `$env:AWS_PROFILE='housingchoice'; terraform -chdir=infra/envs/<env> output acm_validation_records` and `... output app_cname_target`.

### Staged cutover (per stack)

The `custom_domain_phase` local in `infra/envs/<env>/main.tf` staircases the rollout so the first apply never deadlocks on DNS Terraform can't create:

1. **Phase 0 → request the cert.** `custom_domain_phase = 0` (default). `npm run plan -- <env>` → `npm run apply -- <env>` creates the ACM cert (PENDING_VALIDATION). Read `acm_validation_records` from the apply output (or `$env:AWS_PROFILE='housingchoice'; terraform -chdir=infra/envs/<env> output acm_validation_records`), enter that CNAME in Namecheap, wait for ISSUED (`aws acm describe-certificate --certificate-arn <arn> --region us-east-1 --profile housingchoice --query Certificate.Status`).
2. **Phase 1 → attach alias + cert.** Set `custom_domain_phase = 1`, plan + apply (validates, then attaches alias + cert to the distribution; SNI, TLS 1.2). **Now** add the app CNAME in Namecheap (`output app_cname_target`) and verify the new host (checklist below). The old `*.cloudfront.net` host still works and `PUBLIC_BASE_URL` is unchanged.
3. **Phase 2 → flip canonical URL.** Set `custom_domain_phase = 2`, plan + apply (repoints `PUBLIC_BASE_URL` to the custom host), then **`npm run deploy:<env>`** so the app re-hydrates `.env` with the new `PUBLIC_BASE_URL`. In the same window, re-point Google OAuth redirect URIs and Twilio webhooks to the new host - that includes the **Voice Intelligence service webhook**: `npm run twilio:vi -- <env> --webhook-base <new host>` (creates the env's VI service if it does not exist yet - a prod go-live prerequisite for transcription; see [Voice Intelligence transcription + platform voicemail]). (Prod holds phase 2 until the M1.11 ported-number cutover.)

> **The CSRF origin gate is single-origin.** Once `PUBLIC_BASE_URL` flips (phase 2 + redeploy), state-changing requests through the OLD `*.cloudfront.net` host are rejected (GET/`/health` unaffected). Coordinate phase 2 with the user-facing switch.

### Cert auto-renewal

ACM auto-renews DNS-validated certs with no action **as long as the validation CNAME stays in Namecheap**. Never delete it; no alias/app-CNAME change is needed at renewal.

### PWA re-install + push re-grant (origin change)

Web-push subscriptions and the installed PWA are **origin-scoped**. Moving an origin from `*.cloudfront.net` to the custom host **invalidates existing push subscriptions**, and the installed PWA is a different app. After cutover each user must **re-install the PWA on the new host and re-grant notification permission**. Stale old-origin subscriptions are handled gracefully (the push adapter drops 404/410 endpoints — no crash).

### Live verification checklist (run against the new host after phase 1 / phase 2)

```powershell
# 1. TLS + cert: 200 over HTTPS on the custom host; cert is the ACM cert (not *.cloudfront.net)
curl.exe -sI https://dev.app.housingchoice.org/health           # expect HTTP/2 200
echo | openssl s_client -connect dev.app.housingchoice.org:443 -servername dev.app.housingchoice.org 2>$null | openssl x509 -noout -subject -ext subjectAltName   # CN/SAN = dev.app.housingchoice.org
# 2. HTTP -> HTTPS redirect
curl.exe -sI http://dev.app.housingchoice.org/health            # expect 301/302 to https
# 3. min TLS 1.2 enforced (a TLS 1.1 handshake must FAIL)
curl.exe -sI --tlsv1.1 --tls-max 1.1 https://dev.app.housingchoice.org/health   # expect handshake failure
# 4. Origin reachable ONLY via CloudFront (direct-to-EC2 must fail) -- eip from: terraform output eip_public_dns
curl.exe -sS --max-time 6 http://<eip_public_dns>:8080/health   # expect timeout/refused (SG = CloudFront prefix only)
```

Then exercise the app paths: OAuth login completes on the new host; an inbound text's Twilio signature verifies (no `invalid X-Twilio-Signature` in logs); push subscribe on the new origin receives a test push; a unit flyer / housing-fair link renders on the new host. The host-agnostic behaviors are also pinned by `app/test/customDomainCutover.test.ts`.

### Rollback

- **Before the app CNAME is cut:** nothing user-facing changed — drop `custom_domain_phase` back and apply.
- **After phase 2:** set `custom_domain_phase = 1` (or `0`), apply, redeploy — `PUBLIC_BASE_URL` returns to the `*.cloudfront.net` host, which never stopped serving. The custom-host CNAME can stay or be removed in Namecheap; with no alias attached, CloudFront stops serving that host.
- The default `*.cloudfront.net` hostname + cert stay valid throughout — always the safety net.
- The phase-2 OAuth/Twilio re-point doesn't need undoing: the original `*.cloudfront.net` OAuth callback URIs and Twilio webhooks were never removed (Change Order 3 adds the custom-host ones alongside), so login and webhooks keep working after a rollback. Leave the custom-host registrations in place.

## Email (SES)

Email channel v1 puts two-way email (send + receive, interleaved in the conversation timeline) on AWS SES. The `infra/modules/inbound_mail` module authors the classic-SES DOMAIN family per stack (`aws_ses_domain_identity` + DKIM + configuration set + the receipt-rule pipeline: S3 raw-MIME bucket + two SNS topics -> ONE inbound-mail SQS queue the worker consumes). It is SEPARATE from `module "ses"` (that is the single sandboxed sender ADDRESS `cameron@abt-industries.com`, unrelated).

| | dev | prod |
|---|---|---|
| Mail domain | `mail.dev.housingchoice.org` | `mail.housingchoice.org` |
| Inbound bucket | `hc-dev-inbound-mail-<account>` | `hc-prod-inbound-mail-<account>` |
| Inbound queue / DLQ | `hc-dev-inbound-mail` / `hc-dev-inbound-mail-dlq` | `hc-prod-inbound-mail` / `hc-prod-inbound-mail-dlq` |
| Rule-set owner (`manage_mail_rule_set`) | **true** (owns `hc-inbound-mail`) | false (adds its rule into dev's set) |

**Raw-MIME retention (adv M5).** The inbound S3 bucket has an `aws_s3_bucket_lifecycle_configuration`: current raw MIME objects (full bodies + attachments = PII, deliberately never served) **expire after 180 days**, and because the bucket is versioned, noncurrent versions are reaped **30 days** after they become noncurrent (so versioning does not retain PII behind delete markers forever). These day counts are an adjudicated default - adjust them in `infra/modules/inbound_mail/main.tf` (`aws_s3_bucket_lifecycle_configuration.inbound`) BEFORE the `apply` if a different retention is wanted.

**What's in Terraform vs. by hand.** The SES identity/DKIM/config-set, SNS topics, SQS queue+DLQ, the inbound S3 bucket + its `ses.amazonaws.com` PutObject policy + its retention lifecycle, and the receipt rules are Terraform. The configuration set's name is published to the `EMAIL_CONFIGURATION_SET` SSM param (params module, from `module.inbound_mail.config_set_name`); the outbound adapter attaches it to every SendEmail so SES fans bounce/complaint/delivery events out to the mail-events topic - so the `apply` that creates the config set also wires the param the send path reads. **DNS is NOT** - the `housingchoice.org` zone lives at **Namecheap**, so the DKIM/MX/SPF/verification records below are entered by hand (same deliberate deviation as Custom domain & TLS). The `mail_domain_phase` local in `infra/envs/<env>/main.tf` staircases the rollout exactly like `custom_domain_phase`.

### Namecheap record inventory

WARNING: **Namecheap auto-appends the base domain.** Strip the trailing `.housingchoice.org` (and any trailing dot) from the Host before pasting - e.g. ACM/SES gives `_amazonses.mail.dev.housingchoice.org` -> Namecheap **Host = `_amazonses.mail.dev`**. Exact values print at the end of `npm run apply`, or read them ad-hoc: `$env:AWS_PROFILE='housingchoice'; terraform -chdir=infra/envs/<env> output dns_records` (a single list of every record below).

| Env | Type | Host (Namecheap) | Value | Notes |
|---|---|---|---|---|
| dev | TXT | `_amazonses.mail.dev` | SES verification token | Domain verification (`output verification_record`). Enables send + receive. |
| dev | CNAME (x3) | `<token>._domainkey.mail.dev` | `<token>.dkim.amazonses.com` | DKIM, one row per token (`output dkim_records`). **Leave forever.** |
| dev | MX | `mail.dev` | `10 inbound-smtp.us-east-1.amazonaws.com` | Inbound routing to SES (`output mx_record`). Without it no mail arrives. |
| dev | TXT | `mail.dev` | `v=spf1 include:amazonses.com ~all` | SPF (`output spf_record`) - authorizes SES to send for the domain. |
| prod | TXT | `_amazonses.mail` | SES verification token | as dev, on `mail.housingchoice.org`. |
| prod | CNAME (x3) | `<token>._domainkey.mail` | `<token>.dkim.amazonses.com` | DKIM x3. Leave forever. |
| prod | MX | `mail` | `10 inbound-smtp.us-east-1.amazonaws.com` | Inbound routing. |
| prod | TXT | `mail` | `v=spf1 include:amazonses.com ~all` | SPF. |

### Staged cutover (per stack)

1. **Phase 0 -> create identity + plumbing, emit records.** `mail_domain_phase = 0` (default). `npm run plan -- <env>` -> `npm run apply -- <env>` creates the SES domain identity, DKIM, configuration set, SNS topics, SQS queue+DLQ, and the inbound S3 bucket - and emits the DNS records. Nothing blocks (unlike ACM, classic SES has no verification-wait resource). Enter ALL records above in Namecheap, then wait for the domain to verify + DKIM to enable: `aws ses get-identity-verification-attributes --identities mail.dev.housingchoice.org --region us-east-1 --profile housingchoice --query 'VerificationAttributes.*.VerificationStatus'` (expect `Success`).
2. **Phase 1 -> turn on inbound + activate the shared rule set.** Set `mail_domain_phase = 1`, plan + apply. This creates THIS env's receipt rule (routes the domain's inbound mail to S3 + the mail-inbound topic). On the **managing env (dev)** it ALSO creates the shared receipt rule set `hc-inbound-mail` and ACTIVATES it.
   - WARNING - **account-singleton active set.** `aws ses set-active-receipt-rule-set` is account-scoped: SES allows exactly ONE active receipt rule set per account+region, and dev+prod SHARE the account (938565869261). dev owns it (`manage_mail_rule_set = true`); the active set carries BOTH envs' rules. **Order: apply DEV at phase 1 FIRST** (creates + activates the set), **THEN apply PROD at phase 1** (prod's rule references the set by name and requires it to already exist). **Never `terraform destroy` the managing env (dev) without first migrating set ownership** - tearing down dev DEACTIVATES the shared set and stops PROD inbound. Coordinate any dev teardown with prod.
3. **SES production-access request.** A new SES account is in the sandbox (send only to verified addresses, low quota). Request production access for the account/region before real outbound - see [`ses-sandbox-exit`](docs/issues/ses-sandbox-exit.md). Until granted, outbound reaches verified addresses only; inbound is unaffected.
4. **`npm install` on deploy.** Email adds app-workspace runtime deps (`@aws-sdk/client-sesv2`, `nodemailer`, `mailparser`, `sanitize-html`, `email-reply-parser`); the `fake-twilio` workspace gains `@aws-sdk/client-s3` when slice B4 lands. The arm64 `npm ci` rides the deploy build (same pattern as the MMS `sharp` deps).
5. **Flip `EMAIL_SENDING_ENABLED`.** The kill-switch defaults OFF on deployed stacks (the `SMS_SENDING_ENABLED` pattern) - email is dormant until then. Once 1-4 are done (domain verified, inbound live, production access granted), set `EMAIL_SENDING_ENABLED=true` in `.env.<env>` (template-first: `.env.<env>.example`) and `npm run secrets:push -- <env>`; the next deploy hydrates it. The 5 SES params (`EMAIL_SENDER_DOMAIN`, `EMAIL_FROM_ADDRESS`, `EMAIL_CONFIGURATION_SET`, `INBOUND_MAIL_BUCKET`, `INBOUND_MAIL_QUEUE_URL`) are Terraform-owned (params module) and hydrate automatically - do NOT put them in `.env.<env>`.
6. **Dev reseed (seed emails).** Reseed a LOCAL / e2e stack to pick up the seeded email personas (`npm run e2e:reseed`, or `db:seed`) - `db:seed` targets DynamoDB Local only, so deployed dev accrues email data naturally rather than from a reseed.

### Rollback

- **Before phase 1:** nothing routes mail yet - drop `mail_domain_phase` back to 0 and apply. The DNS records can stay in Namecheap (harmless, and reused when you re-advance).
- **After phase 1:** set `mail_domain_phase = 0` and apply to remove this env's receipt rule (stops inbound routing for the env). On the managing env this also deactivates + removes the shared set - which stops PROD inbound too, so coordinate (see the phase-1 warning). `EMAIL_SENDING_ENABLED=false` + `secrets:push` + redeploy is the instant outbound kill-switch, independent of any apply.

## Security / hardening

Tracked items (gaps, deferrals, one-time actions) now live in the issue registry —
`npm run issues` or `rg "^type: security" docs/issues/` — so this runbook stays
operational. Migrated 2026-06-18: [`iam-user-mfa`](docs/issues/iam-user-mfa.md),
[`ses-sandbox-exit`](docs/issues/ses-sandbox-exit.md),
[`cloudwatch-agent-disk-metric`](docs/issues/cloudwatch-agent-disk-metric.md),
[`messaging-delivery-alarms`](docs/issues/messaging-delivery-alarms.md),
[`api-rate-limiting`](docs/issues/api-rate-limiting.md) (resolved 2026-07-02 — see below),
[`sns-prod-alert-confirmation`](docs/issues/sns-prod-alert-confirmation.md). Already
addressed (no longer tracked): orphan boot-log lines (correlation fix shipped
2026-06-12 — any orphan hit is now a real bug); custom domain + ACM (shipped in Phase 1
Change Order 3 — see [Custom domain & TLS](#custom-domain--tls)); OTLP exporter wiring
(shipped 2026-07-02 — see
[OTLP wiring — apply and verify](#otlp-wiring--apply-and-verify) above).

### Per-user rate limits on the send/call-cost routes (2026-07-02)

The four authenticated routes that spend real money / touch real phones carry a
**per-user sliding-window rate limit** (`app/src/middleware/rateLimit.ts`,
`createUserRateLimit` — keyed by session userId, NOT IP, since staff share office
IPs). Beyond a ceiling the request gets **HTTP 429 `{ error: 'rate_limited' }`
with a `Retry-After` header** (seconds until the window admits again) and a
correlated WARN (IDs/counts only, no PII); the dashboard shows an inline
"sending too fast" message. A 429'd request performs NO side effect (no SMS, no
call, no state touched).

| Route | Default (per user) | Env override |
|---|---|---|
| Manual 1:1 send — `POST /api/conversations/:id/messages` | 30 / min | `RATE_LIMIT_MANUAL_SEND_PER_MIN` |
| Broadcast send — `POST /api/broadcasts/:id/send` | 5 / min | `RATE_LIMIT_BROADCAST_SEND_PER_MIN` |
| Call originate — `POST /api/contacts/:id/call` | 10 / min | `RATE_LIMIT_ORIGINATE_PER_MIN` |
| Cell verify-start — `POST /api/users/me/cell/verify-start` | 3 / 3 min | `RATE_LIMIT_VERIFY_START_MAX` + `RATE_LIMIT_VERIFY_START_WINDOW_MS` |

Tuning: code defaults apply when unset; to change a deployed stack, set the var
in `.env.<env>` (template-first: `.env.<env>.example`) and `npm run
secrets:push -- <env>` (next deploy hydrates it). A bad value (non-positive /
non-integer) refuses boot — fail-fast, same as `PUBLIC_RATE_LIMIT_MAX`. The
limiter is in-memory single-process (like the public per-IP fence and the SSE
bus); multi-instance scaling would need a shared store. The hermetic e2e suite
raises all four ceilings to 100000 (`scripts/e2e-session.mjs`) because every
spec shares the one seeded dev-login user; an externally-set value still wins
there. `npm run dev` keeps production defaults.

**Access-key rotation (operational procedure).** Rotate the `housingchoice` IAM user's
access key every ~90 days: `aws iam create-access-key` → update the profile →
`aws iam delete-access-key` for the old key. Not automated; calendar it.

## State & bootstrap

- **Two Terraform state buckets**, one per stack: `hc-dev-tfstate-938565869261` and
  `hc-prod-tfstate-938565869261` (versioned, encrypted, public-blocked, S3-native lockfile
  locking). Separate buckets = per-stack IAM isolation; a prod-scoped principal never needs read
  on dev state or vice versa.
- **`npm run bootstrap`** creates/enforces those two buckets and is **idempotent** — safe to
  re-run any time; it converges settings rather than failing on "already exists".
  `npm run bootstrap:check` is the read-only audit of the same invariants. These buckets are the
  ONLY infrastructure not managed by Terraform (backend chicken-and-egg).
- **Account guard:** the operator machine's *default* AWS credentials belong to an unrelated
  account, so every script that can touch AWS (`bootstrap`, `plan`, `apply`, `drift`,
  `deploy:*`) first calls `assertHousingChoiceAccount()` (`scripts/lib/hcAws.mjs`): it resolves
  the named profile `housingchoice` (override: `HC_AWS_PROFILE`) via STS and **hard-fails unless
  the account is 938565869261**. `AWS_PROFILE=housingchoice` is also forced into every child
  process (terraform, aws CLI, docker login), so the default chain is never consulted. Belt,
  braces, and the profile is additionally pinned inside the Terraform backend/provider HCL.

## Cleaning up a merged feature (branches, worktrees & docs)

When a feature branch has landed on `main`, retire it with the steps below. Two rules make
this safe and keep the repo honest: **(1) verify it's actually merged BEFORE deleting
anything**, and **(2) reconcile the docs in the same pass** so nothing lingers claiming
"in-flight / not merged / pending". The shared checkout is worked by concurrent agents, so
every step is written to avoid stepping on parallel work (see Concurrency guardrails below).

### 1. Verify it's actually merged (never delete on a claim alone)

```powershell
$b = "feat/<branch>"
git merge-base --is-ancestor (git rev-parse $b) main   # exit 0 = fully merged
git rev-list --count main..$b                            # must be 0 (no commits missing from main)
git log --oneline main..$b                               # sanity: should be empty
```

If `--is-ancestor` is non-zero **or** the count is > 0, the branch has work not in `main`.
**STOP — do not delete it.** Report the unmerged commits. Only proceed to a force-delete if
the owner explicitly confirms the branch is abandoned (see "Abandoned branches" below).

### 2. Remove the worktree, branch, and leftover directory

```powershell
git worktree remove "W:\tmp\<worktree-dir>" --force   # --force: build artifacts (node_modules/dist) make it "not empty"
git worktree prune
git branch -d $b                                       # SAFE delete — git refuses if not merged (a feature, not a bug)
Remove-Item -LiteralPath "W:\tmp\<worktree-dir>" -Recurse -Force   # clean the leftover dir
```

- `git worktree remove` usually errors `Directory not empty` on Windows (leftover
  `node_modules`/`dist`); that's expected — `prune` + the `Remove-Item` finish the job.
- If `Remove-Item` fails with **"being used by another process"**, a dev stack (esbuild/vite/
  node) is still holding the dir as its working directory. The git state is already correct
  (worktree deregistered, branch gone) — the empty dir is harmless. Retry later; **do NOT
  kill processes** that may belong to a concurrent agent's running stack.

### 3. Reconcile the docs & tracking notes (flip to historical)

- **Find the feature's design/plan docs:** `docs/superpowers/{specs,plans}/*<feature>*`.
- **Stamp completed + merged design/plan docs as HISTORICAL** — prepend this idempotent
  banner to the very top (guard on the `<!-- HISTORICAL-RECORD -->` marker so re-runs skip),
  and **leave the body untouched** (it's the point-in-time record):

  ```markdown
  <!-- HISTORICAL-RECORD -->
  > ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (YYYY-MM-DD).** This document
  > describes how this work was *designed/planned at the time of writing*. The work shipped to
  > `main` and its feature branch + worktree were deleted. **This file is NOT current
  > documentation, and the live code may have drifted from it. Do not treat it as authoritative
  > guidance on how the system should be built or behaves today.** For current truth read the
  > code and the living docs (`RUNBOOK.md`, `e2e/README.md`, `documentation/GLOSSARY.md`).
  ```

  **Never stamp** a doc that self-declares "LIVING DOC", or work that is still in-flight
  (another worktree/branch open for it). If a merged doc is superseded by a living doc, point
  the banner at that living doc as the source of truth.
- **Update living status docs** that referenced the branch as in-flight → mark merged: e.g.
  a milestone ledger, a "still unbuilt" list, a design's `**Status:**` header.
- **If the feature resolved a tracked issue** (`docs/issues/`), set it `status: resolved` +
  add a `**Resolution.**` note, and run `npm run issues`.
- **Do NOT rewrite historical execution-plan bodies** — dated plans are records; the banner is
  the only touch they get.

### 4. Commit the cleanup (concurrency-safe)

- Stage **only your files, explicitly by path** (`git add <paths>`), then review
  `git diff --cached` — it must contain ONLY your banner/status changes. The working tree is
  shared; never sweep another agent's uncommitted work into your commit.
- Commit as its own focused commit on `main` (e.g. `docs(superpowers): stamp merged <feature>
  design as historical`). Do NOT switch branches or move `main`'s HEAD to do this.

### Abandoned (unmerged) branches

If a branch is confirmed abandoned (a duplicate effort, superseded work), and the owner has
said so explicitly: record the tip SHA first (recoverable from reflog), then force-delete.

```powershell
git rev-parse $b                # note this SHA — reflog recovery if ever needed
git worktree remove "W:\tmp\<worktree-dir>" --force
git worktree prune
git branch -D $b                # -D (force) because -d refuses unmerged work
```

There are no docs to flip to historical for abandoned work (nothing shipped); if a design/plan
doc exists, leave it unstamped or delete it per the owner's call.

### Concurrency guardrails (why the steps look paranoid)

The checkout at the repo root is shared with parallel agents committing to `main` as
"Cameron Abt". So: never move `main`'s HEAD / never switch branches in the shared checkout;
stage only your own files and verify `git diff --cached` before committing; and never delete or
kill a directory/process that might belong to another agent's live work. Feature work happens
in worktrees under `W:\tmp` for exactly this reason.
