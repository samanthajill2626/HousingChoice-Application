# T10 - issue registry stamp

Commit: `d4a45604` docs(issues): resolve the M1 name-snapshot issues; correct
the helper census; file the staff-only readers (6 files, +239 / -26). Docs only;
no code touched.

## Per issue

| issue | status | what was stamped |
| --- | --- | --- |
| `today-shows-phone-instead-of-name` | open -> **resolved** (+ `resolved: 2026-09-01`) | Resolution: option 1; `whoOfConversation` resolves from the contact the deleted-check already memoized (zero new reads) -> stored name -> phone; the dashboard offline fallback's non-empty guard; no backfill, writers unchanged |
| `group-roster-name-snapshot-never-refreshed` | open -> **resolved** (+ `resolved: 2026-09-01`, `refs` gains `lib/participantNames.ts`) | Resolution: shape 1, read-time resolution, one batch per page, the eight covered surfaces, zero added reads where the contact was already held, the drift audit; then a seven-bullet NOT-covered list (see divergences 4 and 5) |
| `relay-stale-participant-phone` | open -> **resolved** (+ `resolved: 2026-09-01`, `refs` filled in - it was empty) | Resolution: 2026-08-31 ruling, option (a) remove-and-re-add, no code change; `withLiveNames` replaces only `name`, never `phone`; reopen only if the blessed remedy changes |
| `consolidate-contact-display-name-helpers` | stays **open** (+ `updated: 2026-09-01`) | `title:` six -> thirteen; `refs:` six paths -> the canonical helper plus all thirteen copies with line numbers; census paragraph replaced with the thirteen sites (each with its function name), the two non-mechanical ones (`inbox.ts` extra `contact.name` rung, `today.ts` outer-join-only trim), `voiceMasking.ts contactShortName` as NOT a copy, and the widened `ContactDisplayItem` signature with its four consumer groups; two downstream count words fixed ("the sixth copy"/"five private helpers") |
| `today-contact-hydration-fan-out` | stays **open** (+ `updated: 2026-09-01`) | Measured paragraph: N = 1 distinct contact (1 call) per `GET /api/today` in the `todayApi.test.ts` harness, instrumentation not committed; why that does not close it (it sizes the harness, not the imported dataset the issue's own rule names via the human-only `perf:pages`); that the branch added ZERO reads and the close-nag names cost one batch, not per-member gets; the close condition |
| `staff-only-roster-name-readers-stale` | **created**, `debt` / `low` / `open` / `app` / `created: 2026-09-01` | The three readers with verified line numbers, why severity is low, and a per-site fix note |

## `npm run issues`

`cd W:\tmp\participant-snapshot-refresh; npm run issues` - **exit 0**.

```
[issues] 274 open, 161 closed, 435 total -> docs/issues/INDEX.md
[issues] open by severity: 9 high - 118 med - 147 low
[issues] 1 warning(s):
  - perf-selfqa-route-contract-drift.md: unknown severity "medium"
```

One warning, on a file this slice did NOT touch (pre-existing, `severity:
medium` where the schema wants `med`). Zero warnings for the six files above.
`INDEX.md` is gitignored and was not committed.

## Verification

- ASCII: `tr -d '\11\12\15\40-\176' < <file> | wc -c` prints **0** for all six
  files, the new one included. All five pre-existing files were already fully
  ASCII, so the whole-file check covers the added lines.
- Fixture grep, run here rather than taken on trust:
  `grep -rn "Synthetic tenant\|Synthetic participant\|Synthetic landlord" app/test e2e app/scripts`
  -> exit 1, **zero hits**. No fixture work. Stated in the commit body.
- Bare `git status` before the commit listed exactly the five modified issue
  files plus the one untracked new one. `MERGE_HEAD` absent. Explicit paths
  staged; no `git add -A`.
- Every line number written into an issue was opened and read first. Corrections
  made against the plan's text: `groupSend.ts` `memberLabel` is at `:252` (plan
  said `:253`); `relayGroupDuplicates.ts` `rosterMembers` is at `:68` and its
  `.name` read at `:128`, so the issue cites `:128` in `refs` and names `:68` in
  the body; `poolNumbersAdmin.ts` `serverLabel` is at `:108` (plan said "near
  :109"); the close-group dialogs' `.name` reads are at
  `PlacementDetail.tsx:373` / `TourDetail.tsx:454` (the plan's `:370` / `:451`
  are the `getConversation` calls two lines up), and both files live under
  `dashboard/src/routes/placements/` and `.../tours/`, not the singular paths
  the plan wrote. The two group push titles are `twilio.ts:730` and `:1813`.

## Divergences from the plan

1. **`status: closed` is invalid** (worklist override a). `scripts/issues.mjs:18`
   allows `open | in-progress | deferred | resolved | wontfix`. All three
   closures use `status: resolved` + `resolved: 2026-09-01` + the Resolution
   paragraph, per `_TEMPLATE.md:25-26`.
2. **`today-contact-hydration-fan-out` stays OPEN** (worklist override b). The
   plan's "close if N < 30" invented a threshold the issue does not have; the
   issue's rule names `npm run perf:pages` against the imported dataset, which
   is human-invoked. Stamped as `**Measured ...**`, not `**Resolution ...**`.
3. **`consolidate-contact-display-name-helpers` frontmatter fixed too** (worklist
   override c) - the plan only named the body paragraph, but `title:` and
   `refs:` still said six.
4. **The residue list gained `GET /api/conversations` and the SSE roster**
   (worklist override d), both adjudicated out of scope by spec decision 4
   (research-adjudications D-F1 / D-F2).
5. **The residue list also gained the outbound relay sender prefix, which the
   plan's text did not name - read this one.** The plan's resolution sentence
   said the intro/member-added bodies "were rewritten by
   `feat/tour-reminder-ladder-phase-b`", which reads as though the outbound half
   of this issue is gone. It is not. `jobs/relayFanOut.ts` still composes from
   the STORED roster names at `:774` (sender prefix), `:1018-1021` (intro) and
   `:1082-1086` (member-added). Phase-b rewrote the COPY, not the name source.
   Spec decision 6 puts outbound content out of scope, so nothing is owed by
   this branch - but this issue carried `high` severity precisely for that
   outbound reach, and closing it on a sentence that implies the reach is gone
   would have been dishonest. The bullet now says plainly which sites still read
   the snapshot, that the intro/member-added drift window is only a rename
   between provisioning and the job firing (the roster name is written from the
   live contact seconds earlier by `relayMembers.resolveMemberName`), that the
   sender prefix is the durable one because it is read for the life of the
   group, and that a stale name on a relayed message is the signal to reopen.
6. **`relay-stale-participant-phone` got `wontfix`-shaped content under
   `status: resolved`.** The task named `resolved` for all three, and both are
   closed statuses in the index, so the file follows the instruction; `wontfix`
   would arguably fit a "documented behavior, no code change" ruling better.
   Trivially changeable if the orchestrator prefers it.
7. **The new issue's fix note is per-site, not the plan's single sentence.** The
   plan said "`withLiveNames` over the roster with one `getDisplaysByIds`" for
   all three. Reading the code changed the advice: `groupSend`'s refusal loops
   already destructure `{ member, contact }` from `resolved` (`:319-331`), so
   that fix costs ZERO reads and needs no batch; `findOpenGroupWithSamePhones`
   takes `{ conversations, log }` with no contacts repo and has a NEVER THROWS
   contract, so a read there needs a new dependency inside that boundary; and
   `poolNumbersAdmin`'s `serverLabel` is a sync per-conversation label reached
   through `relayMemberLabels`, whose SCOPE GUARD docblock forbids re-pointing
   it at the inbox/push chain. Both the generic recipe and the per-site notes
   are in the file.

## Open worries

1. **Divergence 5 is the one to look at.** The branch closes an issue whose
   stated severity driver (a stale name reaching outbound message content) is
   still live at `relayFanOut.ts:774`. That is a legitimate scope decision, and
   the spec says "no issue is filed" - but no issue is filed, so the only record
   of it is the Resolution bullet. If the orchestrator wants a durable ticket
   for the sender prefix, it needs a `docs/issues/` file this slice was not
   scoped to create.
2. `perf-selfqa-route-contract-drift.md`'s `severity: medium` warning is
   pre-existing and out of scope; it is a one-word fix (`medium` -> `med`) for
   whoever owns that file.
3. The `refs:` line on `consolidate-contact-display-name-helpers` is now 14
   entries long. It is accurate and the schema allows it, but the line numbers
   will rot faster than the function names beside them in the body; the body is
   the authority if they disagree.
4. Nothing here was gate-verified beyond `npm run issues` - by instruction, no
   typecheck / unit / smoke / e2e run for a docs-only slice. Gate 5 (eslint)
   does not apply: the branch's own file list for this commit is Markdown only.
