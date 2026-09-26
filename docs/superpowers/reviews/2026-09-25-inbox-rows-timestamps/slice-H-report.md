# Slice H report - inbox rows + timestamps (post-merge count fix)

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`, from 887f0685 (the
one merge of `main`). Implementer: Claude Opus 5.5 (1M context). Touched
one file, `e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts`. The seed
and all other files were only read. Logs are in the ignored
`.superpowers/sdd/sliceH-*` files.

## Commit

- `7339fcca` test(e2e): inbox rows counts follow the merged lean seed (a
  fourth one-to-one). One explicit path, +47/-25.
- Before the commit, the bare `git status` showed only the spec. There was
  no MERGE_HEAD (`rev-parse -q --verify` printed nothing).
- The committed blob's sha1 is 06f3689c. That is the byte-identical file
  that runs 1, 3 and 4 ran.

## Why the counts moved

`main`'s share-skip-fix seeds Dario in the lean world
(`app/src/lib/seed/lean.ts:178-202`). His one-to-one thread is
`conv-0002` (`:275-288`): status `open`, `last_activity_at` TS0 =
2026-06-01T13:20Z (`:34`). That makes it older than Tasha (T2, 14:05:45,
`:20`), the group text (TG2, 13:45, `:29`) and the relay group (TC0,
13:30, `:30`). Nothing else from the merge touches the inbox:
`app/src/routes/inbox.ts` is unchanged by `main`.

- **Server** (`app/src/routes/inbox.ts`):
  - The pager takes `limit` contact rows from the `open` partition
    (`:2407-2475`, chunk size `:2365`).
  - It merges the relay and group rows on page one only (`:2491-2543`,
    `:2553-2602`).
- **Client**: it sorts every row newest first
  (`dashboard/src/routes/inbox/useInbox.ts:718`).
- **Result**: Dario uses one contact slot, and he is always the LAST
  rendered row.

## Counts changed (old -> new)

| Test | Line | Old -> new | Arithmetic |
|---|---|---|---|
| 2 | spec:186 | 6 -> 7 | 3 parties + Tasha + Dario = 5 contacts at limit=2, in pages of 2, 2, 1; + 2 multi-party rows on page one |
| 2 | spec:198 | 7 -> 8 | 6 contacts at limit=2, in pages of 2, 2, 2; + 2 |
| 2 | spec:209 | 7 -> 8 | 6 contacts at the default limit, all on page one; + 2 |
| 2 | spec:213 | 8 -> 9 | 7 contacts + 2 |
| 3 | spec:230, :254, :263 | 9 -> 10 | 6 parties + Tasha + Dario = 8 contacts, all on page one at limit=10; + 2 |
| 3 | spec:274, :282, :284 | 9 -> 10 | the same 8 contacts at limit=2, in pages of 2, 2, 2, 2; + 2 |
| 5 | spec:368, :376 | 4 -> 5 | 1 party + Tasha + Dario = 3 contacts + 2 |
| 5 | spec:384 | 5 -> 6 | 4 contacts + 2 |
| 6 | spec:412 | 38 -> 39 | 35 parties + Tasha + Dario = 37 contacts at limit=15, in pages of 15, 15, 7 |
| 6 | spec:403, :406 | unchanged: 17, 32 | Pages one and two hold minted parties only |

Comments changed:

- The header (spec:15-25) now describes the four lean rows and the paging
  rule.
- Test 1 (spec:167) now says "Tasha's 1:1".
- The count comments carry the arithmetic.
- Test 3 (spec:226-228) and test 6 (spec:397-401) name Dario as the last
  row.

No locator, minting block or non-count assertion changed.

**Probe run** (run 2, probes removed afterwards; the sha1 was checked
before and after):

- **Test 2**: the first chain was H, C, C, and the last row was
  `/contacts/contact-tenant-0002`. After the inbound: H, C, C.
- **Test 3**:
  - The order at limit=10 was 6 parties, Tasha, group text, relay, Dario.
  - Both clicks landed on `/contacts/contact-tenant-0002`.
  - At limit=2, 3 cursor requests came before the click.
- **Test 6**: Dario was absent at 17 and at 32. At 39 the tail was Tasha,
  group text, relay, Dario.

## Lane

- **Lane 16**: app :10601, dashboard :10611, fake :10621, public base
  :10631, prefix `hc-local-16-`, launcher pid 45544.
- **Before**: there was no `e2e/.artifacts/lane.json` and no
  `session.pid`, and `Get-NetTCPConnection` found no listener on the four
  ports.
- **Start**: `npm run e2e:session` ran in the background, logging to
  `sliceH-session.log`.
  - `db:create` created all 22 `hc-local-16-*` tables fresh.
  - The ready line was in the log after about 10 s (log line 132).
- **Stop**: `npm run e2e:stop` exit 0 (`sliceH-e2e-stop.log`). It stopped
  launcher 45544 and its children, dropped the `hc-local-16-*` tables and
  released the lease.
  - The background command then exited with code 1, because the stop
    killed it. Its log ends at the stop's `/__dev/ping`.
  - `lane.json` and `session.pid` are gone, and pid 45544 is gone.
  - There is no listener on the four ports. netstat shows TIME_WAIT only
    (1001), with no LISTENING or ESTABLISHED sockets.
- The commits were made only after the stop.

## Runs (the workspace command, lane 16)

| Run | File | Result | Tests 1-6 (s) |
|---|---|---|---|
| 1 | final bytes | 6 passed, 28.7 s | 2.5, 5.8, 4.6, 2.6, 3.3, 7.3 |
| 2 | with probes | 6 passed, 26.5 s | 2.3, 5.8, 4.6, 2.5, 2.7, 7.2 |
| 3 | final bytes | 6 passed, 27.2 s | 2.3, 5.7, 5.1, 2.6, 2.7, 7.3 |
| 4 | final bytes | 6 passed, 27.0 s | 2.3, 5.9, 4.7, 2.6, 2.7, 7.2 |

**Sibling** `group-text-inbox.spec.ts`: run once, directly after run 4's
`afterEach` reseed. 2 passed in 4.8 s: :33 took 1.5 s and :114 took
2.0 s (`sliceH-sibling-group-text-inbox.log`).

## Gates

| Gate | Result |
|---|---|
| `npm run typecheck -w @housingchoice/e2e` | exit 0, before the lane and again on the final bytes |
| `npx eslint` on the spec | exit 0, no output, both times |
| ASCII | 0 non-ASCII bytes in the added lines and 0 in the whole file |

## Worth an eye

- **The group-text-inbox issue's premise is now false.** In slice G, the
  sibling :33 failed deterministically after a reseed. It now passes,
  because Dario puts a second one-to-one in the `open` partition, so
  `filter=all&limit=1` returns a cursor (`group-text-inbox.spec.ts:92-96`).
  - `docs/issues/group-text-inbox-spec-depends-on-leftover-conversations.md`
    says the partition holds ONE conversation. That is no longer true on
    this branch or on `main`.
  - The coupling moved rather than went away. The guard now rests on Dario
    staying in the `open` partition, not on a partition the test controls.
  - The issue needs a re-triage: close it, or restate its premise. I did
    not edit it (out of scope).
- **Test 3's destination changed.** Both last-row clicks now open Dario's
  contact page, where they used to open the relay group's
  `/conversations/...` page (slice G run 4).
  - The first half parks the destination at the top (spec:249), so the
    restore check does not depend on the page's height. The second half
    asserts no scroll.
  - Dario is share-skip-fix's switched-off tenant. His seed comment bars
    automated sends to him (`lean.ts:179-187`). This spec only navigates
    to his page and never sends him anything.
- **Both end-of-chain shapes are now exercised.**
  - Test 2's first chain ends on a short page, after page two fills
    mid-chunk at Tasha (the boundary re-query path).
  - Test 3's limit=2 chain ends on an exactly full page (Tasha, Dario)
    with no LastEvaluatedKey, so no empty trailing request is made.
  - Both behave correctly. I note them only because the shapes differ
    from slice G's.
