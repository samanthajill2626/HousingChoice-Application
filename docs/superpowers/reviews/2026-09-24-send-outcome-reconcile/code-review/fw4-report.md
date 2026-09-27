# Fix wave FW4 - round 2's fixes: never_sent needs a complete walk; comments and log text

Implementer: Claude Opus 5.5 (1M context). Worktree `W:\tmp\send-outcome-reconcile`,
start HEAD c8193fc2 (code af848977), end HEAD 4eef5efa. Scope: `r2-adjudications.md`
section 1 (FW4-1, FW4-2). About 37 minutes used (15:08-15:45 EDT). The tree is
clean; no MERGE_HEAD at any commit; the fenced files (twilio.ts, jobs.ts,
sqsJobConsumer.ts, retrySend.ts, the run-once marker) are untouched.

Record note: the implementer returned this report as TEXT (the harness refuses
report files from implementer subagents); the orchestrator landed it here with
its checkpoint appended, per AGENTS.md.

Short version: both items are done. never_sent now needs a complete walk. The
rejection log lines no longer claim "recipient failed" over a recipient that is
still carried. 17 of 17 mutants were killed. Every gate asked for is green.

## Commits

- `610e46ba fix(jobs): send.reconcile rules never_sent only on a COMPLETE walk - the early stop runs before the last check only, and a walk cut at the page bound judges what it read at every check (code review round 2 R2C-1 / F-1, A-2; FW4-1)`
- `5d373ae9 fix(jobs): comments and log text only - a broadcast strand in pass 2/3 or a re-drive pass waits for the sweeper; a rejection whose slot write threw logs the carry, never "recipient failed"; the rung's stranded ERROR names both causes; the relay chip comment names the D20 sentence (code review round 2 F-2, F-4, R2C log wording, N-1; FW4-2)`
- `4eef5efa test(jobs): pin FW4-1 rule (d)'s cause order - on a complete last-check walk an unmatched candidate decides (unidentified_candidate) ahead of an open same-fingerprint sibling (FW4-1 mutant pass, M10)` - test-only; it closes the one gap the mutant pass found.

## FW4-1 (app/src/jobs/sendReconcile.ts, `lookup`) - file:line at HEAD

- :799-814 - the comment above the walk says what the stop may and may not
  prove. It MAY prove that the pages already read are in createdAt order and
  have walked behind the window. It may NOT prove anything about the unread
  pages: a list sorted on another key can still hold a newer message on a
  later page (DateSent; a still-queued orphan has no date_sent). So the stop
  only defers: it runs on checks 0-1 and saves their cost; the last check never
  stops early.
- :817-820 - `let cut = false`: a walk cut at the bound still judges what it
  read and never rules never_sent.
- :844 - the early stop is gated `!last` (rule a).
- :846-849 - the bound sets `cut = true; break` and no longer returns before
  judging (rule b).
- :879 - nothing adopted before the last check: `continue` with reason
  page_bound if cut, else nothing_adoptable (as today).
- :880 - at the last check a cut walk is unresolved page_bound, with extra
  `{ pages }` (rules c and d).
- :881 onward, unchanged: unidentified_candidate, then
  same_fingerprint_sibling, then never_sent - reached only by a complete walk.

New tests (app/test/sendReconcile.test.ts, "the broadcast owner"; helpers
`scriptList` at :866 and `listed`). The failing lines come from the red run
against the unchanged source; the line numbers are the test file's at that run.

- A :884 "R2C-1 / F-1: page 1 newest-first and wholly older than the window,
  our orphan on page 2 - checks 0-1 stop early and continue; the LAST check
  walks on, reads page 2 and adopts: found, no re-drive (FW4-1)". Failed at
  :885 `expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome:
  'adopted', sid: 'SMorphan-q' })` - "AssertionError: expected { ...(11) } to
  match object { state: 'done', ...(2) }", received state "redriven" (the
  double text).
- B :912 "FW4-1: the orphan BEYOND the page bound at the last check - the walk
  goes on to the bound and closes unresolved page_bound: never never_sent,
  never a re-drive". Failed at :911, same shape: expected
  done/unresolved/page_bound, received state "redriven".
