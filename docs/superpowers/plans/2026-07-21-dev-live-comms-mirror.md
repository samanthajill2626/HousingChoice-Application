# Plan: live-mode `npm run dev` mirrors deployed dev for outbound comms

Date: 2026-07-21
Spec: docs/superpowers/specs/2026-07-21-dev-live-comms-mirror-design.md
Base: main @66a4c7ed   Branch: feat/dev-live-comms   Worktree: w:/tmp/dev-live-comms

Zero-context assumption: read the spec first. ASCII-only on every touched line
(profile hard rule). Use the Edit tool, never PowerShell rewrites. This is
dev-tooling + a boot-log + docs + a unit test; there is no product-behavior or
UI change to e2e.

## Orientation (read before editing)

- `scripts/lib/devMode.mjs` - pure `resolveDevEnv({local, processEnv, fileEnv,
  localEndpoint})`. `get(key)= processEnv[key] ?? overlay[key]`. Two branches:
  `mode==='local'` and the `else` LIVE branch (sets TABLE_PREFIX, AWS_PROFILE,
  guards hc-prod-). Unit-tested by `app/test/devMode.test.ts`.
- `scripts/dev.mjs` - the dev loop. Header ~L1-56. `NODE_ENV=development` forced
  ~L178. `--mock` block ~L187-233 (FORCES `MESSAGING_DRIVER='twilio'` +
  `TWILIO_API_BASE_URL=...:8889`; sets `mockDefaults` only-if-absent). Live-mode
  console.logs ~L305-346, incl. a `driver` line ~L309-325 and the account-guard
  block that computes `MEDIA_BUCKET = hc-dev-media-${identity.Account}` ~L330-342.
  `runTsx`/`runCommand` spawn with `stdio:'inherit'` (no output capture).
- `scripts/lib/hcAws.mjs` - `HC_REGION`, `HC_PROFILE`, `hcCredentials()`,
  `assertHousingChoiceAccount()` (STS). No SSM helper.
- `scripts/secrets.mjs` - SSM via the `aws` CLI: `capture('aws', [...cliArgs,
  '--region', HC_REGION, '--output','json'])`, parses `.Parameters`. Mirror this
  idiom (do NOT add an SDK dep).
- `scripts/lib/secretsCore.mjs` `MANAGED_BY_OTHERS` - the Terraform-owned denylist;
  `EMAIL_SENDER_DOMAIN`/`EMAIL_FROM_ADDRESS`/`EMAIL_CONFIGURATION_SET` are on it.
- `app/src/lib/config.ts` - resolved config exposes `messagingDriver`,
  `emailDriver`, `smsSendingEnabled`, `emailSendingEnabled`. `EMAIL_DRIVER=ses`
  refuses to boot without `EMAIL_SENDER_DOMAIN`+`EMAIL_FROM_ADDRESS` (~L782-790).
- `app/src/index.ts` (app boot) and `app/src/worker.ts` (worker boot) - find the
  existing startup log line ("app listening" / "worker ready"/boot) to extend.

## Tasks (TDD where a unit boundary exists)

### T1 - devMode: live branch defaults twilio + ses (RED first)
1. In `app/test/devMode.test.ts`, ADD cases:
   - live mode (`local:false`, no DYNAMODB_ENDPOINT): overlay contains
     `MESSAGING_DRIVER: 'twilio'` and `EMAIL_DRIVER: 'ses'`.
   - explicit precedence: `processEnv.MESSAGING_DRIVER='console'` (and via
     `fileEnv.EMAIL_DRIVER='console'`) -> overlay does NOT override them (get()
     precedence; the overlay must not set a key already provided).
   - local mode (`local:true`): overlay sets NEITHER driver (stays console).
   Run `npm test` for the file; confirm the new live/driver assertions FAIL.
2. In `scripts/lib/devMode.mjs` LIVE (`else`) branch, after the AWS_PROFILE line
   and before the hc-prod- guard, add (mirroring the existing only-if-absent style):
   ```js
   // Live mode mirrors deployed dev for outbound comms: real Twilio + SES.
   // Creds/identity are hydrated by dev.mjs (Twilio from .env.dev; SES identity
   // from SSM). --mock overrides both downstream (fake host / console). --local
   // (hermetic) never reaches this branch, so it stays on the console default.
   // Explicit env/.env still wins via get().
   if (get('MESSAGING_DRIVER') === undefined) overlay.MESSAGING_DRIVER = 'twilio';
   if (get('EMAIL_DRIVER') === undefined) overlay.EMAIL_DRIVER = 'ses';
   ```
   Re-run the file; GREEN.

