# Slice 4 - the group rail binding-propagation ladder

Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`.
Base for this step: `b1daba6b` (slice 3's build record; main already merged at
`8c8b7100`, no further sync performed).

Commits:

- `b945fec5` feat(rail): wait out Twilio binding propagation before concluding
  damage - the service change plus the headline test.
- `4382cb95` feat(rail): opt the job, the import and the verify script into the
  ladder - the three callers, the two fake widenings, the remaining seven tests.
- (this report, committed separately)

Scope was exactly the seven files the worklist names: `services/groupRail.ts`,
the three caller request sites, and three test files. `services/groupSend.ts`,
`repos/conversationsRepo.ts` and `adapters/groupConversations.ts` were READ but
never opened for edit.

STRICT TDD was followed and the RED is recorded below (section 4).

---

## 1. What shipped - `app/src/services/groupRail.ts`

- `:19` - `import { setTimeout as delay } from 'node:timers/promises';`, the
  only new import. It matches the in-repo `sleep?:` precedent (`lib/tokenBucket.ts`).
- `:123-137` - `awaitBindingPropagation?: boolean` on `GroupRailRequest`, with
  the doc stating why it is opt-in per caller (D16) and why an adopted rail
  ignores it (D17). Because `lib/import/convertGroups.ts` re-exports the
  interface verbatim, the import surface gained the field with no edit there.
- `:236-242` - `sleep?: (ms: number) => Promise<void>` on
  `GroupRailServiceDeps`; `:315` defaults it to the real timer.
- `:244-252` - `BINDING_PROPAGATION_DELAYS_MS = [500, 1500]`, module-private,
  documented as tunable numbers rather than a contract (spec Sec 5 names the
  rungs as sizing, not behavior).
- `:324-347` - `reReadUntilBound(conversationSid, members, current)`, the ladder
  helper. It RETURNS the new participant list and assigns nothing in the
  handler's scope, per [RULING groupRail #4]: `participants` is
  `GroupParticipantRef[] | undefined` at `:388`-equivalent and is used unguarded
  at the author block, so a closure that wrote to it would drop the narrowing
  the `??=` read established and fail gate 1. It also does NOT catch: a failed
  re-read is a failed read, and swallowing it to continue on the stale list is
  what D15 forbids.
- `:352` - `const awaitBinding = request.awaitBindingPropagation === true;`,
  computed once beside the `conversationId` destructure and read at both points.

### Ladder point 1 - the post-create validation read

`:569-600`, immediately after `missing` is first computed. Guard:
`missing.length > 0 && awaitBinding && !wasAdopted`.

This region is inside NO try - confirmed against the live tree, exactly as the
research findings said - so it ships with its OWN try/catch, whose body mirrors
the participant-read failure path: `railFailureReason`, a
`group_rail_ensure_failed` warn, `recordRailFailure(conversationId, reason,
now().toISOString(), token)`, `return { status: 'failed', reason }`. Without it
a throwing re-read would escape `ensureGroupRail` and strand the
`rail_creating` claim for its full 5-minute expiry - the precise failure D16
used to keep the `groupSend` paths out of this change, which would otherwise
have been reintroduced on the job/import/script paths.

### Ladder point 2 - the post-repair read

`:631-642`, immediately after the existing post-repair recompute and INSIDE the
repair's own try. Same three-part guard. No new wrapper: a throwing re-read
lands in the repair catch that was already there.

### Both points reassign all three variables

`participants`, `participantMap` AND `missing` together, per
[RULING groupRail #3]. The stored map write passes `participantMap`, not
`participants`, so a ladder that reassigned only the list would persist a map
that predates its own authoritative read.

The authority model is unchanged: the re-read remains the only source of
completeness, nothing is derived from the create's per-member `failures`, and
no 50386/50437 handling was added (D15, D18).

## 2. What shipped - the three callers

- `app/src/jobs/groupRail.ts:59-66` - the one-line request literal became a
  multi-line one carrying `awaitBindingPropagation: true`.
- `app/scripts/rail-verify.ts:198-207` - same flag, with the inertness note
  below recorded in the code comment.
- `app/src/lib/import/convertGroups.ts:429-437` - same flag at the request
  object; the `ensureRail` wrapper at `:600` is a pure pass-through and needed
  no edit.

`app/src/services/groupSend.ts:381` and `:425` were not touched and still build
two-field request literals - verified by grep after the change. The defect
remains live on those two paths, which spec Sec 8 already says.

### rail-verify inertness (must reach the S7 issue update)

The flag is largely INERT on the verify script and this is by design rather
than by omission. That script filters to threads that already carry a
`twilio_conversation_sid` and iterates only those, so each one either
short-circuits on the fast path with no Twilio call, or is ADOPTED - and an
adopted rail ladders on neither read (D17). The only way the script reaches
`wasAdopted === false` is the dead-adoptee delete-and-recreate branch, which is
also the only case where its rail is seconds old. It keeps the flag because
D16's contract names it as one of the three opted-in callers, and because the
one path where it fires is exactly the path that needs it.

The import has a milder version of the same shape and it is fine: the migration
runs the rail step on every row of every run, so a RE-run adopts and does not
ladder. The ladder helps the FIRST conversion - which is where the 2026-08-13
harm occurred.

## 3. Compounded cost (groupRail findings #7)

Both points can fire in one call. A create whose bindings never propagate now
spends 2 sleeps and 2 reads at point 1, then the repair, then 2 more sleeps and
2 more reads at point 2: up to +4s of wall clock and 4 extra Twilio reads per
rail. On the 2026-08-13 shape (81 of 132 threads reading short) the HAPPY case
alone - one rung, one read - adds roughly 40s to a migration run. No total
bound was added, per the plan: the rungs are named as tunable. The import
runner's per-row budget should be confirmed against that before the next bulk
conversion.

## 4. TDD record - the RED

The headline test was written first, against a tree with no ladder, and failed
for the right reason:

```
FAIL test/groupRailService.test.ts > ensureGroupRail > BINDING PROPAGATION
LADDER (awaitBindingPropagation) > a fresh create whose bindings have not
propagated resolves with NO repair and no rail_failed
AssertionError: expected "spy" to not be called at all, but actually been
called 1 times
Test Files 1 failed (1) | Tests 1 failed | 22 passed (23)
```

That is the defect verbatim: with no ladder the short post-create list drove
`addParticipants` - the repair the propagation window never needed. Log:
`.superpowers/gates/s4-red-headline.log` (gitignored). The implementation then
took the same file to 23/23.

The fixture warning was honored: `createConversationWithParticipants` returns
the SHORT list, and `fetchParticipants` returns short until the Nth read. A
fixture returning the full list immediately would pass against no ladder at
all.

## 5. Which test pins which decision

All in `app/test/groupRailService.test.ts`, in one nested describe at `:675`.

- `:711` headline - D13: a propagating create resolves with NO repair
  (`addParticipants` asserted NOT called via a spy, not by relying on
  `makePort`'s throwing default - findings #8) and no `recordRailFailure`;
  waits `[500]`.
- `:736` - D15: a genuinely unbound member still repairs after both rungs;
  waits `[500, 1500]`, repair called with exactly the missing phone.
- `:782` - D14: the post-repair read ladders. Reads 1-2 are the validation
  ladder, read 3 the post-repair read (still short), read 4 the point-2 rung
  that completes; waits `[500, 1500, 500]`, no `rail_failed`.
- `:803` - D17: an ADOPTED rail ladders on NEITHER read. Zero sleeps and
  exactly 2 `fetchParticipants` calls (the `??=` read and the post-repair read).
- `:829` - D16: with the flag ABSENT neither read ladders, asserted on a CREATE
  path so `wasAdopted` cannot be what suppresses it - the flag is.
- `:849` - [RULING groupRail #1]: a throwing laddered re-read at point 1
  resolves `failed`, records the failure, RELEASES `rail_creating`, stamps no
  sid, and does not attempt the repair on the stale list.
- `:892` - point 2's throw still lands in the pre-existing repair catch; the
  ladder added no new escape.
- `:934` - findings #3: a re-read that reveals a projected participant with a
  PREVIOUS business number drives `removeParticipant` (the `staleAuthors` path).
  `authorPresent` is deliberately not the assertion - on the create path its
  `!wasAdopted` arm short-circuits, so a re-read cannot change it; the default
  throwing `addProjectedParticipant` is what proves no attach was attempted.
- `app/test/groupRailJob.test.ts:77` and
  `app/test/importConvertGroups.test.ts:508` - the two opted-in callers with a
  test harness pass the flag. Both fakes now record the WHOLE request
  (`requests: GroupRailRequest[]`) alongside the existing `calls: string[]`,
  which every other case in those files still asserts against unchanged.
- `app/scripts/rail-verify.ts` has NO test harness. Verified by reading the
  request object at `:198-207`; recorded here per the worklist.
- `groupSend`'s two callers were verified by GREP, not by a test - the slice's
  file scope excludes `app/test/groupSend.test.ts`.

## 6. Gates

Run from the worktree; never piped; output redirected and read afterwards.

- `npm run typecheck` (worktree root) - exit 0, no error lines.
  `.superpowers/gates/s4-typecheck-2.log`.
- `npx vitest run test/groupRailService.test.ts test/groupRailJob.test.ts
  test/importConvertGroups.test.ts` (from `app/`) - exit 0,
  "Test Files 3 passed (3) | Tests 73 passed (73)".
  `.superpowers/gates/s4-vitest.log`.
- `npx eslint` on the seven touched files - exit 1, ONE error, PRE-EXISTING and
  not attributable to this slice:
  `app/src/lib/import/convertGroups.ts:32 'ConversationParticipant' is defined
  but never used`. Attribution by baseline: `git show
  main:app/src/lib/import/convertGroups.ts` contains that identifier exactly
  once, at the same import line, so it is unused on main too; this slice's diff
  to that file is confined to `:429-437` and removes no use of it. Named here
  so the next reader does not re-diagnose it. `.superpowers/gates/s4-eslint.log`.

The full `npm test` and `npm run e2e` were deliberately NOT run - the
orchestrator owns those.

## 7. Deviations

1. The two fake widenings are 5-6 lines each rather than the "one line" the
   research estimated. Replacing the pushed value would have broken every
   existing `expect(rail.calls).toEqual([...])` in both files, so the whole
   request is recorded in a NEW `requests` array beside the untouched `calls`.
2. `bindingFixture` in the service suite takes a second optional
   `Partial<GroupConversationsPort>` argument so the adopt-path case can add
   `fetchByUniqueName` without duplicating the fixture. Not a contract change.
3. `app/src/jobs/groupRail.ts:59` was reformatted from a single line to a
   multi-line object literal; the flag would otherwise have pushed an already
   103-character line well past the file's width.

Nothing in the worklist's S4 section had to be departed from, and no contract
mismatch was found: the try/catch boundary map, the `!wasAdopted` semantics,
the `participantMap`-vs-`participants` store, the fake shapes and the
`sleep?:` precedent all matched the live tree exactly.

## 8. What S6 and S7 must know

- S6, `isDeadRailState` (`app/src/services/groupRail.ts:259-262` before this
  slice; unchanged by it): its unenumerated default is NON-terminal - anything
  other than `closed`/`failed`, including `undefined` and any future Twilio
  state, reads as a live rail. It has TWO consumers, and their failure
  directions are opposite: at the adopt half an unknown state means the adoptee
  is KEPT rather than deleted, and at the post-create check an unknown state
  means the rail is FINALIZED. A sweep entry naming only one of them is
  incomplete.
- S7, `rail-binding-propagation-retry` is PARTIAL and must say so: the two
  `groupSend` paths (`services/groupSend.ts:381` inline backstop, `:425`
  `healRail`) keep today's behavior, the adopt path is excluded (D17), the
  refusal log noise is untouched (D18), and rail-verify's opt-in is inert
  except on delete-and-recreate (section 2 above).
- S7 should also carry the compounded-cost sentence from section 3: the ladder
  is bounded per POINT, not per CALL.
