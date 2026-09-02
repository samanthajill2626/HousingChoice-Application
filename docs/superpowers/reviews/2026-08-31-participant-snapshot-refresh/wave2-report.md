# Wave 2 report (2026-09-01)

Commit: `7b9450e6` - "test(names): pin the tag-vs-hydrated-names call and the
relay push arm; audit counts kept stored names". Six files, 118 insertions, 5
deletions. Exactly the four adjudicated items; no read or write path changed.

## Item 1 - R2-1 pin + carve-out comment

`app/test/inboxGroups.test.ts`, M1 describe: "PIN: a tagged, snapshot-nameless
roster titles by the CONTACT names once hydrated (tag only ever beat raw
digits)". A relay conversation carrying `placement_tag: 'Maple St - Dana'` whose
two members store NO name but hold contactIds resolving to `Ana Reyes` /
`Ben Ortiz`; filter `all`; asserts `'With Ana Reyes & Ben Ortiz'` and NOT the
tag. Whole names, not first names - the relay chain does not shorten.

PASSED un-sabotaged on the first run (21/21 in the file), as a declaration-pin
should. Discrimination proved by a THROWAWAY sabotage: `app/src/routes/inbox.ts`
`:1162` temporarily fed `conv.participants` raw instead of
`withLiveNames(conv.participants, names)`.

Sabotaged run:

```
FAIL test/inboxGroups.test.ts > roster names resolve on read (M1) > PIN: a
tagged, snapshot-nameless roster titles by the CONTACT names once hydrated
(tag only ever beat raw digits)
AssertionError: expected 'Maple St - Dana' to be 'With Ana Reyes & Ben Ortiz'
Expected: "With Ana Reyes & Ben Ortiz"
Received: "Maple St - Dana"
 Test Files  1 failed (1)
      Tests  2 failed | 19 passed (21)
```

