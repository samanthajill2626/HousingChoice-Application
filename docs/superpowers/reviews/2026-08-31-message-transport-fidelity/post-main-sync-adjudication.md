# Post-main-sync review adjudication

Date: 2026-09-02

## Spec-conformance review

Verdict: ACCEPT.

The review found no loss of the approved requested-versus-actual transport
contract, legacy discriminator, provider-evidence ordering, or Group MMS and
relay presentation behavior. No corrective source change is required for the
transport-fidelity mission.

## Adversarial P1: capped duplicate can close an active relay pass

Verdict: ACCEPT AS A SEPARATE FOLLOW-UP.

The finding is technically valid. A barrier test with two different job IDs
reproduced the false `transient_cap` close while the winning provider send was
still blocked. Producer tracing also established a production-reachable ingress
through overlapping queued-message flushes.

The defect is not a requested-versus-actual transport rule and is not resolved
by changing transport persistence. It is a concurrency gap created by the
interaction between main's durable fan-out counter and the existing relay
execution model; both legacy and transport-schema-v1 source rows are affected.
The proposed source-owner protocol has its own lease-expiry and unknown-provider-
outcome design work, so it must not be improvised as part of conflict resolution.

Human direction on 2026-09-02 is to finish and commit the main sync for this
feature, record the issue durably, and address it with another agent in a
separate mission. The follow-up is tracked at
`docs/issues/relay-fanout-active-pass-cap-close-race.md` with the full evidence
and rejected remedies retained in `post-main-sync-adversarial.md`.

The investigative red test is not committed here: leaving an intentionally
failing test would make this branch incomplete and invalidate its required
gates. The follow-up mission should recreate it first for its TDD red proof,
then add the legacy equivalent before implementing the owner/lease fix.

## Merge-readiness ruling

The post-main-sync P1 is deferred by explicit human scope, not rejected or
silently waived. Merge readiness for message-transport-fidelity now depends on
fresh green completion gates after the merge and on committing this adjudication,
the two post-main-sync review reports, and the issue record.
