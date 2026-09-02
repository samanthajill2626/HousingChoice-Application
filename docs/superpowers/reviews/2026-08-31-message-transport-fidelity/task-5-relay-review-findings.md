# Task 5 Relay review findings

Reviewed commit: `dc6f1410 feat: track transport across relay fanout`

## M1: continuation send filtering is incorrectly used for stale roster reconciliation

`app/src/jobs/relayFanOut.ts:597` filters the send set by continuation
`recipientKeys`, then `preflightVersionedRecipients` treats that subset as its
membership set and excludes every other never-attempted planned slot. A current
member omitted from one continuation was not removed from the roster and must remain
planned; continuation filtering only limits the legs sent by that job.

Keep distinct sender-excluded current-roster and continuation send sets. Use the
current-roster set for removed-member reconciliation, and use the continuation set
for initialization/preflight/send execution. Add a deterministic current-but-not-in-
continuation regression.

## M2: suppressed exclusion can be reopened to planned on redelivery

`app/src/jobs/relayFanOut.ts:872` reopens every excluded current recipient with no
actual transport. A `failed/contact_opted_out/excluded` recipient becomes planned
before the terminal-status guard skips it, losing the required suppressed exclusion
representation.

Reopen only a never-attempted, non-suppressed removed-and-rejoined slot. Preserve
the excluded state and suppression diagnostic for redelivered/continuation jobs;
add a focused regression distinct from the valid removed-member rejoin case.

The review independently confirmed the hard schema-absent legacy branch and its
continuation/held-release proof, versioned source intent, preparation timing,
child-field results, and safe member-key logs.
