# Spec R5 - targeted check of the rewritten Sec 3 (scalar pass counter)

Scope: Sec 3.1-3.5 read cold, plus the five questions asked. The rest of the spec was
re-checked only for dangling references.
Repo: `W:\tmp\retry-counter-durable`, read-only. No suites, no Playwright.

**Verdict: the scalar collapse is right, the top-of-pass insight is right, and the
placement relative to `putJobExecutionMarker` is backwards in a way that stops the
mechanism running at all.**

Q2 was the right thing to be nervous about. You wrote: "if a redelivery does NOT get a
fresh jobId, the ladder never advances and the whole design fails." **A redelivery does
not get a fresh jobId.** The envelope's `jobId` is minted once at enqueue time and rides
the SQS message body; `dispatchJob` uses it verbatim. So the marker suppresses every
post-throw redelivery *before* the claim is reached, and the counter freezes at 1.

Everything else in Sec 3 holds up. Q3's two assertions are both correct and have in-repo
precedent. Q4 is right about the send count and overstated about "passes". Q1's coverage
argument is sound within one delivery; it is the *next* delivery that never arrives. Q5
is clean.

---

## S1. [BLOCKING] The jobId is stable across redeliveries, so the marker returns before the claim and the counter never advances

**What is wrong.** Sec 3.4: "The claim sits AFTER the marker deliberately … A redelivery
after a throw carries a FRESH `jobId` (the visibility timeout), so it is not suppressed
and does claim - which is what makes the ladder advance." The premise is false.

**Evidence.**

- `app/src/jobs/jobs.ts:186-195` - `buildEnvelope` mints `jobId: randomUUID()` at
  **enqueue** time (`:188`), once, into the envelope object.
- `app/src/jobs/jobs.ts:124` - that envelope is what is handed to
  `outboundQueue.enqueue(envelope, …)`, i.e. serialized into the SQS message body.
- `app/src/jobs/jobs.ts:262` - on dispatch, `if (isCompleteEnvelope(e)) return
  { envelope: e, synthesized: false }` - the envelope is used **as-is**, jobId included.
  A fresh `randomUUID()` is minted only at `:268`, on the INCOMPLETE-envelope path,
  which is flagged `synthesized: true` and logged as a WARN (`:311-317`).
- `app/src/jobs/jobs.ts:303-308` - `jobRunId` is fresh per run; `jobId: envelope.jobId`
  is not.
- `app/src/jobs/jobs.ts:286` settles it in the codebase's own words: dispatchJob
  "re-hydrates AsyncLocalStorage with the envelope's correlation context + the new
  jobRunId + **the stable jobId**".
- `app/src/repos/messagesRepo.ts:2630-2649` - `putJobExecutionMarker` is a conditional
  `PutCommand` on `job#<jobId>` with `attribute_not_exists(tsMsgId)` and **no TTL
  attribute**. Once written it is permanent, and a handler throw does not remove it.

**The trace under Sec 3.4's placement.**

1. Pass 1 delivers, jobId `J`. Marker `job#J` written -> `first === true`.
2. Claim: `fanout_attempt` 0 -> 1. Handler runs, then throws (unknown send error, or the
   enqueue failure).
3. SQS redelivers **the same message body**, so the same envelope, so jobId `J`.
4. `putJobExecutionMarker(J)` hits the condition, returns `false`. Handler logs
   "duplicate delivery suppressed" and **returns** - `broadcastFanOut.ts:224-228`,
   `relayFanOut.ts:344-349`.
5. **The claim is never reached.** `fanout_attempt` stays at 1 for every one of the
   remaining receives, the cap is never reached, the close never runs, and
   `maxReceiveCount = 5` (`infra/modules/jobs/main.tf:41`) DLQs the envelope with the
   broadcast row still `sending` and its recipients still `queued`.

That is the exact symptom Sec 3.4 says the top-of-pass placement removes, arriving
through the door the placement opened.

**A pre-existing bug is underneath this, and it is worth recording.** Two comments in
the repo contradict each other, and the spec inherited the wrong one:

- `app/src/jobs/retrySend.ts:122-128` - "The envelope's jobId (**stable across
  redeliveries**; dispatchJob stamps it into the context)". Correct.
- `app/src/jobs/broadcastFanOut.ts:456-459` - "let the job FAIL so SQS redelivers the
  whole envelope (**a fresh jobId via the visibility timeout**; the marker is
  per-jobId)". Wrong, and `relayFanOut.ts:531-535` repeats it.

So the throw-for-redelivery pattern both fan-outs already rely on is **already defeated
by the marker on `main`**. This does not change what this branch must do, but it means
the anchor issue is worse than documented and the spec can say so.

