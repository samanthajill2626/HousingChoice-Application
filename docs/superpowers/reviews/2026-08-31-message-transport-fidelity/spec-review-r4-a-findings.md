# Round 4 adversarial specification review - message transport fidelity

## 1. [HIGH] The outbound completeness rule has no coherent membership set under current-roster relay fan-out

What is wrong:

V4 correctly adds a pre-send initializer for a roster member discovered after a
team source is appended, but the presenter still defines the outbound expected
set as only slots initialized with the source message. That excludes a newly
discovered member who is actually sent the message, so their missing or divergent
actual transport cannot keep the main chip pending or make it Mixed. It also
includes a source-time member removed before the worker runs: current routing
correctly sends that member nothing, leaves the pre-seeded slot queued, and then
the main chip can never become complete because that slot can never gain actual
evidence. The specification supplies no membership-state field, removal update,
or presenter rule that can distinguish those two cases without changing current
routing or delivery semantics.

Evidence:

- Spec section 7.2, lines 319-337, seeds source-time team slots but requires a
  later absent-slot initializer for any current roster member. Section 9.4,
  lines 521-530, nevertheless declares only source-initialized slots to be the
  expected set for completeness and aggregation. Section 13.1 item 9,
  lines 668-673, requires the post-append member race but has no corresponding
  aggregate-completeness case.
- A team source seeds the request-time roster (`app/src/routes/api.ts:1761-1771`),
  while the worker deliberately selects the current roster at execution
  (`app/src/jobs/relayFanOut.ts:398-400,434-438`). Thus a later add is an actual
  outbound recipient and a later removal is not.
- Open relay groups permit removal (`app/src/services/relayMembers.ts:295-337`).
  The worker iterates only current recipients and leaves any old source-time
  slot untouched (`app/src/jobs/relayFanOut.ts:443-459`); no existing path can
  give a removed member's queued slot transport evidence.

Implication:

The main transport chip can falsely show a uniform/completed result while a
post-append recipient used a different transport, or remain permanently pending
for a recipient who was intentionally never sent. Define the outbound relay
aggregate membership contract for added and removed members, the durable state
needed to apply it, and tests for both races before implementation. The current
"source-time expected set" rule is incompatible with the explicitly retained
current-roster delivery model.
