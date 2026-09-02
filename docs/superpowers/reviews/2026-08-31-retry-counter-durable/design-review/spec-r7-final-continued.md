# Spec R7 - corrections check, `enqueue_failed` vocabulary trace, and the sections nobody examined

Scope: the R6 corrections (Sec 3.4 cost + credit, Sec 3.4a `enqueue_failed`, tests
7b-7e, the corrected issue), the new error code's blast radius, and a deliberate pass
over sections I have never examined across six rounds.
Repo: `W:\tmp\retry-counter-durable`, read-only. No suites, no Playwright.

**The R6 corrections are correct.** The credit for the double-send guarantee now sits
with the marker, the cost of the reordering is stated, the issue's DLQ mechanism is
right, and the 798-stranded consequence is right. The rail citation I flagged in R4-11
is also properly fixed (`recordRailFailure` declared at `conversationsRepo.ts:979`,
implemented at `:2436` - both now cited correctly).

**You asked me to assume you had misattributed a mechanism a third time. You had.**
F2 below: `contact_opted_out` is precedent for the MAP, not for the rendering path the
two new codes will actually travel. And priority 4 turned up something larger that six
rounds have walked past - F1, where the close the `capped` branch calls is nested inside
a guard that is false at the point it is now called from.

---

## F1. [BLOCKING] The top-of-pass `capped` close calls a branch that is unreachable from the top of the pass - it marks zero recipients, and finalizes the broadcast as SENT

**What is wrong.** Sec 3.4's shape is `if (claim.outcome === 'capped') { await close(); return; }`,
and Sec 3.6 says the close is "the EXISTING cap branch … never adding a new one". The
existing cap branch is nested inside a guard on a loop-local array that is empty at the
top of the pass.

**Evidence.**

- `app/src/jobs/broadcastFanOut.ts:478` - `if (transientRemaining.length > 0) {`.
  The cap branch is `:480-495`, entirely inside it, and its marking loop iterates
  `transientRemaining` (`:481`).
- `transientRemaining` is declared at `:258` and populated only inside the send loop
  (`:452`). At the top of the pass it is `[]`.
- `app/src/jobs/relayFanOut.ts:569` - identical nesting; the cap branch is `:571-581`
  and iterates `transientRemaining` (`:574`), populated only at `:528`.

**What actually happens if a builder follows Sec 3.6 literally.** `close()` iterates an
empty array, marks nothing, and then - for broadcast - calls
`finalize(...)` at `:493`. `finalize` re-reads the row and computes
`allFailed = total > 0 && fresh.stats.failed >= total` (`:572`), which is false because
nothing was marked, so it calls `markSent` (`:575`). **The broadcast row is stamped
`sent` while every deferred recipient is still `queued`.**

That is worse than `main`. Today the row is stuck on `sending`, which is at least an
honest description of a stuck send; after this it says Sent about messages that were
never sent. For relay the failure is quieter but the same shape: the cap branch has no
`finalize` and no emit at all (`relayFanOut.ts:571-581`), so the close marks nothing and
returns silently.

**Nothing in Sec 7 catches it.** Test 3 exercises the Sec 3.4a enqueue-failure path,
where the loop HAS run and `transientRemaining` is populated - that path is fine. The
`capped` path is exercised only by test 5, which asserts "walks `fanout_attempt` 1, 2, 3
and closes at the cap" and says nothing about recipient states.

**And this is the NORMAL cap path, not an edge case** - under Sec 3.5's reading ("the
old code closed when `nextAttempt > MAX`; the claim refuses when `fanout_attempt` has
reached `MAX`"), the claim replaces the comparison, so pass 3 enqueues pass 4 and pass 4
caps at the top. Every exhausted ladder goes through it.

**Implies.** Sec 3.6's promise is not keepable and should be withdrawn. The close must
be extracted and parameterized over the recipient set the pass was going to attempt -
which both handlers already compute at the top: `keys` at `broadcastFanOut.ts:253-256`
and the filtered `recipients` at `relayFanOut.ts:434-438`, both derived from
`payload.recipientKeys`. That is a small change but it IS new code, and Sec 3.6 currently
tells a builder it is not.

