# Task 5 Relay review adjudications

Reviewed commit: `dc6f1410 feat: track transport across relay fanout`

| Finding | Decision | Rationale |
| --- | --- | --- |
| M1 continuation subset excludes current roster member | Accepted | Continuation `recipientKeys` restrict one job's sends, not the current execution roster used to identify a removed member. Excluding Carol in a Bob-only continuation breaks later aggregation and disclosure. |
| M2 suppressed excluded slot reopened | Accepted | Suppressed slots must remain requested-only, excluded, and absent from the provider path. They are not a removed-member rejoin and cannot be reopened by redelivery. |

Both fixes are confined to Task 5 Relay preflight and its deterministic tests.
