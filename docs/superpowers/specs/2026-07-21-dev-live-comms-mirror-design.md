<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-03).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Design: live-mode `npm run dev` mirrors deployed dev for outbound comms

Date: 2026-07-21
Status: approved (decisions locked with Cameron in-session)

## Problem (verified against cloud dev)

`npm run dev` with no flags = LIVE mode: the local app + worker run against the
REAL `hc-dev` DynamoDB (a true mirror of deployed dev for data). But the dev loop
forces `NODE_ENV=development` as a local invariant, and `.env.dev` sets no
`MESSAGING_DRIVER` / `EMAIL_DRIVER`, so config resolves BOTH outbound drivers to
`console` (the `NODE_ENV !== 'production'` default). Outbound comms are therefore
no-ops locally even though every backing store is real.

Because the local worker shares the `hc-dev` tables with the DEPLOYED dev worker,
both poll the same `tourReminders` ladder. The claim is atomic (claimSend stamps
`sentAt` before sending), so exactly one worker wins - and when the LOCAL worker
wins, it "sends" via the console driver: the reminder row is stamped `sentAt`
(the panel shows "Sent") but no real SMS leaves Twilio, and the persisted message
carries a synthetic `SMconsole-...` SID.

Incident evidence: tour `tour-75a28b1a` (landlord_led), confirmation rung
`reminder-9cf160e2` `sentAt 2026-07-21T20:01:27.040Z`, `provider_sid
SMconsole-...`, message persisted to the tenant 1:1 `conv-c6a12db8`. The deployed
`/hc/dev/worker` log had ZERO reminder lines - it lost the claim to the local box.

`scripts/dev.mjs` also self-contradicts: the header (~line 31) advertises live =
"real ... Twilio", while an inline comment (~line 174) lists "console messaging
driver" as a local-dev invariant. The two were never reconciled.

## Target model (Cameron's words)

- `npm run dev` (no `--mock`)  -> ALL external infra REAL, including outbound SMS
  (real Twilio) and email (real SES).
- `--mock`  -> mock ALL comms: SMS via the fake-twilio host (as today) AND email
  via the console driver (new - today `--mock` only handles Twilio).
- `--local` (hermetic)  -> unchanged: console for both (offline, no AWS).

## Design decisions (locked)

1. The live override lives in the DEV LOOP, not in `config.ts`. `config.ts` keeps
   `console` as the bare-process safe default (tests, ad-hoc scripts). Only the
   live dev loop opts into the real drivers.

2. Twilio creds are operator secrets already in `.env.dev` (loaded in live mode),
   so SMS "just works" once the driver is `twilio`.

3. The SES sender identity (`EMAIL_SENDER_DOMAIN`, `EMAIL_FROM_ADDRESS`,
   `EMAIL_CONFIGURATION_SET`) is Terraform-owned and on the `MANAGED_BY_OTHERS`
   denylist (scripts/lib/secretsCore.mjs) - it MUST NEVER appear in `.env.dev`.
   The deployed box reads it from SSM. Live-local dev therefore fetches it from
   SSM at boot (same pattern `MEDIA_BUCKET` uses: reconstruct a Terraform-owned
   value in the live branch, after the account guard), and injects it
   only-if-absent.

4. SSM fetch uses the `aws` CLI (mirroring `scripts/secrets.mjs`, which shells out
   via `capture('aws', ...)`), NOT the AWS SDK. Rationale: `@aws-sdk/client-ssm`
   is NOT an installed dependency; the established scripts idiom for SSM is the
   CLI; this avoids a new dependency + its lockfile/arm64 spike. The CLI already
   assumed present in live mode (the account guard + `.env.dev` secrets path).

5. FAIL FAST on missing identity (Cameron's call): live defaults
   `EMAIL_DRIVER=ses`; if the SSM fetch yields no identity (params absent, or the
   `aws` CLI errors), do NOT inject - config's existing "EMAIL_DRIVER=ses requires
   EMAIL_SENDER_DOMAIN, EMAIL_FROM_ADDRESS ... Refusing to start" boot error fires.
   That is the intended loud failure. The SSM fetch itself is best-effort and must
   NOT crash `dev.mjs` (a fetch error warns and continues; config then fast-fails).

6. Guardrail against recurrence: the app AND worker log the resolved messaging +
   email drivers and their sending-enabled flags once at boot, so "why did nothing
   send" is answerable from the first log line.

## Non-goals / DO NOT

- Do NOT change `config.ts` driver defaults.
- Do NOT put the `EMAIL_*` identity in `.env.dev`/`.env.prod` (denylist).
- Do NOT run `secrets:push` / terraform / any deploy / real `.env.*` edits
  (Cameron owns infra ops).
- Do NOT add `@aws-sdk/client-ssm` (use the CLI).

## Behavior matrix (post-change)

| invocation                    | DynamoDB      | SMS driver        | email driver |
|-------------------------------|---------------|-------------------|--------------|
| `npm run dev`                 | real hc-dev   | twilio (REAL)     | ses (REAL)   |
| `npm run dev -- --mock`       | real hc-dev   | twilio -> fake    | console      |
| `npm run dev -- --local`      | DynamoDB Local| console           | console      |
| `npm run dev -- --local --mock`| DynamoDB Local| twilio -> fake   | console      |

Explicit env / `.env` values still win over every default above (unchanged
`get()` precedence in resolveDevEnv).

## Test / verify

- Unit: extend `app/test/devMode.test.ts` - live branch now sets
  `MESSAGING_DRIVER=twilio` + `EMAIL_DRIVER=ses`; local branch stays console;
  explicit env/.env still wins; `hc-prod-` guard intact.
- Gates: `npm run typecheck` + `npm test` green. (Dev-tooling + a boot-log line;
  e2e not required by the change, but merge-sync main first per branch hygiene.)
- Manual (Cameron, post-merge, optional): `npm run dev` boot log now shows
  `messaging=twilio email=ses`; a live tour confirmation delivers a real SMS.
  `npm run dev -- --mock` shows `messaging=twilio(fake) email=console` and lands
  in `/__dev/outbox` / fake-phones.