There is a second, related ambiguity to settle in the same edit: **does the old
`nextAttempt > MAX` comparison survive?** If it is kept, the close happens in-pass at
pass 3 where `transientRemaining` is populated and everything works - but then the
durable cap is a rarely-fired backstop rather than the mechanism, and Sec 3.5 describes
one cap with two implementations that can disagree. If it is removed, F1 is live. The
spec must say which.

---

## F2. [HIGH] `contact_opted_out` is precedent for the MAP, not for the rendering path the two new codes take - the third misattribution

**What is wrong.** Sec 3.4a: `enqueue_failed` "is registered in **`INTERNAL_CODE_REASONS`**
(deliveryStatus.ts:609-611), the map for app-authored rather than carrier codes -
`contact_opted_out` is the existing precedent". The map choice is right. The precedent
does not transfer, because the existing entry is deliberately never rendered on the path
these two codes will be rendered on.

**Evidence.**

- The map's own docblock scopes its one entry to the AGGREGATE:
  `dashboard/src/routes/contact/deliveryStatus.ts:597-603` - "`contact_opted_out`
  reaches the message-level chip **only as the group-send AGGREGATE** … and
  `presentRelayDelivery` returns null for that map, so the bubble has no rollup to fall
  back on and this string IS what staff read."
- The per-leg presenter intercepts it BEFORE `deliveryReason`:
  `deliveryStatus.ts:512-516` - "Deliberately NOT routed through `deliveryReason`, which
  maps this code to 'Everyone here has opted out - nothing was sent' - **copy written
  for the message-level AGGREGATE. On the row of the one member in five who opted out
  that would be a fresh instance of the misread this feature exists to kill.**"
- `enqueue_failed` and `transient_cap` have no such interception. They are
  per-recipient codes on `failed` slots, and they will render in **two** places at
  once: the per-leg row via `Timeline.tsx:1044-1046`
  (`deliveryReason(row.slot.errorCode, { media: isMms })`), the accessible recital via
  `Timeline.tsx:582`, and inside the rollup's de-duplicated joined reasons via
  `deliveryStatus.ts:412-419`.