**Implies.** Sec 3.4's placement must invert: **claim BEFORE the marker.** The claim
sends nothing, so placing it first costs only this - a true same-jobId duplicate
delivery consumes a pass. That cost is small and bounded, and the fan-outs already carry
a second idempotency layer that makes a duplicate harmless anyway: the per-recipient
terminal skip (`broadcastFanOut.ts:19-22` and `:265`, `relayFanOut.ts:10-14` and
`:445-448`), which is what actually prevents a double send. Weigh it as stated: "a rare
duplicate costs one rung" versus "no redelivery ever advances the counter". Only one of
those is survivable, and Sec 3.4 currently picks the other.

---

## S2. [HIGH] Tests 3, 5 and 7a all assert the redelivery behavior S1 disproves - and will pass vacuously

**What is wrong.** Three tests are written as "the handler throws, the envelope
redelivers, the durable count advances each pass". Under S1 none of that happens in
production. Worse, all three will pass in vitest without exercising the defect.

**Evidence.** The marker is skipped entirely when there is no jobId in context -
`broadcastFanOut.ts:229-234` and `relayFanOut.ts:350-355` log
"no jobId in context - duplicate-delivery guard skipped" and fall through. A test that
invokes the handler directly, or through `dispatchJob` with a fresh envelope per call,
never collides on the marker and sees the counter advance exactly as the spec describes.

**Implies.** Whatever placement is chosen, tests 3, 5 and 7a must **pin the jobId
explicitly**: re-dispatch the SAME envelope (same `jobId`) and assert the count advanced.
Test 5's wording ("replaying an identical envelope repeatedly") is already the right
scenario and the wrong assertion - identical envelope means identical jobId, which is
precisely the case that must advance the counter and currently cannot. Make that test
the discriminator.

---

## S3. [MEDIUM] Cap semantics: the send count matches `main`, but "the total number of passes is identical" does not

You asked for the trace. It is correct where it matters and overstated as written.

**`main`** (`broadcastFanOut.ts:479-480`, `MAX_BROADCAST_ATTEMPTS = 3` at `:79`; same
shape at `relayFanOut.ts:570-571` against `MAX_FANOUT_ATTEMPTS = 3` at `:58`):

pass 1 -> `2 > 3`? no -> enqueue 2. pass 2 -> `3 > 3`? no -> enqueue 3.
pass 3 -> `4 > 3` **yes -> close, in-pass.** Three deliveries, three send loops.

**New**, `cap = 3`, condition `fanout_attempt < cap`:

pass 1 claims 0->1, sends, enqueues 2. pass 2 claims 1->2, sends, enqueues 3.
pass 3 claims 2->3, sends, **enqueues 4**. pass 4: `3 < 3` false -> capped -> close.
**Four deliveries, three send loops.**

So: **provider sends per recipient are identical (3)** - which is the number that matters,
the number test 6 pins, and the A2P-relevant one. Your Q4 answer is right on the
substance. Two deltas the spec should state rather than assert away:

1. **The close is deferred by one backoff interval.** `main` closes at the end of pass 3;
   the new design closes on a fourth delivery that runs no loop. Recipients sit `queued`
   for one more `broadcastBackoffMs`/`fanOutBackoffMs` step (~20s at the third rung)
   before being marked `failed`/`transient_cap`, and the broadcast finalizes that much
   later. Bounded and probably acceptable - but it is a behavior change, and Sec 3.5 says
   "The total number of send passes per recipient is identical to `main`", which reads as
   "nothing changes".
2. **The ladder is genuinely shorter in mixed scenarios, by design.** A throw-redelivery
   now consumes a rung that `main` did not charge for: pass 1 sends and defers, pass 2
   throws on an unknown error, its redelivery is pass 3, pass 4 caps. One unrecoverable
   error costs one continuation. That is the intended consequence of counting passes
   rather than enqueues, and it is the right trade - but it means "identical to `main`"
   is true only of the clean path.

Rewrite the guarantee as **"the number of provider send passes per recipient is
unchanged from `main` on the clean path; a redelivery now consumes a rung, and the close
lands one backoff interval later"**. Test 6 already pins the part that matters.

---

## S4. [LOW] Two exits precede the marker, and therefore precede the claim under either placement

For completeness on Q1: the claim covers every exit *after* it, and Sec 3.4's list
(unknown send error, enqueue failure, crash, timeout) is right. Two things run earlier
in both handlers:

- payload parsing - `broadcastFanOut.ts:196` (`parseBroadcastSendPayload`),
  `relayFanOut.ts:329` (`parseRelayFanOutPayload`); both throw on a malformed payload;
- lazy config/repo/service construction - `broadcastFanOut.ts:197-216`,
  `relayFanOut.ts:330-337`; `loadConfig()` or a repo factory can throw.

