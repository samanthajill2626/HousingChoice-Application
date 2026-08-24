---
id: relay-inbound-resolution-residuals
title: Known residuals shared by the relay (To, From) inbound ladder, SMS and voice
type: debt
severity: low
status: open
area: app
created: 2026-08-24
refs: app/src/services/relayInboundResolution.ts, app/src/routes/webhooks/twilio.ts, app/src/routes/webhooks/voice.ts
---

**Problem.** The 2026-08-24 adversarial review of `fix/voice-pool-multiplex`
(the masked-voice multiplexing fix, see
[voice-relay-multiplexing-ambiguity](voice-relay-multiplexing-ambiguity.md))
surfaced a set of real-but-deliberately-unfixed residuals. Each was left
because it predates the fix, is shared byte-for-byte with the SMS path (so a
one-sided change would reintroduce channel drift), or is a product call.
Recorded here so the next person does not have to rediscover them:

1. `created_at` ties resolve by raw GSI page order. `byNewestCreated` returns
   0 on equal or missing `created_at`, and the byPoolNumber GSI is hash-only,
   so "newest" between two same-millisecond groups is nondeterministic across
   queries. Seeded worlds (matrix relay groups all share `D.T2`) make the tie
   the norm in dev/e2e. Fix would be a deterministic tie-break (e.g.
   conversationId) inside the shared comparator - one line, both channels at
   once, but it changes which thread existing seeds route refusals into.
2. Membership is the raw `participant.phone === From` walk. It ignores
   `ever_member_phones`, so a REMOVED member's inbound cannot be attributed to
   the group they were removed from (lands as non_member on the newest open
   group instead), and it does not use `rosterMembers()` (the declared
   canonical roster walk in services/relayGroupDuplicates.ts, which excludes
   blank-phone rows). Harmless today (From is never blank; both channels
   match), but the definitions should converge if either ever changes.
3. `status === 'open'` is the partition test, but `relay_status` is canonical:
   touchLastActivity can leave a re-flagged closed group at `status: 'open'`
   with `relay_status: 'relay_group#closed'` (documented in
   relayGroupDuplicates.ts). Both channels share the skew; moving the ladder
   to `relay_status` is the fix, in the shared resolver only.
4. `getAllByPoolNumber` pages its partition uncapped on both inbound hot
   paths. Partitions are tens of rows today and the most-reused numbers grow
   slowly, but there is no RELAY_LIST_MAX_PAGES-style bound.
5. The fake harness `getAllByPoolNumber` filters `type === 'relay_group'`;
   the real repo returns every partition row (the type is a data convention,
   not a constraint). The fake is stricter than prod - the unsafe direction
   for tests.
6. A closed-member refusal call row is filed in the caller's CLOSED thread,
   which the open-partition inbox never lists and the refusal path never
   activity-stamps - honest record, but invisible to a navigator watching the
   inbox. The SMS analogue intercepts into the sender's visible 1:1 thread;
   voice has no equivalent surface today.
7. `ourNumberKind`'s pool test stays truthy forever for a released number
   (pool_number is never cleared), so a recycled number's new owner calling
   or texting us is dropped as a self-echo. Pre-existing, both channels.

**Suggested fix.** None as a unit - pick items off individually, and make any
ladder change inside services/relayInboundResolution.ts so SMS and voice move
together. Items 1 and 3 are the cheapest real hardening; item 7 likely wants
a released-numbers check in ourNumberKind when number recycling first bites.
