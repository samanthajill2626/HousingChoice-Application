---
id: aws-cli-identity-can-diverge-from-account-guard
title: aws-CLI child processes can resolve a different identity than the SDK account guard validated
type: security
severity: low
status: open
area: scripts
created: 2026-07-26
refs: scripts/lib/hcAws.mjs:39, scripts/dev.mjs, scripts/secrets.mjs:82, scripts/deploy.mjs, scripts/userRole.mjs, scripts/userInvite.mjs
---

**Problem.** `assertHousingChoiceAccount()` validates the PINNED profile via the
SDK (`fromIni({ profile: HC_PROFILE })` -> STS, account-id compare). But several
orchestrated scripts then shell out to the `aws` CLI, whose EFFECTIVE identity is
resolved independently by the CLI's own precedence chain - so "guard passed" does
not prove the CLI child used the same identity. Two divergence modes (surfaced by
the dev-live-comms adversarial review, 2026-07-26):

1. Profile-source divergence: the guard always validates
   `HC_PROFILE = HC_AWS_PROFILE ?? 'housingchoice'`, while CLI children pick their
   profile from other places - e.g. `scripts/dev.mjs`'s SSM fetch passes
   `--profile childEnv.AWS_PROFILE` (an exported `AWS_PROFILE=<other>` in the real
   env wins over the overlay default, so the guard can validate `housingchoice`
   while the CLI runs as `<other>`). `secrets.mjs` forces `AWS_PROFILE: HC_PROFILE`
   into its child env, which closes this mode there but not elsewhere.
2. Static-env-creds divergence: child envs spread `process.env`, so exported
   `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (this machine's default chain points
   at an UNRELATED account - the known ABT credential foot-gun) ride into every CLI
   child. CLI credential precedence between static env creds, `--profile` options,
   and the `AWS_PROFILE` env var is subtle and mechanism-dependent; scripts that
   rely on the env var alone (no explicit `--profile`) are the most exposed.

Observed impact today: bounded. Read paths mis-target and come back empty/denied
(e.g. dev.mjs's SES-identity hydration would warn + the app then refuses to start
under `EMAIL_DRIVER=ses`). Write paths (`secrets:push` SSM writes) force the
profile env var, so a wrong-account WRITE needs both a static-creds export AND the
env-var-only mechanism to lose - unlikely but not proven impossible.

Related, distinct issue: [one-off-scripts-missing-account-guard](one-off-scripts-missing-account-guard.md)
covers `app/scripts/*.ts` that have NO guard at all. This one covers guarded
scripts whose CLI children may not inherit what the guard proved.

**Suggested fix.** Make the guard validate the CLI's identity, not (only) the
SDK's: a shared helper that runs `aws sts get-caller-identity` WITH exactly the
profile/env the subsequent CLI calls will use, comparing against `HC_ACCOUNT_ID` -
and/or standardize every CLI child on an explicit `--profile` + a scrubbed child
env (drop `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`,
force `AWS_PROFILE`), the way `secrets.mjs` already half-does.
