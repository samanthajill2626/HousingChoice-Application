# Relay inbound caller identity - design review adjudications

## Spec round 1

Reviewers: `spec-r1-reviewer-a.md`, `spec-r1-reviewer-b.md`

Counts: 5 reported findings, 4 distinct findings, 4 accepted, 0 rejected,
0 deferred. All four accepted findings changed the specification, so a round 2
re-review is required.

### A1 / B1 - ACCEPT

Claim: the three independent optional `NewMessage` fields did not enforce the
approved non-member-only disclosure boundary.

Adjudication: verified. `NewMessage` is the shared append contract and the live
append mapper conditionally copies optional fields without cross-field guards.
The spec now uses a discriminated `relayCallRefusal` write shape and requires
runtime append validation for call kind, inbound direction, masking, reason,
E.164 phone, and contact-ID dependency. Direct repository rejection tests are
required.

Decision changed: yes. The enforcement boundary moved from writer convention to
the generic append funnel.

### A2 - ACCEPT

Claim: an optional contact display read could make the whole relay timeline 500.

Adjudication: verified. `getDisplaysByIds` returns short maps for unprocessed
keys but can reject when the underlying BatchGet throws, while the current
messages route has no local fallback. The spec now requires a best-effort error
boundary that logs and returns the complete unhydrated message page.

Decision changed: yes. Read hydration now has an explicit availability policy
and rejection test.

### A3 - ACCEPT

Claim: post-arrival contact deletion behavior was undefined, and the existing
display projection cannot distinguish a soft-deleted contact.

Adjudication: verified. Normal staff lists hide `deleted_at` rows, while the
current display projection omits that field. The spec now makes a deleted
contact fall back to phone/no link, makes restore return current name/link, and
requires `deleted_at` in the display projection with delete/restore tests.

Decision changed: yes. Delete and restore semantics are now explicit.

### A4 - ACCEPT

Claim: full visible date/time with seconds was not implementable from the
existing compact accessible-name formatter.

Adjudication: verified. The current `formatTimeWithSeconds` is intentionally a
time-only accessible label. The spec now requires a separate
`formatDateTimeWithSeconds` using the viewer's local timezone and a visible
`Time unavailable` fallback, plus focused formatter and UI tests.

Decision changed: yes. The visible detail formatter and invalid-time behavior
are now explicit.

## Spec round 2

Reviewer: continued reviewer A with both round-1 reports and adjudications.

Counts: 1 reported finding, 1 distinct finding, 1 accepted, 0 rejected,
0 deferred. The accepted finding changed the specification, so a round 3
re-review is required.

### A1 - ACCEPT

Claim: structural append validation still allowed a semantically forged contact
ID and did not forbid roster attribution on a non-member refusal.

Adjudication: verified. The messages repository has no contacts dependency and
cannot re-fence a phone/contact pair without adding the wrong cross-repository
read. The spec now introduces one dedicated refusal-recording service whose
public input contains raw `From` but no contact ID; it owns normalization,
indexed lookup, deletion fencing, author, and roster-key decisions. The generic
append boundary additionally rejects a non-member refusal with a roster key or
non-`unknown` author.

Decision changed: yes. Semantic identity resolution now has one named owner,
and the repository enforces the roster-attribution half of the invariant.

## Spec round 3

Reviewer: continued reviewer A with all prior reports and adjudications.

Counts: 2 reported findings, 2 distinct findings, 2 accepted, 0 rejected,
0 deferred. Both accepted findings changed the specification, so the fourth and
final allowed spec review round is required.

### A1 - ACCEPT

Claim: the dedicated service was still bypassable because generic `NewMessage`
publicly accepted an arbitrary phone/contact-ID pair.

Adjudication: verified. Naming a preferred service did not remove the direct
append path. The spec now adds no refusal fields to `NewMessage`; generic
`append` rejects reserved refusal keys and never maps them. A dedicated
`MessagesRepo.recordRelayCallRefusal` operation accepts only raw webhook/roster
facts plus a narrow contacts resolver, performs the exact lookup itself, and
uses a private append core to persist the derived fields.

Decision changed: yes. The public generic bypass has been removed rather than
documented away.

### A2 - ACCEPT

Claim: extracting all refusal persistence without isolating the existing
roster-member `getById` failure contradicted the guaranteed refusal response.

