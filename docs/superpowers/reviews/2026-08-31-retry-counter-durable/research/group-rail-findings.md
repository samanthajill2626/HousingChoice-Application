# Group rail (slice 4) - what the live tree contradicts or the plan omits

Read-only research against `W:\tmp\retry-counter-durable` @ `8c8b7100`.
Scope: `services/groupRail.ts`, its five callers, `adapters/groupConversations.ts`,
and the tests that exercise them. Findings only - the control-flow outline,
quotes, caller table, fake shape and sleep precedent are in the reference
artifact under `.superpowers/sdd/research/group-rail-reference.md`.

Everything the spec and plan assert that I could check DID hold, with the
exceptions below. Confirmed as stated: the counter-relevant anchors
(`groupRail.ts:463`, `:538`, `:578-584`, `:619-625`, `:259-262`) all landed on
the named constructs; `failures: []` is unconditional on the bulk create path
(`adapters/groupConversations.ts:486`); `50386`/`50437` appear in **no** source
file, only in `docs/`; the two false `rail_failed` records of the incident come
from the post-repair branch (`groupRail.ts:552-560`), so D14's "ladder both
reads" is necessary; and the validation read after create really is a NEW
`fetchParticipants` call, because the create path sets `participants` at `:462`
and therefore skips the `??=` read at `:492`.

---

## 1. [BLOCKING-ish] Ladder point 1 is NOT inside any try/catch - the plan's "if" is a "must"

Plan 4d says "Verify the placement lands inside the existing handler; if ladder
point 1 needs its own wrapper...". The tree answers it definitively: the region
`groupRail.ts:502-521` is enclosed by **no** try. try #1 ends at `:473`, try #2
covers exactly the one statement at `:492`, try #3 does not open until `:522`.
`missing` is first computed at `:507`, bare.

So ladder point 1 **always** needs its own try/catch. Without one, a throwing
`fetchParticipants` escapes `ensureGroupRail` entirely and leaks the
`rail_creating` claim for its full 5-minute expiry (`groupRail.ts:198`) - the
exact failure D16 used to reject touching the `groupSend` paths, reintroduced on
the job/import/script paths instead. The catch must mirror `:493-501`
(summary reason, `group_rail_ensure_failed` warn, `recordRailFailure`, return
`failed`).

Ladder point 2 (`:538`) needs no wrapper: it is already inside try #3
(`:522-549`).

## 2. [HIGH] The `rail-verify.ts` caller cannot reach the laddered path at all

D16 and plan 4b count "the operator verify script" as one of the three callers
that gets the fix. It cannot benefit, because of D17's own `!wasAdopted` gate:

- `app/scripts/rail-verify.ts:176` filters to `railed` - threads that already
  carry a `twilio_conversation_sid` - and `:197` iterates only those.
- Every such thread either short-circuits at the fast path
  (`groupRail.ts:323-332`, no Twilio call) or claims and then adopts, because
  the rail exists in Twilio under a UniqueName that IS the conversationId
  (`groupRail.ts:404`, `:452-454` -> `wasAdopted = true`).
- The only way that script reaches `wasAdopted === false` is the dead-adoptee
  delete-and-recreate branch (`:433-450`).

So on the verify script the flag is inert except for closed rails. Either drop
it from the caller list, or state in the spec/plan that its coverage is
delete-and-recreate only. The same shape applies, less severely, to the import:
`convertGroups.ts:405-407` runs the rail step on EVERY run, so a re-run adopts
and does not ladder - the ladder helps the FIRST conversion only, which is
exactly where the 2026-08-13 harm occurred, so that one is fine but worth saying.

## 3. [MED] Plan 4e names the wrong variable for the stored map, and the author-block coupling is narrower than stated

Plan 4e: "The ladder REASSIGNS `participants`, which also feeds the
author-verification block (~:578-584) and the stored participant map
(~:619-625)."

- The stored map write at `groupRail.ts:619-625` passes **`participantMap`**,
  not `participants`. `participantMap` is a separate `let` computed at `:506`
  and recomputed at `:539`. A ladder that reassigns only `participants` would
  store a map that predates its own authoritative read - the precise thing D15
  forbids. The ladder must reassign `participants`, `participantMap` AND
  `missing` together.
- On the CREATE path the re-read **cannot** change `authorPresent`
  (`:582-584`): `!wasAdopted` short-circuits the `||`, so the value is just
  `!authorRefusedOnCreate`, which the ladder does not touch. The only
  author-block behavior a laddered re-read can change on the create path is
  `staleAuthors` (`:581`) - a newly-visible projected participant whose address
  differs from `author` now triggers `removeParticipant` (`:598`) where today it
  would not. That, not `authorPresent`, is what plan 4e's "its test must assert
  the author path still behaves" needs to pin.

