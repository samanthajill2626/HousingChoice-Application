# Round 3 adversarial specification review - message transport fidelity

## 1. [BLOCKING] The retry rule contradicts the existing relay continuation model

What is wrong:

Section 8.1 says, without limiting it to direct 1:1 retries, that a retry is a
new provider attempt and therefore a new row or slot send observation. Sections
6 and 7.2 simultaneously preserve a relay source's original requested value and
say that queued fan-out work reclassifies and continues the existing send path.
Those decisions cannot both apply to relay continuations. A relay retry today is
not a new source row or recipient slot: it is another attempt against the same
slot. Creating an additional slot changes the current delivery-status, callback
pointer, and recipient-row cardinality semantics; retaining the slot violates the
new universal retry rule.

Evidence:

- Spec section 8.1, lines 392-398, requires a new row or slot observation for a
  retry; section 6, lines 287-294, preserves the original requested value while
  a queued job executes later; section 7.2, lines 326-337, says relay retry
  behavior remains unchanged.
- `app/src/jobs/relayFanOut.ts:524-529` deliberately keeps a transient leg's
  existing slot `queued`, and `app/src/jobs/relayFanOut.ts:565-596` re-enqueues
  that member key for a continuation. The next execution reads that existing
  slot and sends it again unless terminal (`app/src/jobs/relayFanOut.ts:443-448`).
- The successful attempt then writes the same member-key slot and its SID pointer
  (`app/src/jobs/relayFanOut.ts:538-549`), while status callbacks resolve that
  one pointer back to that one slot (`app/src/routes/webhooks/twilio.ts:2348-2366`).

Implication:

The builder has no correct storage model for a relay retry. The spec must choose
one: preserve the existing one-slot-per-recipient continuation semantics and
scope the "new row or slot" rule to a separately modelled retry flow, or define
new attempt identities, callback routing, UI disclosure, and status aggregation.
It cannot claim both unchanged relay retry behavior and a new slot per attempt.

## 2. [HIGH] A member added after a team source is seeded has no specified pre-send requested slot

What is wrong:

The design enumerates dynamic slot creation for inbound relay fan-out only. For
a team-authored source it says that the source and every recipient slot are
seeded before enqueue. That is not the set the current fan-out actually sends
to: the worker intentionally resolves the roster when it runs. A member added
between source append and worker execution receives the existing message today,
but has no seeded slot. The v3 mechanism neither says to create that slot with
immutable requested transport before the provider call nor lists this race in
verification. Letting the current post-send result write create it would violate
the requirement that every new outbound leg records requested intent before
provider send; not sending the newly added member changes routing behavior.

Evidence:

- Spec section 7.2, lines 319-323, only specifies pre-enqueue seeding for a
  team source. Its create-or-update slot rule is explicitly scoped to an inbound
  relay source at lines 325-332. Section 8.1, lines 392-398, requires requested
  transport to be written on initial slot creation, and acceptance criterion 3,
  lines 723-725, requires every newly persisted outbound leg slot to store it.
- Team send seeds only the roster read in the HTTP request
  (`app/src/routes/api.ts:1761-1771`) and enqueues a job without a recipient
  snapshot (`app/src/routes/api.ts:1802-1810`).
- The worker then deliberately uses the current roster at execution
  (`app/src/jobs/relayFanOut.ts:398-400,434-438`) and accepts an absent prior
  slot (`app/src/jobs/relayFanOut.ts:443-448`) before provider send
  (`app/src/jobs/relayFanOut.ts:502-509`). Open relay groups support member add
  (`app/src/services/relayMembers.ts:128-145,219-220`), so this is a reachable
  race, not a hypothetical state.

Implication:

One normal membership race silently breaks the feature's core requested-transport
invariant or changes established relay delivery. Specify a pre-send,
child-safe initial-slot operation for newly discovered current members on every
team-source and queued-team fan-out path, and test an add between append and job
execution.
