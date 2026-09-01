# T4 - contact page group cards (relay groups, group threads)

Commit: `f3a17bf9` - feat(contacts): group cards resolve member names with one batch per card

Files: `app/src/routes/contacts.ts`, `app/test/contactRelayGroups.test.ts`,
`app/test/contactGroupThreads.test.ts`. Nothing else touched.

## Red

`cd app; npx vitest run test/contactRelayGroups.test.ts test/contactGroupThreads.test.ts -t "RED"`
-> `Test Files 2 failed (2) / Tests 3 failed | 20 skipped (23)`, all three as the
plan predicted:

```
FAIL test/contactGroupThreads.test.ts > RED: title and otherMemberNames use the contact name over the stored snapshot
AssertionError: expected 'With Marcus' to be 'With Marc'

FAIL test/contactRelayGroups.test.ts > RED: otherMemberNames come from the OTHER members contacts, not the stored snapshot
AssertionError: expected [ 'Old Landlord' ] to deeply equal [ 'Lena Landlord' ]

FAIL test/contactRelayGroups.test.ts > RED: ONE batch per card, over exactly the ids of the groups this contact is in
AssertionError: expected [] to have a length of 1 but got +0
```

## Green

`cd app; npx vitest run test/contactRelayGroups.test.ts test/contactGroupThreads.test.ts`:

```
 Test Files  2 passed (2)
      Tests  23 passed (23)
```

`npm run typecheck` (bare, worktree root): `EXITCODE=0`.

`npx eslint app/src/routes/contacts.ts app/test/contactRelayGroups.test.ts app/test/contactGroupThreads.test.ts`:
`EXITCODE=0` (gate 5 is the orchestrator's; run here only over the touched files).

`contactsApi.test.ts` does not exist in this tree. Grep for `relay-groups` /
`group-threads` across `app/test` shows only these two suites exercise the two
contact-card routes; the other three hits are `POST /api/relay-groups` in
`routes/relayGroups.ts`, which T4 does not touch.

## Divergences from the plan

- Group-threads test uses the worklist's B-F2 correction: the renamed contact is
  `firstName 'Marc' / lastName 'Renamed'`, expecting title `With Marc` and
  `otherMemberNames ['Marc Renamed']`. The plan's 'Marcus Renamed' would have
  been vacuous - `groupThreadLabel` takes the FIRST token, so both stored and
  live names title `With Marcus`.
- Relay-groups replace region started at `:1188` (`for (const status of ...)`),
  per the worklist, not the plan's `:1189`.
- New import placed after `:27` (`groupTitle.js`) - the `../lib/` imports are not
  contiguous.
- The truncation `log.warn` string moved with the loop and its two em dashes
  became ASCII hyphens ("page budget - older groups"), exactly as the plan's
  replacement block quotes it. No test asserts that string; a log-string grep
  elsewhere would not match the old form.
- The surviving loop body (`tag`, the carve-out, `groups.push`) was re-indented
  one level (the double loop became one loop) and `otherMemberNames` now fits on
  one line. No logic change; `memberCount` still counts the full roster, since
  `withLiveNames` preserves length.

## Open worries

- The one-batch assertion is enforced only on the relay card (three partitions,
  the real regression risk). The group-threads card reads one partition, so a
  future batch-per-row shape there would still pass its test. Cheap to add later
  if the orchestrator wants symmetry.
- `mine` on the relay path holds `{ status, conv }` pairs so a group that somehow
  appears in two partitions would be rendered twice - the pre-change code had the
  same property, and `relay_status` is written in lockstep with `status`, so this
  is unchanged behavior, not new exposure.
- Batch read is best-effort by contract (`resolveRosterNames` never rejects, and
  `getDisplaysByIds` can return a short map): an unresolved member keeps its
  stored name. That is the intended chain, but it means a throttled read degrades
  silently to today's behavior with one warn.
