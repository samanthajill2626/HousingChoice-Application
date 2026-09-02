# Message transport fidelity - independent v5 review adjudications

Spec reviewed: v5 at `051a4442`
Review artifact: `spec-review-independent-v5-findings.md`
Review commit: `f340c87b`
Findings: 12

Disposition counts:

- ACCEPT: 12
- REJECT: 0
- DEFER: 0

## B1. Actual-transport evidence source

Disposition: ACCEPT

The review correctly refutes v5's use of `ChannelPrefix` as a general SMS/MMS
and inbound signal. Twilio documents it only for RCS, WhatsApp, and other
channels, and the inbound webhook does not list it.

The broader claim that SMS/MMS has no provider evidence is incomplete. Twilio
officially documents `SM` Message SIDs as text and `MM` SIDs as media, documents
`From: rcs:<SenderId>` on successful outbound RCS, and documents inbound
`ChannelMetadata.type`. V6 uses those provider fields with conservative
precedence at the Twilio boundary. It never fabricates `ChannelPrefix=sms|mms`.

The exact automatic-fallback callback/resource shape remains undocumented. It is
tracked for a controlled probe before RCS enablement; ambiguous evidence remains
pending. RCS enablement is outside this mission.

## B2. Schema-absent relay delivery

Disposition: ACCEPT

V6 defines an explicit compatibility branch. Schema-absent sources bypass every
transport-only preflight and write and continue through the existing send,
result, SID-pointer, continuation, and callback paths. A compatibility no-op is
not a preflight failure. Focused tests cover queued jobs, continuations, and a
later-released `queued_pending` hold.

## H1. Same-status producer result

Disposition: ACCEPT

V6 separates status progression from result metadata. `queued -> queued` keeps
status but still records eligible SID, `sentAt`, error, and actual fields. An
already-advanced status cannot regress, and each non-status child keeps its own
condition/state machine.

## M1. Initial preflight status and excluded presentation

Disposition: ACCEPT

A dynamically created slot starts `queued`. An excluded never-attempted member
without a suppression code is omitted from delivery aggregation and disclosure;
a `contact_opted_out` exclusion keeps the existing not-sent presentation.

## M2. Persisted announcement aggregation

Disposition: ACCEPT

V6 explicitly treats a persisted announcement as an in-process transport
execution: append planned slots, mark attempted immediately before each provider
call, exclude suppression, and apply the child-field result afterward.

## M3. Recipient-key logging

Disposition: ACCEPT

Transport warnings use `logSafeMemberKey` and never emit a raw `phone#<E164>`
map key.

## M4. Imported history compatibility

Disposition: ACCEPT

Evidence-free imports remain schema-absent and keep legacy labels. An import row
uses version 1 only when its source contains explicit provider-attributable
transport evidence.

## M5. Seed evidence

Disposition: ACCEPT

Lean, full, and performance seeds act as the hermetic provider and explicitly
author normalized actual transport for ordinary carrier rows. Intentional legacy
and unknown cases remain isolated fixtures.

## M6. Relay classification input

Disposition: ACCEPT

Relay intent is based on the durable attachment set the worker actually forwards
plus stable adapter configuration, never legacy `type` or raw source media URLs
the worker does not replay. Failure to materialize media produces a body-only
execution intent and a drift observation without refusing the existing send.

## L1. Stale pre-fallback callback noise

Disposition: ACCEPT

After an RCS request has stored SMS/MMS fallback actual, a late RCS observation
is a superseded idempotent no-op at info/debug. The same conflict on a non-RCS
request remains warning-worthy.

## L2. Main drift

Disposition: ACCEPT

V6 records the observed drift and requires the implementation plan to refresh
all citations and call sites against then-current `main`. No stale line number is
treated as implementation authority.

## L3. Outcome vocabulary

Disposition: ACCEPT

Section 1 now states the generic unequal-pair and requested-to-Mixed rules rather
than listing only RCS examples.

## Resulting verdict

The independent FAIL verdict applies to v5. V6 removes the invalid general
`ChannelPrefix` premise, preserves legacy relay delivery, and owns every high and
medium implementation decision identified by the review. The unresolved live
RCS fallback shape is explicitly deferred to the RCS enablement gate and cannot
be represented as verified by this mission.
