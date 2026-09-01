# Spec design review - round 1 adjudications

Spec: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md` @8b0466a4
Reviewers: A and B, dispatched in parallel, both `opus`, both plan-blind
(spec + repo only). Findings at `spec-review-A-findings.md` and
`spec-review-B-findings.md` in this directory.

Round 1 totals: A returned 20, B returned 22. After merging duplicates,
**31 distinct findings**.

Adjudication: ACCEPT (the spec changes) / REJECT (with reasoning) / DEFER
(filed to the issue registry). Severity labels below are the REVIEWERS' own.
Whether a decision CHANGED is the planner's call, recorded per item.

**Result: 24 ACCEPT, 4 REJECT, 3 DEFER. Six accepted findings changed a
DECISION rather than a wording - listed in the summary at the end.**

---

## The two findings that change the design

### ACCEPT - A2 / B1 (BLOCKING, both reviewers independently)

**Resolve-on-read for group rosters already ships, and one instance writes
back.** `app/src/routes/api.ts:2017-2117`
(`GET /api/conversations/:id/group-members`) reads every member's contact,
prefers the contact name over the roster snapshot with the comment "The
CONTACT's name is fresher than the roster snapshot taken at creation"
(`:2085-2086`), and then WRITES the refreshed roster back through
`backfillGroupTextRoster` (`:2099-2114`). Two more writers exist in
`services/groupConvert.ts:428, :504`, and `services/relayMembers.ts:47-49`
writes the live contact name at member-add time.

I verified this myself by reading `api.ts:2017-2117` before adjudicating.
It is exactly as reported.

**This falsifies the spec's framing.** Section 2 says refresh-on-write "was
considered and NOT chosen"; it is already running. Section 6.1 says "Nothing
in this spec removes or changes a writer"; there are writers of
`participants[].name` the spec never enumerated. The work is therefore NOT
"add resolve-on-read" - it is **reconcile an inconsistent set of existing
resolve-on-read mechanisms and extend them to the surfaces that have none**.

DECISION CHANGED. The spec is rewritten around that framing, section 3.2 gains
a `participants[].name` writer table, and S2 must state its precedence against
the existing converge-on-read write rather than racing it.

### ACCEPT - A1 (BLOCKING)

**Keying hydration on `p.contactId` misses the native `group_text` case.**
`services/groupConvert.ts:189-200` fills a missing `contactId` with
`contactIdForPhone(member.phone)`, a DERIVED id, and `:573-576` records that
converge can correct "a slot that pointed at a derived id with no row". The
shipped fix resolves by PHONE (`api.ts:2058` `findByPhone`) and treats the
stored `contactId` as the less trustworthy of the two (`:2089`).

I checked `services/groupMembers.ts:105-193`: a derived id usually DOES back a
real stub row, so A's claim is over-broad as stated. But the decisive case is
the one the route comment names - staff triage a nameless stub into a real
contact, and the roster's `contactId` keeps pointing at the stub. Phone-keyed
resolution survives that; id-keyed resolution does not.

REJECTED IN PART (the "resolves to NOTHING routinely" phrasing overstates it),
ACCEPTED IN SUBSTANCE. DECISION CHANGED: `withLiveNames` must resolve by
contactId AND phone, which changes the batch shape - `BatchGetItem` cannot read
the `byPhone` GSI (`repos/contactsRepo.ts:806-808`), so the phone rung needs
its own resolution strategy. The revised spec must specify it rather than
leaving a builder to invent one.

---

## Findings that collide with the human's own ruling

### ESCALATE TO CAMERON - A4 (HIGH)

`routes/relayGroups.ts:456-492` resolves relay roster names live and
**deliberately DELETES the stored name** (`:474-476`), returning a nameless
member on a contact read failure, with the policy stated in the comment at
`:471-473`: "Once a member has a contactId, never let that snapshot outrank
current contact state". Verified by direct read.

Cameron's 2026-08-31 ruling was "keep the stored copy as a last-resort
fallback". That ruling and this shipped, deliberately-commented policy
disagree on exactly the read-failure case section 4.2 rules on.

NOT adjudicated by the planner. This is a product decision the human already
answered once WITHOUT this information, so it is a legitimate re-ask rather
than re-litigation. Raised to Cameron before the spec gate.

---

## Accepted - correctness of claims about existing behavior

| # | finding | disposition |
|---|---|---|
| A6 / B2 (BLOCKING) | `routes/inbox.ts:534-543` is NOT a trim variant - it has an extra `contact.name` rung `contactName.ts` lacks. Re-pointing it renders those contacts NAMELESS. | ACCEPT. DECISION CHANGED: `inbox.ts` is REMOVED from section 8's re-point list. A regression that reintroduces this branch's own bug on another surface is not acceptable at any severity. |
| B4 (BLOCKING) | 4.2's fallback ruling applied to `composeConnectionSentence` (`relayFanOut.ts:189-206`), which DROPS nameless members. A throttled batch turns "connected with Alice, Bob and Carol" into "connected with 2 other people" - permanently, since the intro is idempotent behind a job marker (`:615-622`). | ACCEPT. DECISION CHANGED: the two once-only outbound bodies take `requireComplete` and fail the job so redelivery retries. 4.2's ruling is scoped to DISPLAY surfaces explicitly. This is the finding I am most glad to have; the spec asserted the opposite in the same breath as calling 4.2 "the opposite ruling from a SEND path". |
| A3 / B3 / B5 (HIGH) | Unenumerated `participants[].name` readers reaching a device: `twilio.ts:1810` (group push title), `:1815` (push sender label), `voice.ts:112-117` `maskedPartyLabel` (relay caller identity). B adds `poolNumbersAdmin.ts:109`, `tours.ts:1351`, `relayGroupDuplicates.ts:129`, `groupSend.ts:253`, `rosterEdits.ts:399-404,473,543-547,672`, `rosterResolution.ts:219-228`, and client readers via `api.ts:1993-2002` and `:2190-2198`. | ACCEPT in full. DECISION CHANGED: the spec gains a complete `participants[].name` reader table, and S2's boundary list grows. B5 is also right that `pushSenderLabel` (`twilio.ts:307-315`) and `maskedPartyLabel` put the SNAPSHOT first - so section 3.1's "blessed pattern" claim is false for the group/relay chain and is rewritten. |
| B6 (HIGH) | Partial hydration reintroduces the one-thread-many-names divergence `lib/groupTitle.ts:1-16` exists to prevent - inbox says "With Alice & Bob", the push for the same event says "With (555) 010-0002". | ACCEPT. Follows from A3/B3. The revised spec hydrates every `groupThreadLabel` / `relayMemberLabels` caller or states explicitly which are left and why. |
| B7 (HIGH) | S5's audit extension cannot work by removing the skip: `listByLastActivity({status:'open'})` never returns `group_text` (status is `group_open`) or closed relay groups. | ACCEPT. Verified against `routes/inbox.ts:1216` (`listGroupTexts`) and `routes/contacts.ts:1158-1168` (two relay partitions). S5 is rewritten to name the new sources. As written a builder would have shipped a pass reporting zero group rosters and called the fix proven. |
| A5 (HIGH) | Section 9's `npm run perf:pages` cannot count server-side contact reads - it is a browser-side network profiler (`e2e/performance/collect.ts`). | ACCEPT. DECISION CHANGED: section 9's instrument becomes a repo-call counter in a test, the same mechanism section 10 already uses to pin S1's zero-new-reads claim. The issue's own text demanded a number; the spec named a tool that cannot produce it. |
| A12 / B9 (HIGH/MEDIUM) | S1's client note is self-contradictory and its contingency impossible: `buildToday.ts` is the live CLIENT-SIDE FALLBACK used only when `/api/today` fails (`useToday.ts:54-75`), so "fall back to the server `who`" cannot happen there. | ACCEPT. Rewritten to the honest disposition: the fallback path is degraded by design and stays degraded; say so. A12's second half - that `dashboard/src/lib/groupThread.ts` computes client-side rather than reading a server value - is also correct and the section 4 sentence is corrected. |
| B10 (HIGH) | The mechanism cannot deliver name DELETION: `contactDisplayName(...) ?? p.name` conflates read-failure, absent contact, and empty name, so clearing a wrong auto-captured name leaves the stale one rendering forever. | ACCEPT as a stated limitation. The guarantee in section 2 is narrowed to what the mechanism delivers: "resolve a NON-EMPTY live name, else the snapshot". Making key-presence meaningful is possible but interacts with the read-failure ruling now with Cameron, so it is settled there, not here. |
| A7 (MEDIUM) | `poolNumbersAdmin.ts:109` and `rosterResolution.ts:216-228` falsify "they simply receive correct data". | ACCEPT. The sentence was true only of hydrated boundaries. Corrected. |
| A10 (MEDIUM) | Hydrating `GET /api/conversations/:id` adds a batch read to a zero-read passthrough refetched per SSE tick; `GroupTextView.tsx:200-206` records a production symptom from latency on a sibling per-tick read. | ACCEPT. Added to the risk table with a mitigation. |
| A11 (MEDIUM) | Two of S4's three sites buy little: intro and member-added rosters were written from the live contact seconds earlier by `resolveMemberName`. Only the sender prefix is genuinely stale. | ACCEPT. S4's cost/benefit is restated honestly. Note this now interacts with B4: the two low-value sites are exactly the ones B4 wants `requireComplete` on. Both stay, with the drift each catches named. |
| B11 (MEDIUM) | `withLiveNames` has no soft-delete guard; `getManyByIds` does not filter deleted contacts and every comparable site guards (`rosterResolution.ts:522`, `api.ts:2095`, `:2157`). | ACCEPT. DECISION CHANGED: the helper gains an explicit soft-delete posture. |
| A8 / B12 (MEDIUM) | The spec mandates `getManyByIds` against the repo's own written guidance at `contactsRepo.ts:600-605` ("Prefer `getDisplaysByIds` when only a label is needed"), which also projects `deleted_at` - what B11 needs. | ACCEPT. DECISION CHANGED to `getDisplaysByIds`. Six in-tree precedents cited. |
| A9 / B13 (MEDIUM) | "ONE `getManyByIds` per page" is not one round trip - `batchGetByIds` chunks at 100 with up to 4 attempts per chunk. The pinned call-count test measures the wrong quantity. | ACCEPT. The test asserts UNIQUE ID COUNT and the risk row states a key-count bound. B13's addendum - `contacts.ts:1265-1267` reads threads BEFORE filtering, so naive id collection hydrates rosters that are then discarded - is also accepted: collect ids AFTER the filter. |
| A15 (MEDIUM) | Re-pointing `today.ts:224` changes `who` for placement, tour and AI-suggestion rows outside S1's scope - true of the FILE, false of the SURFACES. | ACCEPT. The re-point is dropped from this branch. |
| B14 (MEDIUM) | S4's per-message `getById` has no failure posture and no bare-phone guard; `senderMember.contactId` can be `''` (`relayMembers.ts:76`). | ACCEPT, together with A18 (gate the read on the override being absent). Both become explicit preconditions. |
| B16 (MEDIUM) | S4 creates a preview/send divergence: `rosterEdits.ts:472-473` and `:672-676` compose the operator PREVIEW from stale names, and `relayFanOut.ts:633` honours a persisted edited body verbatim - so an operator who edits a stale-named preview pins the stale names past the fix. | ACCEPT. The preview composers are added to S4. This is a genuinely nasty interaction neither I nor reviewer A saw. |
| A14 / B17 (MEDIUM) | Section 8's census is wrong both ways: omits `services/inboundEmail.ts:400` (named in `contactName.ts`'s own scope guard) and `routes/placements.ts:165`, and miscounts `lib/voiceMasking.ts:47` `contactShortName`, which returns "First L." - a deliberate privacy rule, not a trim variant. | ACCEPT. The count and the table are rebuilt. Shipping the spec's number would have written a new wrong count over the old wrong count in the issue file. |
| A20 / B18 / B22 (LOW/MEDIUM) | The spec lifts the in-code SCOPE GUARD at `contactName.ts:50-60` ("do not re-point them here as a drive-by") and widens the "PUSH-COPY sites only" contract without acknowledging either. | ACCEPT. The guard comment is amended in the same change, or the spec stops re-pointing. Given A15 and A6/B2 both remove re-points, section 8 now touches very little - see the summary. |
| A13 / B19 (MEDIUM/LOW) | 4.1's "never throws / input unchanged" misdescribes the primitive: without `requireComplete`, `batchGetByIds` swallows a failed chunk (`:839-844`) and returns a SHORT map. The section-10 test targets an impossible path. | ACCEPT. Contract and test rewritten for the partial map. |
| A16 / B20 (LOW) | Citation errors: `contacts.ts:1741` is the email loop (phone is `:1738`); `:1170` is not the documenting comment (`:1158-1168`) and it names two partitions not three; "four more readers" over a seven-row table; `:510` vs `:509`; S3's expression spans `:544-545`. | ACCEPT all. In a spec whose authority rests on "verified against main @5ce9912f", sloppy line numbers corrode exactly that authority. |
| A17 (LOW) | Risk table's "the two paths that carry names into delivered messages" contradicts S4's own three sites and ignores the push titles. | ACCEPT. |
| A19 (LOW) | Unenumerated seed surface: `seed/performance.ts:842, 857-858` bake stale names against real contact ids, in the lane section 9 drives. | ACCEPT. Added as explicit fixture work. Both reviewers separately confirmed `lean` and `cast` are consistent, so e2e strings are safe. |
| B21 (LOW) | `buildToday.ts:106` keeps the bare-`??` empty-string bug S1 hardens server-side. | ACCEPT as a one-line client fix, since B9/A12 establish the path is live. |

---

## Rejected

**A13's headline, REJECTED IN PART.** "Section 4.2 is a slogan: the ruling is
inherited, not argued" - the repo's guidance at `contactsRepo.ts:790-804` does
make this ruling in these terms, and A is right that the heading
"(argued, not inherited)" overclaims. The heading changes. But A's implication
- that restating it invites re-litigation of settled policy - is wrong in the
opposite direction: B4 proves the ruling is NOT uniformly right for this spec,
because one consumer is a once-only outbound body. Restating it per-surface is
what caught that. The section stays; only its self-congratulatory heading goes.

**A1's "resolves to NOTHING routinely", REJECTED as stated.** Verified against
`services/groupMembers.ts:105-193`: a derived id normally backs a real stub
contact row. The substance is accepted (see above) on the narrower and
sufficient triage-merge case; the frequency claim is not supported.

**B15's framing "the writer enumeration weakens the argument it is offered
for", REJECTED as an argument.** The enumeration is incomplete and that is
ACCEPTED as a correction. But B treats the omission as undermining the case
against refresh-on-write, when A2/B1 shows the opposite: the existing
write-side mechanism has drifted into three inconsistent implementations, which
strengthens the case for consolidating on read. Correcting the table does not
change the strategy.

**"Speculative" scope additions, REJECTED.** Neither reviewer proposed
significant scope creep - noted for the record, since the brief asked them to
avoid it and both complied. B's suggestion to "make the map's key-presence
meaningful" (B10) is the only additive proposal and is DEFERRED, not rejected.

---

## Deferred to the issue registry

1. **B10's key-presence proposal** - distinguishing read-failure from
   empty-name requires a richer return from the batch layer. Real, but it is a
   repo primitive change, not this branch. File against
   `contacts-batchget-amplified-reads`.
2. **A3/B3's `poolNumbersAdmin.ts:109` and `relayGroupDuplicates.ts:129`** -
   staff-admin surfaces, not operator-facing, and outside every issue in M1.
   File a new issue rather than widen this branch.
3. **B5's two backwards-precedence push sites** (`pushSenderLabel`,
   `maskedPartyLabel`) - IN scope to fix if the Cameron ruling above lands on
   uniform precedence; otherwise filed. Held until that answer.

---

## Summary: six accepted findings changed a decision

1. The spec's framing (A2/B1) - from "add resolve-on-read" to "reconcile
   existing ones".
2. Hydration keying (A1) - contactId alone is insufficient; phone is needed.
3. Outbound bodies (B4) - `requireComplete` on the two once-only sends.
4. Batch primitive (A8/B12) - `getDisplaysByIds`, not `getManyByIds`.
5. Section 8's scope (A6/B2 + A15) - `inbox.ts` and `today.ts` re-points
   removed; the section now touches almost nothing.
6. Section 9's instrument (A5) - a repo-call counter, not `perf:pages`.

Round 1 therefore CHANGED DECISIONS and does not satisfy the stop rule. A
round 2 is required, on the revised spec, per the skill's re-review charge.
One question is escalated to Cameron first, because its answer changes what
the revision says.