**Implies.** The copy for both codes must read correctly as a per-member row label AND
as one clause of a `'; '`-joined message-level summary - the exact dual constraint the
existing entry sidesteps. "Everyone here has opted out" would be catastrophic in that
position, which is why it is intercepted; the new entries get no interception, so the
copy has to carry the load. Write them per-recipient and singular ("Could not be
scheduled - no retry was attempted" rather than anything starting "Everyone"), and
replace the precedent sentence, which currently tells a builder the hard part is already
solved. Test 7e asserts only that they resolve through the map, not that the copy works
in both positions - worth extending.

---

## F3. [MEDIUM] Sec 2's in-scope list no longer matches the design in three places

The scope list is the fence, and three of this round's and last round's fixes edit files
it does not name.

- **The rail opt-in flag.** Sec 4.2 now says `GroupRailRequest` "gains an optional flag
  (default off) that **the job and import callers pass**". Those callers are
  `app/src/jobs/groupRail.ts:59` and `app/src/lib/import/convertGroups.ts:598`. Sec 2
  lists only `app/src/services/groupRail.ts`.
- **`Timeline.tsx`.** Sec 6 edits four `deliveryReason` call sites, three of which are
  in `dashboard/src/routes/contact/Timeline.tsx` (`:582`, `:849`, `:1045`, `:1390`).
  Sec 2 lists only `deliveryStatus.ts`, and its Out list still fences "Delivery-chip
  rendering beyond the one copy fix". Sec 6 carries the authorization narrative; Sec 2
  does not reflect it.
- **The two `INTERNAL_CODE_REASONS` entries.** Sec 2 scopes `deliveryStatus.ts` to "the
  30003 copy on legs that have no retry (Sec 6)". Sec 3.4a adds two unrelated map
  entries in the same file, one of which (`transient_cap`) **changes existing rendering
  for a code this branch does not otherwise touch** - today it renders as
  `Delivery failed (error transient_cap)` via the fallback at `deliveryStatus.ts:638-640`;
  after, it renders as prose with no code tail, because `deliveryReason` early-returns on
  the internal map at `:633-634`.

**Implies.** A gate reviewer diffing against Sec 2 sees three files that should not be
there. Update the list. (No test breaks: `app/test/broadcastFanOut.test.ts:398` asserts
the stored code, not its rendering, and I found no CSV/export surface reading recipient
error codes.)

---

## F4. [MEDIUM] Sec 5's disposition rule and Sec 3.4a contradict on the one in-region finding the sweep is guaranteed to produce

**What is wrong.** Sec 5 commits: findings "inside a region this branch already edits ->
**fixed here**". The sweep's subject is "a branch on a raw provider status whose
unenumerated default is non-terminal". Apply it to this branch's own edited region and
it lands on the fan-outs' error-code switch, whose unenumerated default is `throw err`
(`broadcastFanOut.ts:456-459`, `relayFanOut.ts:531-535`) - a default that is
non-terminal by intent and, per the filed issue, non-terminal in a way that never
terminates at all.

Sec 3.4a says that exact finding is **filed, not fixed** ("fixing it means deciding what
an unknown per-recipient error should DO - a behavior change with its own blast
radius"). The two rules give opposite dispositions for the same site.

**Implies.** Both decisions are individually right; the rule needs the exception written
in. One sentence in Sec 5: "the one in-region finding this sweep is already known to
produce is the fan-outs' unrecognised-error default, which is filed rather than fixed
(Sec 3.4a) because the remedy is a behavior change, not a terminal-default correction."
Without it, a builder either drags the behavior change into the branch or quietly drops
the sweep's own rule on its first hit.

I also note the enumeration omits at least one provider-status surface -
`app/src/routes/webhooks/twilioEvents.ts:176` branches on A2P number-registration status
- which is fenced from being fixed anyway, so it belongs in the "filed" bucket. Worth
adding to the enumeration so the audit's coverage claim is honest.

---

## F5. [LOW] The issue's suggested-fix bullet 2 keeps a DLQ justification the issue itself now disproves

`docs/issues/throw-for-redelivery-defeated-by-job-marker.md:70-72` - "mark the recipient
failed and let the job complete, so the row reaches a terminal state **and the DLQ is
reserved for genuine poison-envelope cases**." Lines 41-46 of the same file now establish
that the envelope never reaches the DLQ at all ("`maxReceiveCount` is never approached").
The clause is a leftover from the corrected framing and implies the DLQ is currently
being polluted. Drop it; the terminal-state half is the whole reason.

---

## F6. [LOW] The issue describes only the broadcast symptom, though it covers both fan-outs

The title and refs cover both handlers, but the consequence paragraph
(`:48-52`) is broadcast-specific: "the broadcast row left `sending`". `relayFanOut` has
no `finalize` and no row-level status - its slots are read at render time by
`presentRelayDelivery`. So the relay symptom is different and quieter: recipients
stranded `queued`, the bubble's rollup chip frozen mid-count at "delivered N/M", and no
row status to look wrong at all. One sentence, so whoever picks the issue up knows to
look for two different signatures.

---

## F7. [LOW] The rail ladder's re-read delay is still unnamed

Sec 4.3: "at most 2 bounded re-reads **with short delays**". The count is bounded; the
delay is not named, and neither is the total added latency. This was half of round 1's
B16 ask; the other half (keeping it out of the request path) was answered thoroughly in
Sec 4.2. Now that the ladder runs only on the job and import paths the cost is cheap, so
this is a buildability nit rather than a risk - but "short delays" is not a number a
builder can implement or a reviewer can check.

---

# Direct answers

**Q1 - are the corrections correct, and is there a third misattribution?**

The R6 corrections are correct. I re-verified each: the marker returns above the send
loop (`broadcastFanOut.ts:226-228` / `relayFanOut.ts:346-349`, loops at `:263` / `:443`),
so the skip is genuinely never evaluated on a duplicate; the rung cost is real and now
stated; the DLQ trace is right (`sqsJobConsumer.ts:175-186`); the 798 arithmetic is right.

**Yes, there is a third: F2.** And F1 is the same habit at one remove - asserting that an
existing branch can serve a new call site without checking that the call site can reach
it. The pattern in all three is identical: a mechanism is credited by NAME
(`jobId` freshness, the terminal skip, `contact_opted_out` as precedent, "the EXISTING
cap branch") without tracing whether that named thing is on the path in question. That
is worth naming in the adjudications as the review's recurring failure mode, because it
will recur in the build.

**Q2 - what does a code nothing maps do at each surface?** Full trace. `enqueue_failed`
is safe everywhere except the copy-context problem in F2.

| surface | reads | effect of `enqueue_failed` |
|---|---|---|
| `deriveBroadcastStats` (`broadcastsRepo.ts:245`) | `errorCode === 'no_consent'`, and only to split `skipped` | none - it sits on a `failed` slot, counted in `failed` |
| `deriveGroupDeliveryStatus` / `isSuppressedSlot` (`groupDelivery.ts:46`) | `contact_opted_out` only | none - and unreachable anyway: that function is called only from `groupReceipts.ts:348` and `groupSend.ts:617`, the native group-text paths, which neither fan-out writes into |
| `groupSendStaleness.ts:80` | `contact_opted_out` only | none |
| `presentRelayDelivery` (`deliveryStatus.ts:400-419`) | excludes `contact_opted_out` from the denominator; everything else counts failed and its reason is joined | counts as a hard failure (correct) and its copy is joined into the chip - **F2** |
| `presentLegDelivery` (`:520`) | special-cases `contact_opted_out`; else no reason | no reason from here |
| `Timeline.tsx:1044-1046`, `:582` | `deliveryReason(slot.errorCode, {media})` | renders per-leg - **F2** |
| `DeliveryBadge.tsx:31` | `deliveryReason(errorCode)` | broadcast badge renders it |
| `deliveryReason` (`:628-640`) | INTERNAL first, early return with **no** `(error <code>)` tail | prose, no token |
| audit / exports | `finalize`'s audit row carries `{broadcastId, tenantCount}` only (`broadcastFanOut.ts:567`) | none. No CSV/export surface reads recipient error codes (grep over `app/src/routes` and `dashboard/src/routes/broadcasts` found none) |

No branching reader anywhere compares against an unmapped code, so introducing one
changes no logic. The one degraded surface you had not named is the dual per-leg /
aggregate rendering context - F2 - plus the side effect on `transient_cap`'s existing
rendering noted in F3.

**Q3 - is the corrected issue true end to end?** Yes. I re-derived the trace
independently rather than assuming: delivery 1 throws, consumer logs WARN and does not
delete (`sqsJobConsumer.ts:175-183`); delivery 2 carries the same `jobId`, the marker
returns `false`, the handler returns normally (`broadcastFanOut.ts:226-228`), the
consumer's dispatch resolves and falls through to
`await this.deleteMessage(message, 'done')` (`:186`). Receive count 2 against
`maxReceiveCount = 5` (`infra/modules/jobs/main.tf:41`). Never dead-lettered, no alarm.
The new send-to-slot-write constraint (`:78-87`) is also correct and correctly bounded -
the window is `relayFanOut.ts:504`-`:544` and `broadcastFanOut.ts:320`-`:333`. Two
leftovers only: F5 and F6.

**Q4 - the sections nobody examined.** F1 (Sec 3.6) and F4 (Sec 5) both come from here,
and F1 is the most serious finding of this round. Sec 3.6 has been carried forward
unchanged since round 3, when the claim was still at the continuation point and its
promise was true. The claim moved twice since; Sec 3.6 did not. Sec 5 has been essentially
untouched since round 1 and has never been tested against the branch's own edited region.

I also re-read Sec 8 for the first time. It is sound, and its second bullet ("The claim's
PLACEMENT is the fix, not just its existence … do not delete test 7a as redundant with
test 3") is the single most useful line in the document for whoever maintains this next.
One gap: now that `Timeline.tsx` and `deliveryStatus.ts` are edited, neither has a
conflict-surface watch item, and Sec 6's "no live worktree is touching them (checked
across all ten)" is a point-in-time check that will be stale by merge. Worth one bullet.
