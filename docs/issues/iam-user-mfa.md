---
id: iam-user-mfa
title: IAM user 'housingchoice' has no MFA
type: security
severity: med
status: deferred
area: infra/aws
created: 2026-06-11
refs: scripts/lib/hcAws.mjs
---

**Problem.** Root has MFA; the `housingchoice` IAM user does not.

**Decision — deferred 2026-06-11.** Accepted for now given the mitigations in place:
the account-ID guard in every mutating script (`assertHousingChoiceAccount`), named-profile
only (the default credential chain is never used), and console read-only by policy.

**Revisit when** the team grows beyond one person.

Migrated from the RUNBOOK "Security / hardening backlog".
