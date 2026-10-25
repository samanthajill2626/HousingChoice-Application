# WP1 matching charter - design review round 4 (final), reviewer A

Spec reviewed at 338f8546 (cited as "spec L<n>"), with the eadf0913 to
338f8546 diff and the round-3 adjudications. Code was read at the worktree
head. ASCII only.

Stop rule. Findings 1 and 2 are DECISIONs. Findings 3 to 5 are PRECISION
edits a slice spec could settle. I contest no adjudication. The round-3
fixes are correct apart from the defects below, two of which the new text
itself introduced (findings 1 and 2).

---

## 1. [HIGH] [DECISION] The new Select all re-texts Not interested and no-consent tenants with one click

What is wrong. Spec L666-667: "Select all checks every ranked row except
capped and tour-held rows".

Evidence. Today Select all re-applies the server's checkedByDefault,
`has_consent && (seeded || (!alreadySent && !declined && !tourHold))`
(RecipientPreview.tsx:9-15; blastAudienceRules.ts:181). It therefore skips:
- already-sent rows;
- Not interested rows ("a 'Not interested' row ... that Select all skips",
  RecipientPreview.tsx:19);
- no-consent rows.

The explicit-selection send path does not exclude them afterwards: "The
already-sent flag is a preview hint only - NEVER excluded here", and it
re-enforces only the opt-out, unreachable and phone fences
(broadcasts.ts:1196-1202).

What it implies. On a property anchor, one Select all plus Send texts the
same property again to every tenant who said Not interested, and to every
already-sent tenant showing a Replied or Interested chip. That is today's
behavior reversed. It also defeats A1's objective of sending "without
checking who already has it or has declined it" (A1 L50-52).

It is unclear whether the No reply rows hidden behind the counted chip
(13.3) are included. No-consent rows get checked too, and the fan-out then
drops them (broadcastFanOut.ts:276), so Sam's selected count overstates
what goes out.

Select all should keep today's skips (already sent, Not interested, no
consent, hidden rows) on top of the new capped and tour-held skips.

## 2. [MEDIUM] [DECISION] The run claim has no lease, so a crashed job wedges its anchor; "join" is a check-then-act race

What is wrong. Spec 10.2 (new text): the job "claims its run, so a
duplicate delivery does nothing twice". The status record goes
queued, running, done or failed, and "the app reads it before enqueueing to
join a job in flight".

Evidence and implications.
- The handler never throws, but a worker crash or a deploy restart mid-job
  is not a throw. SQS redelivers after the 120-second visibility timeout
  (sqsJobConsumer.ts:11-17; infra/modules/jobs/main.tf:36). The redelivered
  copy finds the run already claimed and "does nothing". The status stays
  `running` forever, so every later press "joins" a dead job. That anchor
  can never be ranked again without a hand repair.
- The app READS the status and then enqueues. Two presses at once (two
  users, or a double click past the rate limit) both read "no job", both
  enqueue, and get two different runs with two claims. The pool is paid
  for twice, which is exactly what "join" promised to prevent.

Fix needed:
- The claim and the per-anchor status are ONE conditional write made by
  the app before it enqueues. A press that loses that write joins.
- The claim carries a lease, longer than the job's bounded runtime, after
  which a redelivery or a new press may take the job over. The codebase
  already uses the stale-claim-takeover pattern (lib/guardWrite.ts:5-6).

## 3. [LOW] [PRECISION] Accommodation flags must not merge to the property level

Spec 7.4 merges fairHousingFlags across batches "by property, kind and
field". That is right for UNLAWFUL flags, which are about the record. An
ACCOMMODATION flag is about one PAIR (spec, the new two-kinds paragraph in
7.2). On a property anchor every candidate shares the property, so the
merge collapses several tenants' accommodations into one property-level
flag. The cap stays correct, because it reads "the same pair's" flags, but
the composer display does not.

Also, 7.2 still opens with "the composer shows Sam a flag naming that
requirement as one to remove from the record". That sentence is now true
only of the UNLAWFUL kind. Say so where it stands.

## 4. [LOW] [PRECISION] The reaction condition excludes sent legacy pairs

"Listed with a counted send share" (6.3, new text) requires a `shares`
map. A legacy row has none and "reads as counted" from `sentAt`
(listingSendsRepo.ts:41-43, 231-236). Pair history already falls back to
`sentAt` for those rows (6.3). The reaction rule should take the same
fallback, or state that legacy pairs get no reactions.

## 5. [LOW] [PRECISION] A status record in the AI runs table needs an expiry choice and a reader fence

The ranking-job status record (10.2, new text) lives in `ai_runs`, which
TTLs on `expires_at` (tables.ts:645-655). It needs a stated TTL: the run
retention of 180 days, or a shorter one for the status record.

It must also be kept out of every run reader. The listing reads of
section 11 and the run-detail route at aiRuns.ts:228-249 must not treat a
status record as a run. Name its key family next to the ranking run keys.