The tag IS the received value - the pin bites on exactly the rung R2-1 named.
The second failure is the sibling M1 relay test ("titles a relay row from the
contact name", received `"With Ann Tenant"`), which the same sabotage also
breaks; expected.

Reverted, re-run green:

```
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

`git status --porcelain app/src/routes/inbox.ts` was empty after the revert. The
sabotage was never staged or committed.

Comment: `app/src/lib/groupTitle.ts` tag carve-out now records that hydrated
callers (inbox rows, contact cards) have fed it live names since 2026-09-01, so
the tag yields to a read-time-resolved name exactly as it always yielded to a
stored one - the rung unchanged, its input fresher.

## Item 2 - R2-2 pin

`app/test/inboundMessagePush.test.ts`, relay describe: "PIN: the relay push body
prefix prefers the live CONTACT name over the stored roster name". Reuses the
describe's own idioms - `seedRelay(world, { participants: [...] })` with the
sender's stored name aged to `Old Alice`, a non-deleted `world.contacts` entry
`c-alice` = `Alicia Live`, one `relayInboundParams()` post, `soleMessagePayload`.
Asserts the body only; the TITLE still renders the stored snapshot by decision,
and the comment above the test says so.

PASSED un-sabotaged (23/23 in the file). Sabotage: rungs reordered in
`pushSenderLabel` (`app/src/routes/webhooks/twilio.ts`) so the roster name is
tried before the live contact.

Sabotaged run:

```
FAIL test/inboundMessagePush.test.ts > inbound message push - relay group >
PIN: the relay push body prefix prefers the live CONTACT name over the stored
roster name
AssertionError: expected 'Old Alice: is the unit available?' to be
'Alicia Live: is the unit available?'
Expected: "Alicia Live: is the unit available?"
Received: "Old Alice: is the unit available?"
 Test Files  1 failed (1)
      Tests  2 failed | 21 passed (23)
```

Received `'Old Alice: ...'` exactly as predicted. The other failure is the
existing group-arm sibling ("RED: the body prefix prefers the CONTACT name over
a stale roster name", received `"Old Ana: ..."`) - the same reorder breaks both
arms, which is the point: the new test covers the relay arm the group test never
reached.

Reverted, re-run green:

```
 Test Files  1 passed (1)
      Tests  23 passed (23)
```

`git status --porcelain app/src/routes/webhooks/twilio.ts` empty after revert.

## Item 3 - R2-4 `nameOnlyStored` (TDD, red first)

RED. `app/test/rosterDriftTally.test.ts`'s "classifies every member exactly
once" gained a member `{ contactId: 'c-nameless', phone: '+7', name: 'Kept
Name' }` against a present, non-deleted, NAMELESS contact, with the expected
tally bumped to `members: 8, withContactId: 7` plus `nameOnlyStored: 1`. Run
before any implementation:

```
FAIL test/rosterDriftTally.test.ts > tallyRosterDrift > classifies every member
exactly once
AssertionError: expected { rosters: 2, members: 8, ...(6) } to deeply equal
{ rosters: 2, members: 8, ...(7) }
-   "nameOnlyStored": 1,
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

The counter was the only difference - `members` and `withContactId` already
matched, so the red is on the missing bucket alone.

GREEN. `app/src/lib/rosterDriftTally.ts` adds `nameOnlyStored` to the interface
(with the reason: the read path PRESERVES this population rather than masking
it, because `withLiveNames` only overwrites a stored name with a live one it
found) and one `else if (want === undefined && have !== undefined)` at the END
of the existing name chain. Precedence is untouched - `noContactId` ->
`danglingContactId` -> `deletedContact` -> `nameMissingButKnown` ->
`nameDrift` -> `nameOnlyStored` - so `nameMissingButKnown` and `nameDrift` keep
their exact meanings and every member still lands in at most one bucket. The
fourth combination (neither side named) remains reported nowhere past
`withContactId`, unchanged and noted in a comment.

`app/scripts/measure-unread-contact-coverage.ts` prints one new line inside the
"with contactId" block, column-aligned with its siblings:

```
      name only STORED    N  <- contact readable but nameless; the stored name stands (kept by design)
```

## Item 4 - R2-12 comments

`groupThreadLabel`'s docblock and the module header now carry the input
contract: these functions render whatever roster the caller passes and read no
contact; hydrated callers go through `lib/participantNames` first (inbox rows,
contact cards) while the webhook push titles pass the stored snapshot by
decision.

Comments-only proof - `git diff -U0 app/src/lib/groupTitle.ts` filtered to
changed lines that are NOT comments returned NOTHING. All three hunks are inside
`//` or `/** */`; zero code tokens changed. The added carve-out line from item 1
is included in that proof.

## Verification

```
cd W:\tmp\participant-snapshot-refresh\app
npx vitest run test/inboxGroups.test.ts test/inboundMessagePush.test.ts test/rosterDriftTally.test.ts
 Test Files  3 passed (3)
      Tests  46 passed (46)
exit 0
```

```
cd W:\tmp\participant-snapshot-refresh
npm run typecheck        (BARE)
exit 0
```

Typecheck covers the audit script through `tsconfig.scripts.json`. Gate 5 spot
check on the six touched files (`npx eslint <six paths>`) also exited 0 - not a
substitute for the branch-wide gate at handback time, just evidence wave 2 adds
no lint error.

Added lines are ASCII-only (checked over the whole staged diff).

## For the verifier

- The pins were EXPECTED to pass on first run and did; the discriminating
  evidence is the sabotage pair above, not a red-then-green.
- Both sabotages also broke one pre-existing sibling test each. Those siblings
  are the R2-13 "half of a pair" tests; nothing about them changed.
- `docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/code-review-round2-adjudications.md`
  was ALREADY untracked when wave 2 started (it is the input this wave worked
  from). Wave 2 did not create it and did not commit it - it is still untracked
  and still owed a commit by whoever produced it.
- Still open from round 2 and NOT wave-2 work: R2-3 (record correction only, no
  code), R2-17 (rejected), the R2-19 `_CLUSTERS.md` lines (planning-side, not
  edited from this branch), and the handback items - the inbox-vs-push tag
  divergence for Cameron, and R2-1's "one-line precedence change filed as its
  own issue" if he wants tag-over-names.
- Next per the adjudications: narrow fresh verification, then P5 self-QA (the
  audit lane run now reports `nameOnlyStored`), then the single main sync and
  the full gate battery on the synced commit.