Adjudication: verified. The live read sits outside the append try/catch. The
spec now makes both `findByPhone` and `getById` best-effort. A member read
failure preserves the known roster key, falls back to `author: 'unknown'`, logs,
stores the refusal, and still returns masked no-bridge TwiML. Every member
refusal reason gets a forced-failure route test.

Decision changed: yes. Failure isolation now covers every contacts read owned by
the operation.

## Spec round 4 - HUMAN DECISION COMPLETE

Reviewer: continued reviewer A with all prior reports and adjudications.

Counts: 1 reported finding, 1 distinct finding, 0 accepted, 1 rejected,
0 deferred. This is the feature-mission hard cap; no fifth review round is
permitted.

### A1 - REJECT

Claim: the dedicated operation receives a caller and reason supplied by its
route, so it can compare caller phone to `From` but cannot prove membership in
the selected conversation or prove non-membership from the roster.

Code evidence: `ConversationParticipant` is only a value object, and
`relayMemberKey` derives identity directly from that value. The proposed
operation input carries no full `ConversationItem` or authoritative
conversations resolver.

Human ruling: reject. Relay resolution, membership classification, bridge versus
refusal, and refusal-reason precedence are already correctly owned by the
existing voice handler. Repeating those decisions in persistence would create a
second routing system that could drift from the live handler. This mission is a
persistence and staff-presentation change after the handler has already chosen
`non_member`; it must not change or revalidate whether a call is dropped or
routed to another member.

Decision changed: yes. The proposed dedicated refusal recorder was removed.
The existing `messages.append` call remains the write path and gains only the
three optional non-member facts, with storage-shape validation that does not
inspect conversations or make routing decisions.

## Human scope clarification after round 4

The round-2 and round-3 dedicated-recorder recommendations were initially
accepted while pursuing a stronger semantic write boundary. The human clarified
that this abstraction itself exceeds the approved scope and makes an already
correct routing path harder to understand. Those architectural changes are
therefore superseded in the final design; their underlying safety requirements
are retained only where they fit the persistence-only lane:

- keep cross-field storage-shape checks on the existing append boundary;
- keep the new non-member phone/contact lookup best-effort;
- do not add a refusal-recording service or repository operation;
- do not revalidate membership or rederive the refusal reason after the voice
  handler has decided it; and
- do not change failure behavior for existing roster-member lookups or other
  refusal reasons.

Across all four rounds, reviewers reported 9 findings representing 8 distinct
findings. Seven were initially accepted, and the final finding was rejected by
the human. The human scope clarification superseded the dedicated-recorder
architecture introduced by three of the earlier accepted findings. No fifth
review round will be run.

## Plan round 1

Reviewers: reviewer A and reviewer B independently reviewed the approved spec,
implementation plan, current repository, and this adjudication history.

Counts: 2 reported findings, 2 distinct findings, 2 accepted, 0 rejected,
0 deferred. Reviewer B reported no findings and confirmed the named route,
repository, dashboard, and E2E seams exist.

### A1 - ACCEPT

Claim: the proposed lookup-failure warning serialized the caught error, whose
message could contain the caller phone, despite the spec making new phone logs a
non-goal.

Code evidence: the logger's `err` serializer preserves `err.message`, and the
webhook harness exposes a captured pino destination. A dependency error that
echoes the lookup key would therefore place the external phone in the new log.

Plan change: the catch now logs only `callSid`, never the caught error. The route
test must reject with an error containing the test E.164 number, select the exact
new warning from captured logs, and prove neither raw nor formatted phone is in
that warning or the TwiML.

Decision changed: no. This closes an implementation leak while preserving the
approved best-effort lookup and existing refusal behavior.

### A2 - ACCEPT

Claim: only the in-memory webhook harness exercised a reason-only anonymous
refusal row, so the real append guard could accidentally require a phone and
drop that production row without failing the planned tests.

Code evidence: the harness fake pushes appended objects without applying the
real repository validator, while the production refusal append is protected by
an error boundary that still returns TwiML after an append rejection.

Plan change: the repository test now appends a valid reason-only input through
the real append boundary and asserts the transaction includes the reason while
omitting both external identity fields.

Decision changed: no. This proves an already approved storage state at the
correct runtime boundary.

## Plan self-review after round 1

Two precision corrections were made without changing the approved design:

- the dashboard mapper accepts `relay_refusal_reason` only when it is exactly
  `non_member`, rather than accepting any string from the wire; and
- Timeline tests prove collapsed/revealed state through `aria-expanded` and the
  card class because the Vitest environment does not apply production CSS.