### T2 - dev.mjs: fetch SES identity from SSM in live mode (only-if-absent)
Gate: live mode AND not `--mock` (mock forces console email, needs no identity).
Placement: inside the existing account-guard `try` block (~L330), right after the
`MEDIA_BUCKET` computation, where `identity` is in scope.
1. Add a tiny capture helper near `runTsx` (or inline) using
   `execFileSync('aws', args, {encoding:'utf8'})` from `node:child_process`
   (spawnSync also fine). Do NOT use `stdio:'inherit'` - we need stdout.
2. Fetch the three params in one call:
   ```
   aws ssm get-parameters
     --names /hc/dev/app/EMAIL_SENDER_DOMAIN /hc/dev/app/EMAIL_FROM_ADDRESS /hc/dev/app/EMAIL_CONFIGURATION_SET
     --profile <childEnv.AWS_PROFILE>  --region us-east-1  --output json
   ```
   Parse `.Parameters[]` -> map basename (last path segment) to `.Value`. For each
   of the three, `if (!childEnv[KEY]) childEnv[KEY] = value` (only-if-absent, so an
   operator `.env` still wins). Params absent from SSM appear under
   `.InvalidParameters` -> simply not injected.
3. Wrap the whole fetch in try/catch: on ANY error (aws CLI missing, non-zero
   exit, parse failure) `console.warn('dev - could not hydrate SES identity from
   SSM (email sends will fast-fail): <msg>')` and CONTINUE. Never `process.exit`
   here - config's ses boot-check is the intended fast-fail with a precise message.
4. Log success concisely, no secrets:
   `console.log('dev - live mode email identity: <EMAIL_FROM_ADDRESS> (SES)')`
   only when the from-address was injected.

### T3 - dev.mjs: `--mock` stubs email too
In the `--mock` block (~L193, alongside the FORCED `MESSAGING_DRIVER='twilio'` /
`TWILIO_API_BASE_URL`), add a FORCED `childEnv.EMAIL_DRIVER = 'console'` with a
one-line comment ("mock ALL comms: fake Twilio host + console email"). This
overrides the resolveDevEnv `ses` default for mock runs.

### T4 - dev.mjs: honest logs + header
1. Live-mode messaging log (~L309-325): also compute + print the email driver.
   e.g. add a line `email: ses (REAL SES sends)` / `console (simulated)` parallel
   to the existing `messaging:` line, reading the RESOLVED `childEnv.EMAIL_DRIVER`
   (post-resolveDevEnv, post-mock). Keep the existing MESSAGING_DRIVER line but
   fix its now-stale hint text (live default is twilio, not console).
2. Header (~L27-33) + the inline "console messaging driver" comment (~L174):
   reword to match the spec's behavior matrix - live = real twilio + ses,
   `--local` = console, `--mock` = fake twilio + console email. Remove the false
   "console messaging driver" invariant claim.

### T5 - boot-log guardrail (app + worker)
In `app/src/index.ts` and `app/src/worker.ts`, at the existing boot log line, add
(or extend) ONE structured log with the resolved comms config:
`{ messagingDriver, emailDriver, smsSendingEnabled, emailSendingEnabled }` from
the loaded config. IDs/flags only - never creds/PII. Level info. This is the line
that makes a future "why didn't it send" answerable immediately.
(Typecheck covers these TS edits.)

### T6 - RUNBOOK dev-modes section
Add a short subsection to `RUNBOOK.md` (operational; NOT an issue): the spec's
behavior matrix (live / --mock / --local / --local --mock; DynamoDB, SMS, email
real vs stub), the "explicit env/.env still wins" note, and a CAVEAT: running
live `npm run dev` puts a SECOND worker (your box) on the shared hc-dev scheduled
queue alongside the DEPLOYED worker; both now use twilio so the outcome is
deterministic, but your laptop may be the sender - use `--mock` or `--local` to
avoid emitting from local. Keep ASCII-only.

## Gates (bare, from the worktree; capture real exit codes)
- `npm run typecheck`  (REQUIRED separate gate)
- `npm test`
- Known flakes to honor if they surface: tour-reminders-panel-e2e-flake,
  conversationdetail-members-mock-suite-flake (both e2e; this change runs unit +
  typecheck only). Re-run before blaming the change.

## Branch hygiene
Merge latest `main` into the branch before declaring done; re-run typecheck +
test green on the updated base. Do NOT merge to main (human gate).

## Owed post-merge ops
None expected (no infra, no deps, no migrations). The SSM params already exist on
dev; nothing to provision.
