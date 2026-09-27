# S6 report - Task 15 (Slice F): the issue registry

Dispatch S6 of the SOR Stage 1 build. Implementer: Claude Opus 5.5 (1M context).
Worktree `W:\tmp\send-outcome-reconcile`, base b7b3f24b, HEAD 61ea0f7f. Docs
only.

Record note: the implementer returned this report as TEXT (the harness refuses
report-file writes from implementer subagents); the orchestrator landed it
here with its own checkpoint appended, per AGENTS.md.

## Commit

- `61ea0f7f docs(issues): record the residues this branch leaves and the record shapes the sweeper will read` - 13 files under `docs/issues/` only (10 edited, 3 new), +763/-16. Bare git status read, MERGE_HEAD absent, explicit paths, 0 non-ASCII bytes in the staged added lines, Co-Authored-By trailer; INDEX.md not staged (gitignored).

## Per file

Each has a `## 2026-09-27 - feat/send-outcome-reconcile (SOR Stage 1)`
section, `updated: 2026-09-27`, frontmatter refs re-anchored at HEAD
b7b3f24b, whole file ASCII = 0.

- `fanout-close-path-robustness-residues`: item 1 narrowed (per-key try/catch
  in both closes); broadcast finalize can still throw (S2a); the guarded
  failure-arm writes listed by arm; the stranded hand-off; plan deviation 3;
  items 2-4 status; NEW item 5 (the operator line overstates the close, S2a
  concern 3). Title "Four residues" -> "Residues" because of item 5.
- `fanout-pass-setup-throw-strands-pass`: every pass-level throw outside the
  units at HEAD - broadcast (incl. the new re-drive post-loop claim :1062),
  relay (the preflight throws), and the relay retry rung (pre-claim throws,
  refuseGate/closeTerminally writes, T9-7 gateFor get/takeOver at six sites).
  The constructors run before the marker, so they are genuine retries.
- `relay-continuation-early-return-strands-slots`: re-drive early returns now
  close `redrive_refused` (record first); the ordinary continuation still
  strands, incl. a redriven record (S2b R4); the T15-2 narrowing (claimed +
  versioned ages; legacy erases the clock). Inline "(narrowed ... below)"
  pointer on the false sentence.
- `manual-retry-double-send-residual-windows`: pointer beside gap 5 + dated
  note on the webhook's `closeRetryLegEnqueueFailed` (twilio.ts:663-694,
  called :3058) being an ungated close by another writer (fenced file).
- `send-attempt-sweeper`: the record + index key shapes, attributes, states,
  clocks, TTL and transitions AS BUILT; S1b concerns 1/2/4; six items for the
  sweeper (fresh attempting at cap-close, stranded relay member/rung,
  unresolvable owner, markRedriven-then-death, takeOver-throws-after-applying,
  D14 crash windows); T15-3: bullet 4 superseded, the quoted dashboard comment
  gone (inline pointers added).
- `throw-for-redelivery-defeated-by-job-marker`: built for both fan-outs + the
  rung (units, classifier, record claim, reconcile); the T15-5 grep result;
  the still-open list; status stays open - the human resolves it at merge.
- `retry-send-lost-under-job-marker`: Stage 1 landed the core, retrySend
  unchanged (marker :203-212, rethrow :339); HEAD anchors (the body predates
  the RSW merge; the post-append annotate no longer exists).
- `accepted-send-lost-when-append-fails`: piece 1 built
  (SendAcceptedNotRecordedError); piece 2 built for adopters (known-SID
  adoption); still lost for missedCallAutoText, retrySend, the Stage 2 sites
  and the staff send routes (500).
- `exactly-once-send-intent`: substantially built (claim, fence, takeover,
  provider-history recovery); what remains (the sweeper, the Stage 2 sites,
  the staff routes / manual Retry / native group send).