## 4. [MED] TypeScript narrowing trap on `participants` - the same shape as the plan's own slice 2c warning, unstated for slice 4

`participants` is declared `GroupParticipantRef[] | undefined` at
`groupRail.ts:388` and is used unguarded at `:578` (`participants.filter(...)`);
that compiles today only because the `??=` at `:492` narrows it in the same
function scope. If the ladder is written as a nested helper or closure that
ASSIGNS `participants`, TypeScript drops that narrowing and gate 1 fails at
`:578`. Slice 2c documents this exact hazard for `let broadcasts`; slice 4 has
it too and does not say so. Same remedy shape: keep the assignment in the
handler scope (have the helper RETURN the new list), or pin a `const` after the
ladder.

## 5. [LOW] Adapter anchors: `fetchParticipants` is `:759`, and the binding filter that creates `missing` is not in the adapter at all

The issue front-matter and the plan point at
`adapters/groupConversations.ts:359` for the binding-address filtering.
In the live tree:

- `:359` is inside `toParticipantRef` (`:352-360`), which only OMITS whichever
  of `address`/`projectedAddress` the binding lacks;
- `fetchParticipants` is at `:759-776` and filters nothing;
- the participant that actually gets DROPPED - and therefore produces the short
  `missing` set the ladder waits out - is dropped in
  **`groupRail.ts:227`** (`buildParticipantMap` skips any participant whose
  `address` is empty/absent).

Anyone auditing "the binding address filter" at the adapter line will not find
the mechanism.

## 6. [LOW] The create path has already burned one participants read before the ladder starts

The plan describes the post-create list as arriving "INSIDE the adapter's
return", which is true but understates it: that list is itself the result of a
`fetchParticipants` call the adapter makes immediately after the create
(`adapters/groupConversations.ts:480` on the bulk path, `:540` on the
individual-add fallback). So a fresh create already performs read #1 within
milliseconds of the create, and the ladder's re-reads are #2 and #3. That is
relevant to sizing the 500ms/1500ms rungs and to any test that counts
`fetchParticipants` calls: the create path's baseline is 0 calls on the PORT
fake (the fake's create returns its own list), but 1 real HTTP read in
production.

## 7. [LOW] Both ladder points can fire in one call; the compounded cost is unstated

A create whose bindings never propagate runs point 1 (2 sleeps, 2 reads), then
the repair, then point 2 (2 more sleeps, 2 more reads) - 4s of added wall clock
and 4 extra Twilio reads per rail. On the 2026-08-13 shape (81 of 132 threads
short) the happy case alone adds ~40s to a migration run. Nothing in spec Sec 5
or plan 4c bounds the total; worth one sentence, and worth confirming the import
runner's per-row budget tolerates it.

## 8. [LOW] Two existing rail fakes cannot assert the flag; one important property is pinned only by accident

- `app/test/groupRailJob.test.ts:40` and
  `app/test/importConvertGroups.test.ts:158` both capture only
  `request.conversationId`. Plan 4c's tests ("both `groupSend` callers pass no
  flag", and by symmetry that the three opted-in callers DO pass it) need those
  fakes to record the whole request - a one-line change in each, but the plan
  lists no test-fake work for slice 4 at all.
- "No repair on a complete create" is currently pinned **only implicitly**, by
  `makePort`'s default `addParticipants` throwing
  (`app/test/groupRailService.test.ts:149-151`). No test asserts the call never
  happened. The headline propagation test should assert `addParticipants` was
  not called (and `calls.failures === 0`), not rely on the negative-control
  throw, because a ladder bug that resolves `missing` for the wrong reason would
  still pass a throw-based control.

## 9. [INFO for slice 6] `isDeadRailState`'s unenumerated default is NON-terminal, and it has two call sites

`groupRail.ts:259-262` maps `undefined` to `'active'` and returns true only for
`'closed'`/`'failed'`; every other Twilio state - including any future one -
reads as a live rail. That is the voice-incident shape (unenumerated default =
"keep going"), so it is a genuine slice 6 hit, and the disposition question the
plan raises is real. Note it is consumed at **two** sites, `:433` (adopt half -
an unknown state means the adoptee is KEPT rather than deleted) and `:484`
(post-create - an unknown state means the rail is FINALIZED), so a sweep entry
naming only one line is incomplete.
