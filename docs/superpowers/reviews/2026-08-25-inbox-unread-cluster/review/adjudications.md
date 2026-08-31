# Review adjudications - orchestrator

Two reviewers, both `model: opus`, both foreground, dispatched in one message.

- SPEC-CONFORMANCE (had the spec + work map): `review-spec-conformance.md`.
  Verdict: all 10 work-map items, all 5 requirements, all 7 coverage classes and
  all 6 testing demands CONFORMS, with file:line. Nothing MISSING or PARTIAL.
- ADVERSARIAL (PLAN-BLIND by mandate - given the diff package, the repo, and one
  sentence of feature area; no spec, no plan, no worklist): `review-adversarial.md`.
  1 HIGH, 6 MED, 3 LOW. No BLOCKING, no security findings.

The adversarial reviewer earned its keep: the spec-conformance pass returned a
clean sheet, and the plan-blind pass found a fact the SPEC ITSELF did not know.

---

## HIGH-1 - the cap does not cut "arbitrarily"; it starves `needs_review`

CONFIRMED by the orchestrator directly, not taken on report.

`byTypeStatus` is `(hash: type, range: status)` and `contactsRepo.listByType`
sets **no `ScanIndexForward`** (`contactsRepo.ts`, the `listByType` body - the
`QueryCommandInput` has no such key), so the Query is ASCENDING on `status`.
`'active' < 'needs_review'` lexicographically. Therefore, within
`type='unknown'`, **every `active` row is returned before any `needs_review`
row.**

Consequence: `UNKNOWN_QUEUE_MAX_ROWS` (200) and the page budget (10 x 100) do
not cut a recency-arbitrary slice, as `unknownQueue.ts`'s `UnknownQueueResult`
doc, the truncation WARN copy, and the branch's sort comment all claim. They cut
**status-first**, and the status they starve is exactly the one that means
"nobody has looked at this yet". The reviewer proved it by driving the real
`aggregateInbox`: 3 `needs_review` contacts holding the NEWEST activity rendered
ZERO rows while 3 older `active` ones filled the cap.

**It compounds with MED-3** in a way neither reviewer stated jointly: a
status-only triage that sets an unknown contact to `active` moves it to the
FRONT of the ordering, so a half-triaged row crowds out untriaged ones.

Live impact TODAY: none. The spec measured 16 unknown contacts in dev and 7 in
prod, with ZERO `(unknown, active)` in either - the cap is two orders of
magnitude away. The defect is in the DESIGN RECORD and in the latent behaviour,
not in what ships to an operator this week.

RULING - **fix the record and the fixture, do NOT change production behaviour.**
The spec's decision (one Query, no status narrowing, cap-plus-WARN) is approved
and is NOT re-litigated here: narrowing on status would re-create class (f),
which is the bug the design exists to close. And the collector cannot reorder
what a bounded ascending read hands it. So:
1. Correct every comment that calls the cut arbitrary/recency-blind. State what
   it actually is: status-ascending, `active` first, `needs_review` starved.
2. Teach the shared fake to model the range-key SORT, so the fact is
   EXPRESSIBLE. Its absence is why no existing test could catch this.