Neither should advance the ladder: a malformed payload is poison and belongs in the DLQ,
and a boot-config failure affects every job, not this entity. Correct as-is - worth one
sentence in Sec 3.4 so a reader knows the gap was considered rather than missed.

I checked for early returns *between* the marker and the send loop, since those would sit
between the marker and the claim if the claim moves. There are several -
`broadcastFanOut.ts:237-240` (broadcast not found), `relayFanOut.ts:357-361` (conversation
not found), `:368-374` (group not open), `:375-379` (no pool number), `:386-390` (source
message not found), `:417-423` (nothing to relay). All of them fall *after* the claim
under Sec 3.4's shape, which is fine: they enqueue no continuation, so a consumed pass
costs nothing. Under the S1 remedy (claim first) they are equally fine. No finding.

---

## S5. [LOW] Missing blank line before `### 3.6`

Line 238-239: the closing sentence of Sec 3.5 ("A test still asserts the total
provider-send count …") is immediately followed by `### 3.6 The close branches are the
EXISTING ones` with no blank line. Markdown renderers differ on whether the heading is
recognised. Cosmetic, but this document has had a numbering/structure defect in three of
five rounds.

---

# Direct answers

**Q1 - does top-of-pass placement cover every exit?** Yes, within a delivery. The
insight is correct and test 7a is the right regression for it. The placement does not
help, because under S1 the redelivery that would walk the counter to the cap never
executes past the marker. Fix S1 and the coverage claim becomes true.

**Q2 - is the claim correctly placed relative to the marker?** No. The first half of
your reasoning is right (a true duplicate must not consume a pass). The second half is
false (`jobs.ts:188`, `:262`, `:286`, `:307`), and it is the half that makes the ladder
move. Claim before the marker and state the accepted cost.

**Q3 - `ADD` on an absent top-level numeric, and `UPDATED_NEW`?** Both assertions
correct. In-repo precedent for the first: `app/src/repos/conversationsRepo.ts:1814`
(`ADD outbound_minute_count :one`, a per-minute rate counter that necessarily starts
absent) and `:1631` (`ADD unread_count :one SET unread_flag = :flag`). Note the contrast
that makes Sec 3.2's claim safe: `broadcastsRepo.ts:632-671` needed the comment "stats
fields pre-exist (create/markSending seed them), so ADD on a nested numeric attribute is
safe" precisely because that one is nested. A top-level attribute has no parent path, so
there is genuinely nothing to seed. **UNVERIFIED, asserted from the AWS contract rather
than executed here:** that `ReturnValues: 'UPDATED_NEW'` on a top-level scalar returns
that attribute alone. It is consistent with the nested behavior the map version had to
reason about, and nothing in Sec 3 depends on the exact shape beyond reading one number.

**Q4 - cap off-by-one?** No off-by-one in provider sends; see S3 for the two deltas that
are real.

**Q5 - anything dangling?** Clean. I grepped the whole spec for `fanout_attempts`,
`if_not_exists`, "counter map", "per-recipient attempt", `claimFanoutAttempt` - zero
hits. Sec 2's in-scope line now reads "the claim primitive" with the seeding clause
removed; test 7 was rewritten to "an item with no `fanout_attempt` attribute claims
successfully at 1 (`ADD` creates it), with no seeding step"; Sec 9's "self-seeding
(Sec 3.2)" is still accurate. Sec 6 was independently strengthened - it now fixes all
four `deliveryReason` call sites, cites the `Timeline.tsx:1035-1042` invariant as the
reason, corrects the native-group-text row to "a retry IS scheduled, unchanged", and
records the authorization for touching `Timeline.tsx`. That resolves R4-3 and R4-6. Only
S5 above.

**Does the scalar make the deferred lineage mission harder?** Sec 2.1 is honest and I
would not change its framing. The map version's per-recipient key was never reusable by
the lineage ladder anyway - review established the two ladders must not share a field,
so the lineage mission was always going to build `retry_attempts` and `retry_lineage`
alongside. What transfers is unchanged by the collapse: the sibling-top-level-attribute
placement, claim-before-work, atomic conditional `ADD`, `UPDATED_NEW` over a re-read,
and the consistent-read `capped`/`missing` disambiguation.

One genuine thing was traded, and it belongs in Sec 9's issue update rather than being a
defect here: the map version would have *forced* this branch to solve parent-map seeding,
and the lineage mission's `retry_lineage.<memberKey>.<n>` is a **two-level** nested map
that will hit that problem harder than the one-level version did. The answer is already
written in the repo - `app/src/repos/conversationsRepo.ts:2189-2214`, the child-write-then-
seed-on-`ConditionalCheckFailedException` two-write pattern, with `:2218-2226` explaining
why a single expression cannot do it. Recording that pointer in the issue costs a
sentence and saves the next mission a round.
