# WP1 B1 Ranking inputs - design review round 2, reviewer A

Spec: docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md rev 2
(4d33064d). Read with: adjudications.md, round1-reviewer-b.md, the charter.
Read-only review; nothing run.

Order: new problems in the rev 2 material first, then the fixes, then the
adjudications.

---

## 1. [HIGH] "New to this run" means "after the cursor", which wrongly marks call transcripts as already read, so their reactions are dropped

What is wrong. D5.4/D5.5 accept a reaction only from a message "NEW to this
run", defined as `m.tsMsgId > cursor`. D5.4 says "the job already knows"
which messages are new. For calls it does not. A call's tsMsgId is stamped
when the call STARTS: `providerTs: startedAt`, where `startedAt` is the
ringing time (originateCall.ts:168-178). The transcript is saved minutes
later, and only then is a `voice` run scheduled
(voiceTranscripts.ts:228-236). The cursor is set to the newest tsMsgId in a
run's window, whatever its direction (jobs/extraction.ts:502, :635). So the
cursor moves past the call if ANY extraction run happens between call start
and transcript save, for example:

- a tenant text after the call, which is debounced to about 30 s
  (routes/webhooks/twilio.ts:2797);
- an inbound email (inboundEmail.ts:856);
- a triage run (routes/contacts.ts:2177).

The voice run then renders the call as `[m<k>]`, not `[m<k> new]`. The model
is told not to read reactions from it, and apply drops any it emits.

The codebase already works around this exact gap. `hasNewClient` bypasses the
cursor for `row.channel === 'voice'` (jobs/extraction.ts:517), because a
completed transcript can sit behind the cursor. Rev 2 rebuilds the gap into
the reaction rule.

Implies. Phone calls are where tenants most often react to a home they were
shown. For those calls, reactions are lost silently and for good: the call
stays behind the cursor, and D5.5 says such messages "cannot return". Base
"new" on whether this message was already extracted, not on how its tsMsgId
compares with the cursor. One way is to record per message that it was read
with content, or to treat a call whose transcript completed after the cursor
was set as new. The same defect already gives such transcripts the 2,000-char
SEEN cap instead of 30,000 (jobs/extraction.ts:535). That is pre-existing and
worth filing.

## 2. [MEDIUM] The new-only rule turns every run that writes no reactions into permanent loss; Q1 understates this to Cameron

What is wrong. Rev 2 makes reactions readable ONLY in the run that first sees
a message (D5.4), and the cursor advances whatever that run did
(jobs/extraction.ts:635-636). So every path where a run writes nothing now
loses those reactions for good, not just for one run:

- Demoted windows. D5.5 writes no reactions when unknown-speaker content is
  present, and Q1(a) says one such call keeps a conversation demoted for up
  to 30 days. Q1 tells Cameron reactions "stop there for that long". In fact
  every reaction stated in those 30 days is lost permanently: when demotion
  lifts, those messages are behind the cursor. Notes lines are different,
  because the model may restate a seen fact later.
- `PROPERTIES SENT: unavailable` after a transient read failure (D5.3). This
  "does NOT fail the run", so the cursor advances and the window's reactions
  are gone.
- The writer gives up after 3 lost conditions (D5.6).
- The 5-per-run cap (D5.5). A tenant answering about 6 homes in one message
  burst loses the sixth.

Implies. Q1 is a spec-gate question, and it rests on a false premise. Restate
it ("permanently lost, not paused"). For the unavailable-block case, either
fail the run so the retry and backoff re-reads it (the org-list read already
does this, jobs/extraction.ts:563-568), or accept the loss in words.

## 3. [HIGH] Full-value accumulation makes text-field suggestions churn and gets past dismissals

What is wrong. D3 now has the model emit the FULL value of each text field
every time, with a non-empty field demoted to a suggestion. Two existing
mechanisms assume repeated proposals are byte-stable, and full-value text is
not:

- Equality. "A model value equal to the stored value is dropped as today".
  Today that is exact string equality (apply.ts:329-331). A reworded restate
  of the same content, such as "Decatur, Tucker" against "Decatur and
  Tucker", is a new suggestion.
- Dismissal. A dismissed value is never re-suggested only if it matches the
  tombstone after `normalizeSuggestionValue`, which folds case and whitespace
  only (schema.ts:301-304; apply.ts:839-852). The facts behind a dismissed
  suggestion stay in the re-sent window for up to 30 days
  (jobs/extraction.ts:493-498). Each later run can restate them in different
  words, and that new string gets past the tombstone. Sam dismisses
  "prefers Decatur; no apartments" and gets back "No apartments; wants
  Decatur" on the next run.

Each re-suggestion also displaces the last one and stamps the earlier run
`superseded` (jobs/extraction.ts:688-705), which pollutes the run log's
accuracy record.

Also new in rev 2: once a staff-filled field is near the 500-char cap, every
later model value (stored text plus the new fact) is over cap and DROPPED.
D4 sends to Notes only facts "that no field ... covers", so the new fact
lands nowhere.

Implies. B1 ships a suggestion chip that comes back after dismissal, on the
three fields B2's ranker reads. The spec must define a dismissal that
survives rewording, or re-suggest only when the model reports a NEW fact. For
example, let the model emit only the added clause (`add`), have apply build
the merged value, and key the tombstone on the added clause. It must also
send a fact that does not fit the cap to a Notes line instead of dropping it.

## 4. [MEDIUM] Adding the new mark to every transcript line is a production-wide prompt change, and only the never-written cases are measured