3. Pin the ordering in a test, so the next person meets it as a fact.
4. Record it in the issue as the thing to reopen, with the mitigation the human
   may want (a `ScanIndexForward: false` option on the repo read, which is a
   repo-wide change touching `today.ts` and therefore the human's call, not
   this branch's).

## MED-2 - the "live TYPE re-check" is structurally unreachable

CONFIRMED. `listByType('unknown')` Queries the index whose HASH KEY IS `type`,
and the items come from that index - so every returned item has
`type === 'unknown'`, `roleFromContact` returns `'unknown'`, and the guard can
never fire. A stale index entry is still keyed `type='unknown'`. So
`unknownQueueRetyped` cannot be emitted from a real Query, and the log-reader
note telling operators that old `unknownFilterRole` rejections "now happen as
`unknownQueueRetyped`" points at a counter that fires nowhere.

RULING - **keep the guard, fix the claims.** The guard is cheap belt-and-braces
and would matter if a second type were ever mapped `queried` or if the read ever
went through the base table. But the spec's requirement 1 presents it as the
"honest replacement" for the precedent's status re-check, and a guard that
cannot fire is not that. Label it accurately in code, and fix the log-reader
note. Its test stays (it pins the guard's behaviour) but must say plainly that
it drives the path through an override no Query can produce.

## MED-3 - "triage retypes the contact out of the partition" is false

CONFIRMED by the orchestrator: `routes/contacts.ts` explicitly supports a
status-only triage PATCH (`if ('status' in parsed.patch && !('type' in
parsed.patch))`), re-validating against `statusAllowlistFor(stored.type)` -
which for `unknown` is `['needs_review','active']`. So an operator can mark an
unknown contact `active` while it stays `type='unknown'`, and it stays in the
queue permanently.

This matters because that claim is the JUSTIFICATION for shipping no cursor
("triage drains the queue"). RULING - **fix the claim** in the collector's
comment and the branch's window comment, and record the consequence in the
issue: the queue drains only via a RE-TYPE, and a status-only triage leaves the
row in place (and, per HIGH-1, at the front).

## MED-4 - "pays per row RETURNED" is false; it pays per row COLLECTED

CONFIRMED by the orchestrator: `buildContactRow` runs inside the loop over
`queue.contacts` (`inbox.ts:1607`), and the window `slice(0, limit)` happens at
`:1739`, AFTER the sort. So a cap-full queue hydrates up to 200 rows serially to
render 30. RULING - **fix the comment** to say cost is proportional to rows
COLLECTED (bounded by the cap), not rows returned. Do not restructure: hydrating
before the sort is required, because the sort key is the hydrated activity.

## MED-5 - the issue records only the capped-SWEEP residual

CONFIRMED by reading the issue. The COLLECTOR-truncation residual is the same
shape and, by the module's own "residue accumulates FOREVER" argument, likelier:
a `queue.truncated` walk that keeps zero rows renders the ordinary
"No unknown numbers" empty state over a live queue. RULING - **add it** to the
issue's RESOLVED block alongside the sweep residual.

## MED-6 - the fakes diverge, and the new one does not model the sort

SPLIT RULING.
- The `twilioWebhookHarness.ts` divergence is **ACCEPTED AND ALREADY RECORDED**
  in the plan's Global Constraints: that fake is frozen because the `today.ts`
  triage pins are calibrated against its semantics. Not fixed; named in the
  handback so it is not rediscovered.
- The new fake **not modelling the range-key sort IS fixed** - it is the direct
  cause of HIGH-1 being inexpressible, and this helper is positioned as the
  authority on partition semantics. Rolled into HIGH-1's fix.

## MED-7 - the class (c) ruling is enforced for tab membership only

CONFIRMED. A `team_member` no longer enters the Unknown QUEUE, but
`roleFromContact` still falls them through to `'unknown'`, so `needsTriage: true`
and the "Needs triage" chip still ship for them on the All and Unread tabs. The
issue's wording implies the mechanism is closed. RULING - **fix the issue's
wording** to say what actually shipped: the triage QUEUE excludes them by
construction; the `roleFromContact` fall-through is untouched and still labels
them on other tabs. Widening `roleFromContact` is a separate change with its own
blast radius - do NOT do it here.

## LOW-8, LOW-9, LOW-10 - RECORDED, NOT FIXED

- LOW-8: the unconditional 2000-item sweep binds to the process-wide 5-minute
  WARN limiter shared with the badge and the Unread page, so a busy Unknown tab
  can suppress their tripwires. Real, pre-existing limiter design, and changing
  it affects three consumers. Handback.
- LOW-9: the sweep is paid even when zero soft-deleted unknowns exist (measured
  zero in both environments). A bounded `deleted:true` probe could skip it - but
  that is a design change to an approved requirement 3. Handback.
- LOW-10: `measure-unread-contact-coverage.ts`'s `--audit-unknown-page` still
  presents itself as THE Unknown-tab measurement while replicating a read the app
  no longer performs, and prints a `status mismatch` line from a counter that is
  never incremented under `--no-status-narrow`. The instrument is the evidence
  base for the spec's numbers and for the post-merge verification the handback
  OFFERS, so changing it now would invalidate the comparison the human is being
  asked to run. Handback, explicitly.

---

## What this wave does and does not change

**No production BEHAVIOUR changes in the fix wave.** Every ruling above is a
correction to the design record, one fake-fidelity improvement, and the tests
that make the corrected facts checkable. That is deliberate: the spec is
human-gated and its decisions stand. The one finding that argues for a behaviour
change (HIGH-1's ordering) is surfaced to the human with its mitigation named,
because the fix touches a shared repo read that `today.ts` also uses.

---

# Round 2 - adjudicating the re-review

The re-review was charged miss-first, and it earned it: it found ONE real defect
introduced BY the fix wave, ONE operator-facing WARN string that is false in a
reachable state, and it successfully CONTESTED THREE of my own rulings. I was
wrong on all three; each is reversed or re-reasoned below.

## New findings

- **N1 (MED) - ACT.** The corrected MED-4 comment replaced a wrong number with a
  false justification: "the sort key is the hydrated activity, so the window
  cannot be applied before the rows exist." Proven false - `row.lastActivityAt`
  comes from `maxConv.last_activity_at`, a CONVERSATION field produced by
  `resolveOpenThreads`; `latestMessageOf` and `placementLabel` are presentation
  only and are NOT sort inputs. Only the THREAD resolution must precede the sort.
  The sentence forecloses a real saving (probe: 5 message reads and 5 placement
  reads to render 2 rows; at the cap, ~340 discarded round trips).
  RULING: correct the sentence to say what is true, and record the available
  saving in the issue as a KNOWING deferral. Do NOT take the saving here - it is
  a performance change with its own test surface, and this branch's fix waves
  are chartered not to move behaviour.
- **N2 (MED) - ACT.** The new truncation WARN says "the hidden rows are the ones
  nobody has reviewed yet". Reachably false: on an all-`active` partition every
  hidden row IS one somebody reviewed. This is the single artifact an on-call
  reader sees, and a specific false claim reads as freshly verified. RULING:
  state the MECHANISM, not the outcome, and put the composition in the WARN's
  FIELDS so the reader sees it rather than being told.
- **N3 (MED) - ACT.** The class-(f) justification still cites `POST /api/contacts`
  defaulting an unknown create to `'active'` - but `KindPicker` offers no
  `unknown` segment, so NO OPERATOR CAN DO THAT CREATE. The operative mechanism
  is the status-only PATCH documented eleven lines below. RULING: point the
  justification at the real mechanism; mark the create default API-only. The
  class-(f) DECISION is unaffected and is not reopened.
- **N4 (MED) - FILE, do not fix here.** `audienceResolution.ts` is a THIRD
  bounded `byTypeStatus` reader carrying the same unstated sort assumption, with
  worse consequences: `TENANT_STATUSES` ascending starts at `inactive`, so a
  truncated audience keeps inactive tenants and drops `searching` tenants FIRST -
  the exact population a property-match send exists to reach. Live impact today
  none (10,000 bound against ~641 tenants). This is another feature's service
  file: scope-creeping into it is not this branch's call. RULING: file it as its
  own issue, add the repo's idiomatic `TODO(<issue-slug>):` marker at the walk
  (that is what AGENTS.md prescribes for exactly this), and name it in the
  unknown-tab issue's "shared read" argument, which currently lists only
  `today.ts`.
- **N5 (LOW) - ACT, and this one does move behaviour.** The partition loop ADDS
  to `emitted` and never consults it, while the sibling sweep loop three
  statements later does and calls it "a belt". Proven: a duplicated queue item
  ships two identical wire rows, which the dashboard keys identically - a
  duplicate React key and a doubled row. Reachability is narrow and the reviewer
  did not overstate it (a `status` flip mid-walk moves a row forward past the
  cursor; needs a multi-page walk, so >100 unknown contacts). RULING: take the
  one-line guard WITH a regression test that fails without it. A user-visible
  duplicate row is worth one line, and the asymmetry with the sibling loop reads
  as an oversight rather than a decision.
- **N6 (LOW) - ACT.** The `(unknown, active)` ZERO is what makes HIGH-1 latent
  rather than live, and it is the one figure a NARROWED measurement structurally
  cannot produce - yet it is recorded without citing `--no-status-narrow`, in a
  file that elsewhere insists on exactly that discipline. RULING: cite the flag,
  and add the `(unknown, active)` count to the reopen re-check list.

## Contested adjudications - I was wrong on all three

- **C1, LOW-10: REVERSED, take both halves.** My decline reason ("changing the
  instrument would invalidate the comparison the human is about to run") is sound
  for the instrument's BEHAVIOUR and reaches neither half of what was filed. A
  historical line in the docblock perturbs no measured value. And the misleading
  output line is worse than I credited: under `--no-status-narrow` the script
  prints `status mismatch 0 (should be 0 ...)` from a counter that is never
  incremented, INSIDE the output of the verification I am about to hand Cameron,
  where a `0` next to "should be 0" reads as a passed check. Suppress the line
  when the counter is inert; add the docblock line. No measured value moves.
- **C2, LOW-9: outcome UPHELD, my REASON withdrawn.** I wrote that a pre-check
  skipping the sweep would be "a design change to an approved requirement 3".
  That is wrong: requirement 3 is that the sweep carries NO SECOND BOUND, and a
  pre-check that decides whether to RUN it adds no bound. The real objection is
  the reviewer's and it is better: a bounded `deleted:true` probe is itself a
  filter-after-limit read over a partition the module argues accumulates residue
  forever, so it can answer "none found" while truncated - which reintroduces
  precisely the "missing for two different reasons" ambiguity this branch exists
  to remove. Record THAT reason, so the next person is not taught that
  requirement 3 forbids something it does not.
- **C3, MED-6 harness half: REVERSED in part.** Freezing the fake's SEMANTICS
  does not require the new coverage to depend on it, and the gap WIDENED at
  `a544fa1a`: the shared helper now models the range-key sort and the harness
  fake does not, so two suites exercising the same branch disagree about
  partition order. A COMMENT cannot move a pin. RULING: add a one-line note at
  the harness's `listByType` saying it is frozen for the `today.ts` triage pins
  and that new `filter=unknown` coverage belongs on the shared helper - and, in
  the same block, correct its adjacent claim to "MODELS `Limit` AS DYNAMODB
  APPLIES IT", which research flagged as true for `excludeOrigin` only. Comment
  only; no semantics touched.

## Also carried

- **V1 - ACT.** The fake's new rule 6 asserts that DynamoDB orders items sharing
  a GSI range-key value by their table key. The `status` half is documented and
  correct; the TIE-BREAK half is observed, not contracted. `today.ts` gets this
  right one file over ("intra-partition order is stable", deliberately not
  "ascending by contactId"). Weaken the tie-break wording to observed-not-
  guaranteed, so nobody later builds a cursor scheme on a fake's assertion.
- **MED-3 residual - ACT.** The corrected sentence "Only a type change (to
  tenant/landlord/partner) actually drains a row" is incomplete: a re-type to
  `team_member` drains it too, and so does a soft-delete.

## Verified, not acted on

The re-review independently verified the fix implementer's claim that the
status-only PATCH is the mechanism manufacturing the `(unknown, active)`
population - and made it sharper: it is the ONLY UI-REACHABLE manufacturer, the
create path being API-only. Its honest growth estimate is "slow but one-way, a
handful per year unless an operator adopts the status flip as their standard
dismiss gesture". HIGH-1's record-only ruling STANDS; N6 is the response.