- C :940 "FW4-1: a CUT walk (a list longer than the bound) judges what it read
  - an orphan on page 1 is adopted at check 0, not deferred to a page_bound
  close". Failed at :935: expected done/adopted, received state "reconciling".
- D :961 "FW4-1: a cut walk at the LAST check still judges what it read - an
  orphan the list shows only by then (on page 1 of a list longer than the
  bound) is adopted, not closed page_bound". Failed at :961: received outcome
  "unresolved" (page_bound), expected adopted.
- E :987 "FW4-1: a COMPLETE walk at the last check reads past the early stop to
  the list's end: nothing in the window is never_sent (ONE re-drive); an
  unmatched candidate it reaches there is unidentified_candidate, ahead of an
  open same-fingerprint sibling". Failed at :984 "AssertionError: expected [
  undefined, undefined, undefined ] to deeply equal [ undefined, undefined,
  ...(3) ]" (the old last check read one page). Its never_sent verdict is the
  same as on the old code - what it pins is the complete walk; its second
  phase also fails under mutant M01 (the last-check stop restored). The
  sibling clause was added in 4eef5efa: it passes on af848977's cause order by
  design and kills M10.

"A complete walk still reaches never_sent" - existing pins that hold it: test
11 "an empty window through all three checks is never_sent"; 13b's second half
(61 s before the attempt: re-driven); 8c, 8d, 8e, F-1; plus the new E and the
restated 10b (both multi-page).

Restated pins:

- R1 "the early stop wins over the bound ... (FW1-6)", now at :778. Old: check
  0 reads 5 pages and adopts SMorphan-5 - under af848977 that adoption proved
  the stop fired before the bound, because a cut walk returned before judging.
  New: the same, plus a second recipient of the same shape with nothing of
  ours: check 0 reads 5 pages, the record stays reconciling at checkNo 1, and
  the only continue reason is 'nothing_adoptable' (never page_bound). Why: rule
  (b) makes the adoption blind to the order. Probe Q1 (bound checked before the
  stop) SURVIVED 115/115 before the restatement and is KILLED after.
- R2 "10b a list of exactly five pages ...", now at :1817. Old: check 0 reads 5
  pages and adopts the page-5 orphan (proof that no sixth page means no cut).
  New: the same, plus exactly five pages all behind the window: checks 0-1 stop
  at page 1; the last check walks all five (7 list calls in total), reaches the
  end, and rules never_sent (ONE re-drive), never page_bound. Why: rules (b) and
  (c). Probe Q2 (cut at page 5 with no next page) SURVIVED 115/115 before and is
  KILLED after.
- Test 10 :671 - expectation unchanged; only its comment at :702 is refined
  (the cut walk judges first; nothing there is ours).
- No existing pin failed after the fix. No pin encoded the last-check early
  stop directly: every FW1-6 pin runs check 0 only, except test 10, which still
  passes.

## FW4-2 - file:line at HEAD (comments and log text only; every write and the carry unchanged)

broadcastFanOut.ts docblocks: only a pass-1 strand is old enough (the 10 s +
20 s ladder against the 30 s TTL) to be taken over by the last pass or at the
cap; one in pass 2 or 3, or in any re-drive pass, stays `attempting` and the
share stays Sending until the sweeper (`send-attempt-sweeper`).

- :401-415 closeBroadcast (the "release write failed still reaches a verdict at
  the cap" twin).
- :586-596 handToReconcile ("a later pass's claim takes the stale record over").
- :672-684 onRejected.

onRejected log lines: each arm's outcome line is now logged only when its slot
write resolved - :705-707 the 30007 ERROR; :727-729 the 30005/30006 WARN (the
sms_unreachable flag write stays unconditional); :746-751 the generic "send
rejected by the provider - recipient failed, NOT retried" WARN. On the throw
path, :752-760 logs one WARN: "broadcastFanOut: provider rejection not recorded
- its slot write failed; the recipient is carried with the attempt still open".

Other files:

- relayRetryLeg.ts:932-952 - the stranded comment and ERROR cover both causes
  FW2-2 routes there. New text: "relayRetryLeg: retry leg stranded - a
  failure-arm write failed (its hand-off to reconcile, or the slot write of a
  terminal close); the attempt stays open, left for the sweeper".
- dashboard/src/routes/contact/deliveryStatus.ts:625-630 - the comment says the
  reason leads with the failed legs' reasons, then the send_unconfirmed D20
  sentence (FW2-9).

FW4-2 pins (each failed first against the unchanged source; line numbers from
that run):

- broadcastFanOut.test.ts "C-2 (probe P1): a 21211 ..." (now :2255), with
  assertions added: failed at :2272 "expected [ { level: 40, ...(14) } ] to have
  a length of +0 but got 1".
- "C-2: the known arms (30007) ..." (now :2278): failed at :2292 "expected [ {
  level: 50, ...(13) } ] ... +0 but got 1".