What is wrong. Every transcript line now starts with `[m<k>]` or
`[m<k> new]` (D5.2). Before, the model reconciled the whole window against
the profile with no read/unread signal. Telling it which lines are new
invites it to skip "seen" lines for fields and Notes too, which can quietly
lower recall for the eight existing fields. D7's gate measures only the
never-written cases and the controls. The existing probe suite is built for
exactly this regression check: voucher size, housing authority and others,
run with `--repo` to compare main against the branch
(extraction-prompt-probe.ts:16-24). Rev 2 refactors the probe but never says
to run that default suite against the final prompt.

Implies. There is no switch (charter 20.1), so a recall drop reaches
production with no measurement. Add to the merge gate: the default probe
suite on the final prompt, compared against main via `--repo`, with no new
`wrong` verdicts. Alternatively, keep the mark off the line and say "new" in
a separate header list.

## 5. [MEDIUM] The probe cannot run "the production apply-side filters" without repositories it says it never touches

What is wrong. D7 says the never-written suite runs "the production driver,
prompt, schema and apply-side filters (floor, caps)". In rev 2 those filters
live inside `applyExtraction`. That function needs `contacts`, `extraction`,
`audit`, `events`, and now `listingSends` and `units` (apply.ts:34-44;
D5.7). The probe's contract is "IT TOUCHES NO DATA. No database, no AWS"
(extraction-prompt-probe.ts:11-14). The spec does not say whether the probe:

- calls `applyExtraction` with in-memory fakes; or
- calls pure functions factored out of apply for the floor, the caps, the
  new and client message checks, and dedupe.

If it does neither, it re-implements them, and the gate certifies a copy.

Implies. The gate's claim, "the list holds in what production writes", rests
on running production code. State the mechanism: factor the line and
reaction filters into pure exported functions that apply and the probe both
call, or name in-memory repos and exactly what they stand in for.

## 6. [MEDIUM] The parser clamps that "apply is the one enforcement point" relies on are in the parser, which the fake bypasses

What is wrong. D4 says apply is "the one enforcement point" because the fake
driver bypasses `parseExtractionText`. Yet the 200-char text clamp and the
confidence clamp ("a non-number reading as 0") are placed in the PARSER (D4
Order). Under the fake (extractionFake.ts:103:
`result: { fields: {}, ...partial }`), apply gets raw values. In JavaScript
`"0.9" >= 0.7` is true and `5 >= 0.7` is true. Unclamped 1,000-char lines and
reaction texts are appended. D5.5 never says where reaction confidence and
the 200-char reaction text are clamped.

Implies. e2e, which runs only on the fake, can pass with values production
would treat differently. Move the type check, clamp and number test into
apply (or into a shared normalizer apply calls), for lines and reactions
alike.

## 7. [MEDIUM] The "older than the pair's first share" check uses the wrong timestamps

What is wrong. D5.5 uses the row's `created_at`, or `sentAt` on a legacy row,
as "the pair's first share". Neither field means that:

- `created_at` is stamped at the FIRST ledger write of any kind
  (listingSendsRepo.ts:336, `if_not_exists`). For a tenant who signed up
  through the flyer first and was sent the property later, that is the flyer
  sign-up. The flyer was excluded as a send on purpose (D5.1), yet it opens
  the reaction window.
- `sentAt` is the LATEST counted share's instant, not the first
  (listingSendsRepo.ts:92-95; ShareLedgerEntry "the row's sentAt follows the
  latest counted one", listingSendsRepo.ts:73). A legacy row re-sent today
  rejects a tenant's reply to the original send.

Implies. Use the earliest `countedAt` among the counted non-flyer share
entries, falling back to `sentAt` only for a true legacy row with no shares.
State that rule.

## 8. [LOW] The new mark has no field on the utterance

D5.2 says each `TranscriptUtterance` gains `handle`, and the line renders
`[m<k> new]`. `renderUtteranceLine(u)` takes one utterance (prompt.ts:179),
so the new flag must also be on the utterance, or passed to it. The spec does
not name the field. If `handle` is optional (needed so historic runs verify
without one), the type must make "handle present, new missing" impossible,
or the sent bytes and the hash can disagree.

## 9. [LOW] Q3's "about one more hour" remove control has no design

If Cameron answers yes, B1 gains a second writer of `reactions`. Undecided:
whether it joins the `shares_op` protocol, its audit event, who may remove,
and whether removal leaves a tombstone. With the new-only rule a re-add is
impossible, which should be said. Section 4 lists the writer as conditional
with no design. A yes needs a rev 3 section, not just an hour estimate.

## 10. [LOW] The spec says "a string value is a 400" and lists `''` as a valid clear

D2, dollars: "`null` / `''` to clear. A non-integer, out-of-range or string
value is a 400". Say "any other string".

---

## Fixes checked (round 1 items)

- R1-1 (handles have one owner): correct. One function, owned by the job,
  maps carried on the input, probe uses it. Sound.
- R1-2 (hash covers the handle): correct in mechanism. The mark's field is
  unnamed (finding 8). The window entry's `tier` already equals the new mark
  (runWindow.ts:59). Recording both is redundant but harmless.
- R1-3 (new-only plus dedupe by sourceMsgId): it closes the duplicate churn,
  but it introduces findings 1 and 2.
- R1-5 (accumulate): it closes the overwrite and truncation, but it
  introduces finding 3.
- R1-9, R1-10, R1-17, R1-19, R1-20: correct as written. Verified against
  ListingEditForm.tsx:601-610 (Same-day RTA is the last control before the
  Requirements heading) and unitFields.test.ts:645.
- R1-11 (floor before cap): correct order, but the clamps are in the wrong
  layer (finding 6).
- R1-12, R1-13, R1-14, R1-15, R1-16, R1-18, R1-21, R1-22: accepted. No
  objection.

## Adjudications

None rejected; I contest none. R1-14 (e2e asserts through the run record's
resolved reactions) is adequate only if the run record lists reactions the
writer CONFIRMED, not the ones apply attempted. State that in D5.7.