- `relay-staleness-alarm-assumed-not-built` (T15-1): comment corrected
  (deliveryStatus.ts:245-255, :263-282); a claimed leg ages from attemptedAt;
  unclaimed/erased legs still never age; the alarm stays with the sweeper;
  status open.
- NEW `relay-fanout-closes-emit-nothing` (A8, bug/low): the fan-out has no
  event bus; the pre-existing closes plus this branch's rejection,
  second-unknown, hand-off enqueue-failure and redrive_refused closes;
  useRelayThread.ts:464-501 refetches only on SSE; contrasted with the rung's
  announceRootClose and send.reconcile's announceLeg/afterClose (A1).
- NEW `send-reconcile-job-residues` (bug/low): S3a residues 1-3 and 6-10
  (eight numbered items).
- NEW `send-outcome-dashboard-residues` (debt/low): S4 residues 1, 3, 5.

## Residue -> issue map

- S1b (concerns only): C1 re-claim under a new sender leaves the old index
  item -> send-attempt-sweeper; C2 raw recipient key in the owner map (both
  families) -> send-attempt-sweeper; C4 read costs -> send-attempt-sweeper;
  C3 (the T5-7 count), C5 -> not filed (process).
- S2a residues: snapshot/unit reads + up-front claim -> fanout-pass-setup;
  the re-drive post-loop claim (:1062) -> fanout-pass-setup; finalize throws
  (:1452, called :498/:1118) -> fanout-close-path item 1; takeOver throws after
  applying -> send-attempt-sweeper item 5; the gate-then-close window -> HELD
  R-b; the record-phase moved:false through that window -> HELD R-b; T7-11
  first pass does not carry -> send-attempt-sweeper ("not a residue, by
  design"). Concerns: C2 -> HELD R-b; C3 -> fanout-close-path item 5; C4 (no
  route test for the 201) -> not filed (test coverage, review); C5
  resolveContact eventual -> closed by T10-3 (broadcastFanOut.ts:1130-1138),
  not filed; C1, C6 -> not filed. The checkpoint's R-a -> HELD.
- S2b residues: R1 throw points outside the unit -> fanout-pass-setup; R2 the
  relay strand -> send-attempt-sweeper item 2; R3 new closes emit nothing ->
  relay-fanout-closes-emit-nothing; R4 an ordinary continuation leaves a
  redriven record -> relay-continuation-early-return; R5 the rung's argless
  path -> closed by Task 9 (relayRetryLeg.ts:878-1121), not filed. Concerns C1
  (the typecheck exit-code race; adopted as gate practice), C2, C3 -> not
  filed. R-a -> HELD.
- S2c residues: the pre-existing rung throws + refuseGate/closeTerminally
  writes -> fanout-pass-setup; T9-7 gateFor get/takeOver -> fanout-pass-setup.
  Concerns: C1 -> HELD R-b; C2 -> HELD R-c2; C3 -> not filed.
- S3a residues: 1 lost audit row -> send-reconcile-job-residues #1; 2 legacy
  re-run reports adopted -> #3; 3 wrong conversation after a number change ->
  #2; 4 unresolvable owner -> send-attempt-sweeper item 3; 5 markRedriven then
  death -> send-attempt-sweeper item 4; 6 relay adoption onto a missing row
  throws (+ the S3b extension, + T10-11 on the lane) ->
  send-reconcile-job-residues #7; 7 off-roster member -> digest_mismatch -> #4;
  8 A10 R1/R2/R3 -> #5 (accepted); 9 duplicate ERRORs -> #6; 10 malformed
  payload not poison -> #8. Concerns: C1 (the match-rule deviation) -> not
  filed (a handback spec deviation); C3 -> HELD R-c2; C4 -> not filed.
- S3b: F-1 -> HELD; F-2 -> HELD; the residue-6 extension ->
  send-reconcile-job-residues #7.
