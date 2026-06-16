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
`secrets:push`, shipped a missing key" footgun (it caught a missing `FOUNDER_CELL` that had silently
disabled founder call-triage on dev). Bypass with `--skip-secrets` only when you know SSM is already
correct — e.g. `.env.<env>` isn't on this machine. To clear a real drift, just
`npm run secrets:push -- <env>` then re-run the deploy.

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

### Secrets

Operator-managed secrets (Twilio etc.) live in the gitignored `.env.dev` / `.env.prod` at the repo
root — templates: `.env.dev.example` / `.env.prod.example` (copy, rename, fill in) — and reach AWS
by script only. Nobody hand-runs `aws ssm put-parameter`:

```powershell
npm run secrets:sync -- dev       # mirror .env.dev to .env.dev.example (comments/structure), values kept
npm run secrets:push -- dev       # .env.dev -> SecureString /hc/dev/app/<KEY> (account-guarded)
npm run secrets:check -- prod     # read-only diff: exit 0 in sync, 2 drift, 1 error
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
- **Voice URLs on the number** stay configured on the number itself (calls are not handled by the
  app yet; the number-level voice config is what answers).

The env keys that feed the app live in the gitignored `.env.<env>` and reach Parameter Store via
`npm run secrets:push -- <env>` (then a deploy to go live — see [Secrets](#secrets)):
`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` (REST), `TWILIO_AUTH_TOKEN`
(webhook signature validation ONLY), `TWILIO_MESSAGING_SERVICE_SID`, and `OUR_PHONE_NUMBERS`.

**`OUR_PHONE_NUMBERS` must list EVERY number we own** (comma-separated E.164): it is echo/author
defense #1 — an inbound webhook whose From matches is our own outbound projected back. A missing
number degrades that defense to SID-dedupe alone; in production with the twilio driver an EMPTY
list refuses to boot.

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
— hermetic, with the app's messaging redirected to the local mock — open the same
**`http://localhost:8889/`**.) Pick a persona from the roster (grouped Landlord / Tenant / PM, each
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
`requireInteraction` for `missed_call`/`pre_ring` — see [app/src/adapters/webPush.ts](app/src/adapters/webPush.ts)
and [dashboard/public/sw.js](dashboard/public/sw.js)), but the final gate is a per-device setting the
founder must enable. Run this once per device during onboarding.

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

10 alarms (5 per env), all notifying SNS `hc-<env>-alerts` (email) on both ALARM and OK.

> **SNS subscription note:** email subscriptions need a one-time confirmation click.
> `hc-dev-alerts` is confirmed; **`hc-prod-alerts` is still `PendingConfirmation`** as of
> 2026-06-11 — until the "AWS Notification - Subscription Confirmation" email is clicked, prod
> alarms fire into the void. Re-send if lost: `aws sns subscribe --topic-arn
> arn:aws:sns:us-east-1:938565869261:hc-prod-alerts --protocol email --notification-endpoint
> <email> --profile housingchoice`.