- NEW "C-2 / FW4-2: a 30005 whose slot write throws still flags the contact,
  but logs only that the recipient is carried - never "recipient failed"" (now
  :2298): failed at :2311 "expected [ { level: 40, ...(13) } ] ... +0 but got
  1".
- relayRetryLeg.test.ts, both rows of it.each "stranded (afterSend=%s) ...":
  failed at :1559 "expected 'relayRetryLeg: retry leg stranded - i...' to
  contain 'its hand-off to reconcile, or a termi...'" (the pin was reworded
  afterwards to avoid an apostrophe in the source string; the old message
  cannot contain the new phrase either, so it still fails there).
- 13b (:1765) now pins the three success-path lines once each and no carry
  line; it passes on the unchanged code by design.

## Log-text grep (before changing; infra/, e2e/, scripts/, app/, dashboard/, plus fake-twilio/)

- "send rejected by the provider - recipient failed, NOT retried":
  broadcastFanOut.ts (the target); relayFanOut.ts:2206, the relay twin, which
  already logs only after its slot write resolved (untouched);
  e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts:475 polls the
  substring "send rejected by the provider" for the success line (errorCode
  21211, status 400) - that text is unchanged, and the new carry line does not
  contain the substring.
- "carrier filtering (30007) - recipient failed, NOT retried":
  broadcastFanOut.ts and relayFanOut.ts:2180 (untouched);
  app/test/relayFanOut.test.ts:2409 (relay test, unaffected); twilio.ts:3761
  has different text (fenced, untouched).
- "invalid number/landline ...": broadcastFanOut.ts only.
- "retry leg stranded - its hand-off to reconcile was not written; left for the
  sweeper": relayRetryLeg.ts only; no test pinned the text.
- infra: no match for any of these texts. The only log metric filters
  (infra/modules/observability/main.tf:40, :56, :79, :95, :111) key on
  correlationId, `$.level >= 50` and three event names - so no message was left
  unchanged because of infra. Level impact: on the 30007
  slot-write-throw double fault the path now logs 1 ERROR (guardWrite
  rejectSlot) instead of 2.

## Mutants (FW4-1 lines)

Each mutant written from a pristine copy by a runner that restores the original
bytes in `finally`, checked by Buffer compare and by `cmp`; target
test/sendReconcile.test.ts; the final pass ran against the final test file;
`git diff --quiet HEAD -- app/src` held after every batch.

| Mutant | Result | Change | Killed by |
|---|---|---|---|
| M01 | KILLED | (a) last-check early stop re-enabled | A, B, E, 10b |
| M02 | KILLED | (a) inverted: stop only at the last check | ADV-4, ties, early-stop-wins, A, B, E (7 failed) |
| M03 | KILLED | (b) return before judging at the bound, every check (af848977 shape) | C, D |
| M04 | KILLED | (b) same, last check only | D |
| M05 | KILLED | (b) same, before the last check only | C |
| M06 | KILLED | (c) never_sent allowed on a cut walk | 10, B |
| M07 | KILLED | (c) bound breaks without marking cut | 10, B, D |
| M08 | KILLED | (d) unidentified_candidate before page_bound | 10 |
| M09 | KILLED | (d) page_bound after the sibling rule | 10 |
| M10 | KILLED | (d) sibling before unidentified_candidate | E (SURVIVED 115/115 until the 4eef5efa pin) |
| M11 | KILLED | cut before the last check continues nothing_adoptable | 10, D |
| M12 | KILLED | cut closes page_bound before the last check | 10, D |
| M13 | KILLED | page_bound drops `pages` | B |
| M14 | KILLED | bound before the stop | restated R1 |
| M15 | KILLED | cut at page 5 with no next page | restated R2 |
| M16 | KILLED | inclusive edge on the stop | exact-edge test |
| M17 | KILLED | order check ignored | non-monotonic test |