- S4: 1 latent double count -> send-outcome-dashboard-residues #1; 2 mixed
  chip reason -> HELD R-d; 3 stale reason doc -> #2; 4 stale refs -> fixed in
  relay-staleness-alarm-assumed-not-built, send-attempt-sweeper,
  relay-continuation-early-return; 5 one token, two sentences -> #3.
- S5b concerns: C1 lane timing (adjudicated), C2 pre-existing lint, C3 the
  AGENTS.md log-capture note (routed to the handback) -> not filed.
- Worklist section 3: R1-R3 -> send-reconcile-job-residues #5; R4 ->
  relay-fanout-closes-emit-nothing; R5 -> send-reconcile-job-residues #7; R6
  (an armed delivery profile, T11-6) and R7 (INV-1 lane index items) -> not
  filed (harness/e2e notes).
- Plan items: closeRetryLegEnqueueFailed -> manual-retry-double-send-residual-windows;
  deviation 3 -> fanout-close-path. S1a/S1c/S5a have no Residues sections;
  their concerns are harness/process notes (S1c C1 fixed in 346f0b74) - not
  filed.

## TODO-marker grep (T15-5)

`grep -rn "throw-for-redelivery-defeated-by-job-marker" W:/tmp/send-outcome-reconcile/app/src`
-> no output, exit status 1. The same grep over app, dashboard, fake-twilio,
e2e and scripts (.ts/.tsx/.mjs/.js) also returns nothing.

## npm run issues (exit 0; transliterated to ASCII)

```
[issues] 331 open, 180 closed, 511 total -> docs/issues/INDEX.md
[issues] open by severity: 6 high, 144 med, 181 low
```

No warnings line was printed, so 0 warnings (baseline 508 files / 0
warnings; +3 new files).

## Concerns

1. New finding, not in any slice record, NOT filed (treated like the HOLD
   items, for the review phase): each failure arm writes the slot and then
   the record as two separate guardWrites. If the slot write fails and the
   record write lands, the record ends TERMINAL (done/rejected, done/refused,
   done/unresolved) next to a `queued` slot that no pass carries. A broadcast
   then never finalizes (finalize defers on any queued slot,
   broadcastFanOut.ts:1464-1469), and a relay leg ages to "Queued - not
   confirmed". A sweeper that scans only open records would never see it.
   Sites: broadcast onRejected :681-748, the refusal arm :936-959, the
   second-unknown close :758-776, handOff's enqueue-failure close :579-596;
   relay relayFanOut.ts:2130-2192, :2214-2231, :1211-1224; rung
   relayRetryLeg.ts:647-668. Also: a failed broadcast fence write
   (declineAtFence :661-668) leaves the slot queued with no record and does
   not carry the recipient; for a redriven record, closeRedriven still runs
   (:669-673). The issue text only states the mechanism: slot first, then
   record, and a failed write leaves its own half.
2. The frontmatter refs were re-anchored in all ten existing files, not just
   the three S4 named, because the old refs pointed at code this branch moved.
   Body text keeps its historical anchors; short inline pointers only where a
   sentence is now false.
3. retry-send-lost-under-job-marker gets one "anchors at HEAD" paragraph on
   top of the plan's "nothing else" (its body predates the RSW merge).
4. T15-6's optional dated lines (no-contact-code-renders-as-carrier-error,
   broadcast-skip-code-drift-guard) were not written - outside the scope list.
5. throw-for-redelivery's refs now point at the fix sites; the old throw lines
   no longer exist.

## Orchestrator checkpoint

Verified at 61ea0f7f: only `docs/issues/` changed; every touched file is 0
non-ASCII bytes; `npm run issues` prints 511 total (331 open) with no warnings
line. Concern 1 goes to the review phase as item R-e: spec D7a intends a
failure-arm write that itself fails to leave the record `attempting` (so the
sweeper sees it); the two-write arms can instead leave a TERMINAL record
beside a stuck `queued` slot - the record write should be conditioned on the
slot write having succeeded.