| Alarm (dev / prod) | Fires when | What it means | First response |
|---|---|---|---|
| `hc-dev-orphan-logs` / `hc-prod-orphan-logs` | `OrphanLogs` sum > 0 over 5 min | A code path logged outside the correlation context (binding guideline #4 says this must be zero) | Run Insights query (c) above to find the offending lines. If they are only the `app listening` / `worker ready` boot lines, this is the known deploy-time artifact — it clears at the next 5-min evaluation that sees log traffic (observed: ~6–15 min; with zero traffic it can linger until the next request, so hit `/health` once to hurry it). Fix tracked in the backlog below. Anything else: find the code path and fix the gate (route the log through the correlation context / `jobs` envelope). |
| `hc-dev-error-logs` / `hc-prod-error-logs` | `ErrorLogs` sum >= 5 over 5 min | App/worker emitting error/fatal (pino level >= 50) at volume | Insights query (b) for the stacks; every error line carries a `correlationId` — pivot to query (a)/(d) for the full story. Roll back (`-- --tag <previous>`) if a deploy caused it. |
| `hc-dev-status-check-failed` / `hc-prod-status-check-failed` | EC2 `StatusCheckFailed` >= 1 (missing data = breaching) | Instance or underlying AWS hardware/network problem — also fires if the instance stops reporting entirely | Check SSM: `aws ssm describe-instance-information --profile housingchoice --region us-east-1`. If unreachable, reboot **via CLI** (console stays read-only): `aws ec2 reboot-instances --instance-ids <id> --profile housingchoice --region us-east-1`. Containers restart on boot (`restart: unless-stopped`). If the instance is truly dead, `npm run plan/apply -- <env>` will recreate it; then re-deploy the current `DEPLOYED_TAG`. |
| `hc-dev-jobs-dlq-depth` / `hc-prod-jobs-dlq-depth` | `ApproximateNumberOfMessagesVisible` > 0 on `hc-<env>-jobs-dlq` | A job envelope failed all 5 worker dispatch attempts and was dead-lettered — reminders/follow-ups are revenue-critical (doc §9 "Job/DLQ depth") | Worker ERROR logs first: Insights query (b) — the `job failed` lines carry `jobName`, stack, and the originating request's correlation IDs. Peek the DLQ to see the stuck envelopes, fix the handler/data (deploy), then redrive — exact one-liners in [Jobs](#jobs-async-delivery-path). The alarm clears once the DLQ drains. |
| `hc-dev-disk-used` / `hc-prod-disk-used` | `disk_used_percent` (root) > 80% | 10 GB root volume filling — usually Docker images/layers | Inspect via SSM Run Command (no SSH): `docker system df`, then `docker image prune -af` (safe: the running containers' images are in use). **Caveat:** this metric comes from the CloudWatch agent, which is NOT installed yet — the alarm currently sees no data and `notBreaching` keeps it quietly OK. It cannot actually fire until the agent ships (backlog below). The deploy's prune-on-success keeps disk in check meanwhile (post-deploy: 26% used). |

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
3. **Phase 2 → flip canonical URL.** Set `custom_domain_phase = 2`, plan + apply (repoints `PUBLIC_BASE_URL` to the custom host), then **`npm run deploy:<env>`** so the app re-hydrates `.env` with the new `PUBLIC_BASE_URL`. In the same window, re-point Google OAuth redirect URIs and Twilio webhooks to the new host. (Prod holds phase 2 until the M1.11 ported-number cutover.)

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

## Security / hardening backlog

Tracked here so nothing silently becomes permanent:

| Item | Status / decision | Notes |
|---|---|---|
| IAM-user MFA | **Deferred by decision 2026-06-11** | Root has MFA; the `housingchoice` IAM user does not. Mitigations in place: account-ID guard in every mutating script, named profile only (default chain never used), console read-only by policy. Revisit when the team is > 1. |
| Access-key rotation | Cadence: **rotate every 90 days** | `aws iam create-access-key` → update profile → `aws iam delete-access-key` for the old one. No automation yet; calendar it. |
| SES sandbox exit | Phase 1 | Both SES identities are sandboxed (verified recipients only). Production-access request goes in when Phase 1 needs real outbound mail. |
| CloudWatch agent (disk metric) | **Not installed** — disk alarms can't fire (no data → `notBreaching` → OK) | Install via user-data or SSM Distributor; config must emit `CWAgent disk_used_percent` with dimensions `InstanceId, path="/", fstype="xfs"` to match the alarm. Until then disk is only protected by deploy-time pruning. |
| OTLP exporter wiring | **OTel SDK currently runs with no exporter in BOTH envs** | Reality check 2026-06-11: neither `/hc/dev/app` nor `/hc/prod/app` sets `OTEL_SDK_DISABLED`, so the SDK starts and instruments http/express in both envs — but `app/src/lib/otel.ts` configures no `traceExporter`/`metricReader`, so traces/metrics are exported **nowhere** (locally `OTEL_SDK_DISABLED=true` makes it a true no-op). Wire OTLP → CloudWatch Application Signals via the existing `OTEL_EXPORTER_OTLP_ENDPOINT` seam. |
| Orphan boot-log lines | **Fixed 2026-06-12** | Lifecycle lines (boot/shutdown/process-level errors) now run inside a per-process `bootId` correlation context, so container starts no longer trip `hc-<env>-orphan-logs`. Any orphan hit is now a real bug. (Images tagged before 2026-06-12 still carry the old behavior.) |
| Custom domain + ACM | **Addressed in Phase 1 (Change Order 3)** | Per-stack ACM cert (us-east-1, DNS-validated) + CloudFront alias for `app` / `dev.app` on `housingchoice.org`, staged via the `custom_domain_phase` local. DNS hand-maintained at Namecheap (zone not in Route 53 — migration parked, doc §14). See [Custom domain & TLS](#custom-domain--tls). |
| SNS prod confirmation | **Action needed once:** click the confirmation email for `hc-prod-alerts` | See the Alarms section note. |
| Messaging delivery alarms | M1.1 gap | Metric filter + alarm for webhook signature rejections and for undelivered-rate / 429-30022 throttling errors (the doc-§9 alarm table) — today only 30007 carrier filtering and breaker trips reach ERROR/the error-logs alarm. |
| /api rate limiting | Before M1.3 auth lands | Express rate limit on the /api manual-send route — it is origin-secret-protected only until OAuth/RBAC (M1.3), so a leaked origin secret currently means unthrottled sends. |

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
