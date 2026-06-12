# infra/envs/prod/

The `hc-prod-` stack lands here in M0.4. It composes the shared modules from `infra/modules/` and uses an S3 backend with native lockfile locking (`use_lockfile = true`) and its own state, separate from dev. All resources are prefixed `hc-prod-` in us-east-1. The AWS console stays read-only — all changes via `npm run plan` / `npm run apply`.