17 of 17 killed.

## Gates (bare, output to scratch files, exit read right after)

At the final HEAD 4eef5efa:

- The 5-file set (sendReconcile, sendReconcile.integration, broadcastFanOut,
  relayFanOut, relayRetryLeg): EXIT 0, 513 passed (115 / 4 / 108 / 152 / 134),
  0 `[dynamoAdmin]`.
- Dashboard `npm run test -w @housingchoice/dashboard -- src/routes/contact`:
  EXIT 0, 67 files, 1333 passed.
- `npm run typecheck`: EXIT 0, 0 lines matching "error TS".
- eslint on all 7 touched .ts files: EXIT 0, nothing reported.
- Whole app workspace (`timeout 590 npx vitest run`, foreground): EXIT 0, 383
  files, 7672 passed / 1 skipped, 258.7 s, 0 `[dynamoAdmin]` (a908f9cb: 7666 /
  1; the +6 are the 5 new FW4-1 tests and the new 30005 test).
- After 610e46ba: 5-file set 512 passed, typecheck 0, eslint 0. After 5d373ae9:
  513 passed, dashboard 1333, typecheck 0, eslint 0. ASCII check on the staged
  added lines: 0 before every commit.
- Not run, as instructed: root npm test, e2e, smoke.

## Deviations from r2-adjudications.md section 1

- FW4-1: none in behavior. Additions beyond the ruling's text: test D (a cut
  walk adopts at the last check) and the (d) cause-order pin, both prompted by
  the mutant pass; the comment rewrite drops the stale "without the stop ...
  closed page_bound on the first check" rationale (a cut walk now judges
  anyway) and names the stop's remaining purpose - cost at checks 0-1.
- FW4-2, one interpretation: the ruling points at the generic WARN at :726-729
  but calls it "the known-arm WARN" (the 30007/30005/30006 arms). The same
  slot-written gate was applied to all three onRejected outcome lines (the
  generic WARN, the 30007 ERROR with the identical "recipient failed, NOT
  retried" text, and the 30005/30006 WARN), with one new test (the 30005 twin)
  and success-path pins in 13b.

## New residues (for FW3)

1. Spec text twin (out of scope, not edited): spec :444-445 (D8a rev 11) still
   says "the broadcast ladder (10 s + 20 s) clears it, so a stuck broadcast
   attempt is taken over at the cap"; fw2-report.md:248 says the same.
2. Rule (c)'s cost: a recipient with more than 5 pages (5000 messages) from one
   sender and nothing adoptable now closes unresolved page_bound at the last
   check instead of never_sent - the share reads send_unconfirmed and is never
   re-sent. The last check makes up to 4 more list calls (as priced).
3. On the throw path of the 30005/30006 arm no line says the contact was
   flagged; the flag write still runs, a failure still logs its own ERROR, and
   the carry WARN carries the errorCode.

## Concerns

- R2C-2 still stands: FW4-1 closes the list-order half only. If queued messages
  are not listed at all, a message held past +240 s is still ruled never_sent.
- Scratch files (scripts, logs, pristine copies, mutant logs) are only under the
  session scratchpad `FW4\`. No background process is running.

## Orchestrator checkpoint

Verified at 4eef5efa: 7 files changed c8193fc2..4eef5efa (sendReconcile.ts,
broadcastFanOut.ts, relayRetryLeg.ts, deliveryStatus.ts and three test files),
+338/-37; no fenced file; 0 non-ASCII bytes in the added lines. The source diff
was read in full: the early stop is gated `!last`; the bound sets `cut` and
breaks into the judging loop; nothing adopted returns `continue` (page_bound
when cut) before the last check and `unresolved` / page_bound for a cut walk at
the last check, ahead of the unchanged causes - exactly section 1's (a)-(d);
FW4-2 changes comments and log text only (every guardWrite, carry and flag
write unchanged). The FW4-2 interpretation (all three onRejected outcome lines
gated, since each claims "recipient failed") is ACCEPTED. The full gates run on
this code next.
