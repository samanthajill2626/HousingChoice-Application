# Message transport fidelity - independent v6 review adjudications

Spec reviewed: v6 at `83824f79`
Review artifact: `spec-review-independent-v6-findings.md`
Review commit: `541e055d`
Verdict: PASS
Findings: 9 LOW

Disposition counts:

- ACCEPT: 9
- REJECT: 0
- DEFER: 0

The review found no specification blocker. Each accepted LOW item below is a
required implementation-plan clarification. None changes the approved feature
behavior or requires a v7 specification.

## L1. SM/MM evidence wording

Disposition: ACCEPT

The implementation plan must describe `SM` and `MM` as Twilio create-time
Message resource classifications used by the provider-boundary normalizer. It
must cite the official Message resource SID pattern, the Twilio help article,
and the repository's live spike evidence rather than relying on the
JavaScript-rendered help article alone.

## L2. Inbound endpoint discriminator

Disposition: ACCEPT

Rule 2's implementable discriminator is an E.164 `To` with no channel prefix.
It does not depend on whether the application already knows or owns the number.
The implementation plan and tests must use that exact condition.

## L3. Conflicting RCS fields

Disposition: ACCEPT

Rule 4 applies only when no channel field is present. Any disagreement between
an E.164 `From` and a channel field such as `ChannelPrefix: rcs` is conflicting
evidence: actual remains pending and the safe conflict path runs. This preserves
rule 5's precedence until the controlled RCS fallback probe supplies a verified
shape.

## L4. Non-provider fixture SIDs

Disposition: ACCEPT

A SID that does not match the supported provider patterns is missing evidence,
not transport evidence. Hermetic and development SIDs such as `dev-*` must leave
actual pending without warning. Any unknown-evidence warning must be scoped to
authenticated provider traffic so fixture seams do not pollute the warning
sweep.

## L5. Success metadata cleanup

Disposition: ACCEPT

A successful send result removes a stale transient `errorCode`. `sentAt` is
absent-only: a continuation after a transient failure writes it when the first
provider result arrives, while a duplicate or same-status result preserves an
existing timestamp. Focused repository and continuation tests must prove both
the removal and preservation cases.

## L6. Removed-member delivery rollup

Disposition: ACCEPT

The excluded-without-code omission is the one deliberate delivery-presentation
change in scope: a member removed after transport preflight but before provider
attempt is omitted from the delivery denominator and expanded rows. The
implementation plan must carve this case out from section 15's otherwise
unchanged delivery semantics.

The timing asymmetry is intentional for this mission. A source-time slot for a
member removed before the first preflight remains state-absent and `queued`, so
it remains counted; removal after a `planned` preflight produces `excluded` and
is hidden. Changing that legacy source-time behavior is not required here.

## L7. Native-group evidence precedence

Disposition: ACCEPT

The native Group MMS rail fact is authoritative. A group receipt's channel SID
may corroborate that fact or raise a safe conflict warning, but it may never be
the originating transport decision for the leg.

## L8. Logged channel prefix

Disposition: ACCEPT

When structured transport logs include a channel prefix, they may contain only
the scheme before the first colon, such as `rcs` or `whatsapp`. They must never
include the identifier or address after the colon.

## L9. Legacy conditional no-op

Disposition: ACCEPT

Conditional transport-write classification has four outcomes: idempotent,
allowed fallback, conflict, and legacy compatibility no-op. A write refused
solely because the row is schema-absent is silent and must not emit a conflict
warning; existing delivery-status progression remains independent.

## Planning gate

The implementation plan must carry L1-L9 as explicit work items and test
obligations. The independent PASS plus these accepted clarifications leaves no
unresolved specification finding. Human specification approval is still
required before planning begins.
