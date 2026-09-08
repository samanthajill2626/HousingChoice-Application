# Code review R1 - SPEC CONFORMANCE

Branch `feat/relay-30003-retry-lineage` @ `17bf49a7`, merge base `f82c149c`.
Read-only pass over the tree, not over the slice reports. Every verdict below is
anchored to code or a test on the branch. No suite was run: gate 4 was still in
flight (`.superpowers/sdd/gate-e2e.exit` absent for the whole review).

Contract read in order: spec (Sec 2 fences, D1-D23, Sec 7's twenty intentions,
Sec 8's four obligations, Sec 9), plan Tasks 1-15 + Global Constraints,
`research-adjudications.md` (S1-S12, D1-D9, E1-E6, A1-A2), `progress.md`'s
build-time rulings B1-B5, then the nine slice reports and the live tree.

Counts: **A** 16 CONFORMS / 1 PARTIAL / 0 MISSING. **B** 19 proven / 1 weak /
0 missing. **C** all fences intact, all four Sec 8 obligations met.
**E** 1 MUST-FIX, 1 SHOULD-FIX, 5 NOTEs, 0 BLOCKING.

---

## A. Work map

| Item | Verdict | Evidence | Deviation |
|---|---|---|---|
| T1 lineage fields + media-pointer suppression | CONFORMS | Six `NewMessage` fields `app/src/repos/messagesRepo.ts:730-753`; six snake_case twins `:995-1010`; persisted `:2215-2233`; `isRelayRetryRow` `:2283`; pointer guard `:2361` (`item.media_attachments !== undefined && !isRelayRetryRow`). Identity module `app/src/lib/relayRetryClaim.ts:13-35` | None. S6/S7 (gallery reader excludes relay by name; `mediaPointerCount` does not exist) adjudicated and honoured - T1 proves the suppression by a direct read |
| T2 consistent read on the interface + typed fakes | CONFORMS | Interface `messagesRepo.ts:1380-1392`; factory `:3052-3055` binds the EXISTING private closure (`getByTsMsgIdConsistent: getMessageConsistent`), no second `GetCommand`; `getByTsMsgId` untouched. Fakes fixed in `app/test/helpers/twilioWebhookHarness.ts`, `scheduledSendSuppression.test.ts`, `sendMessage.test.ts`, `contactCapture.test.ts`, `registerHandlers.test.ts` (S9's list) | None |
| T3 `sendOneRelayLeg` extraction, behavior-preserving | CONFORMS | `app/src/jobs/relayFanOut.ts:1251-1440`; loop now a call `:1123-1147`; the two mutated bindings rebuilt from `outcome.kind` `:1143-1146`. `RelayTransportMode` exported `:958`; `RelayLegPayload` `:1194`; `RelayLegSendOutcome` `:1206`; adapter typed `MessagingAdapter & CarrierMessageSender` (S1). The outside-the-loop media-without-store ERROR stayed put `:1015-1024` (S5) | None. Every `continue` maps 1:1 to a `kind`; the non-refusal / non-30007 / non-transient send error still rethrows |
| T4 status-preserving bump | CONFORMS | Interface `app/src/repos/conversationsRepo.ts:650-681`; impl `:1623-1646` - `SET last_activity_at[, last_message_preview]`, `ConditionExpression: attribute_exists`, no `#s = :open`, no `#type` guard; returns `ConversationItem` (S11) | None |
| T5 wire fields | CONFORMS | `dashboard/src/api/types.ts:2299-2308` (`Message`) and `:2492-2509` (`TimelineMessage`); projector `dashboard/src/routes/conversation/useRelayThread.ts:126-141`, four fields, digest and leg body withheld. All three relay hosts route through this one projector (`ConversationDetail.tsx:178`, `TourConversation.tsx:420`, `PlacementConversation.tsx:280`) | None. `dashboard/src/lib/messageTransport.ts` untouched, as plan T5 required |
| T6 `relayRetryJoin` with TWO lifetimes | CONFORMS | `dashboard/src/routes/contact/relayRetryJoin.ts` - lineage half `indexRelayRetries` `:131`, time half `projectRelayLegs` `:404`; `EffectiveRelayLeg extends RelayRecipientDelivery` `:69` (adjudication D1) with a compile-time assignability assertion `:79-80`; `retryState` a separate field, never in `status` | None |
| T7 the D20 visible filter | CONFORMS | `Timeline.tsx:1976-1991` - a SECOND rule beside `supersededIds` `:1956`; narrows `kind === 'message'` first (D6-D8); origin direction must be `'outbound'` `:1982`; delivered read off the row's OWN slot `:1990`, not the join, so `visible` stays a pure function of `items` | None |
| T8 presenter arithmetic / composition / copy / codes | CONFORMS | `deliveryStatus.ts` - `RetryAwareRelayLeg` `:177`; `retryAware` `:386` + `retryRow` `:396`; K/R/suffix/J at `:468`, `:475`, `:478`, `:483`; fixed-order compose `:498-503`; four internal codes `:864-867`. With `retryAware` absent every count collapses to the two shipped today (`retryStateOf` `:462`) | B3 (suffix first after the dash) - adjudicated, and faithful to D19's own table (`delivered 4/4 - 1 on retry`) |
| T9 four live positions + ticker clause | CONFORMS | Projection `Timeline.tsx:1017-1027` (deliberately un-memoized, `nowMs: bubbleNowMs`); rollup `:1041-1059`; rows/recitals off `orderRecipientRows(projectedEntries, ...)` `:1064`; `recipientSummaryName` reason precedence `:603-609`; per-recipient row `:1247-1257`; inbound recital `:1124-1134`. Ticker clause `hasTickableLeg(msg, tickNow, retries)` `:817-877`, armed at `:2058-2060` with `retryIndex` in the deps. All THREE counts updated (D2): `:763` FIVE+a sixth, `:817` SIX clauses, `:2013` "six non-terminations" | None. Message-level chip left out of the projection `:1101-1107`, as D19 requires |
| T10 tour and placement hosts | CONFORMS | `TourConversation.test.tsx` +2 tests through the real `api` mock with `makeChannels`/roster mocks (D4/D5); `PlacementConversation.test.tsx` +2. Both assert the chip and the bubble count on the milestone-merged and raw lists | None |
| T11 `relayRetryLeg` job | CONFORMS | `app/src/jobs/relayRetryLeg.ts` - marker first `:264-273`; consistent re-read `:278`; transport mode off the RETRY row `:293-301` classified afresh; four gates in order `:347-411`; send `:417-432`; `sent` bump with `undefined` preview `:440-444` (S3); transient sub-ladder `:452-494`; `refused/filtered/suppressed` log only, no re-close `:501-513` (S2); registered `registerHandlers.ts:57-64` | See finding 5 (NOTE): no twin of the fan-out's media-without-store ERROR |
| T12 claim + SSE + enqueue-failure close + escalation condition | CONFORMS | `twilio.ts:2635-2834`. Helper returns a value and never returns out of the caller `:2888`; tail always runs `:2906-2969`. Code gate `:2643`, consistent read `:2652`, POSITIVE fence `:2666-2670`, `To` E164 `:2677-2680`, slot state gate `:2691-2698`, cap `:2705`, root `:2706-2709`, mirrored append `:2727-2776` with NO `retryOf` `:2773`, enqueue + D14 close `:2787-2818`, SSE for the ROOT `:2827-2832`. Escalation gains exactly ONE condition `:2966`; `flagPlacementAttention`'s body `:510-532` is untouched | See finding 2 (SHOULD-FIX): the helper cannot return early, but it CAN throw |
| T13 severity + `retryClaim` | **PARTIAL** | `isTerminalRelayLegFailure` `twilio.ts:395-402` implements S2a's mapping; `retryClaim` + `retryAttempt` on the failure object `:2919-2920`; own message for `source_unreadable` `:2922-2925`; shared-set comment rewritten `:323-338` naming the group-text exception and the issue | The predicate ERRORs a leg whose slot already reads `delivered` - outside the founder-approved set. Finding 1 |
| T14 hermetic browser proof | CONFORMS | `e2e/tests/dashboard-next/relay-30003-retry.spec.ts` (renamed via `git mv` - the old path is deleted in the diff); both moments asserted, one atomic evaluate for the retrying window `:203-230`; three positions `:239`, `:263`, `:279`; send counts `:300-315`. Seam `registerHandlers.ts:56-64`, lane value `scripts/e2e-session.mjs:254-260`; `selectors.md:49` rewritten (E3) | Spec Sec 2 named `routes/dev.ts`; the tree uses `registerHandlers.ts`. RECORDED (plan File Structure, plan T14, adjudication E1) - not silent. Finding 4 (NOTE) |
| T15 issues | CONFORMS | Both anchors `status: resolved` + `resolved: 2026-09-02` with a Resolution paragraph walking all NINE acceptance criteria (`docs/issues/relay-30003-retry-lineage.md:143-216`); quiet-hours annotated, still `status: open`; both filed issues still OPEN and corrected per E4/E5 | None |
| E2 = B4 + B5 | CONFORMS | B4: `RelayDeliveryOptions.retryRow` `deliveryStatus.ts:396`, branch `:544-550`, passed from the row `Timeline.tsx:1058`. B5: `isRetryRungLive` `relayRetryJoin.ts:217-229` - with a reading clock, a rung that `canRetryRungGoQuiet` rejects is NOT live, so it resolves `unconfirmed` `:365-368` | Both adjudicated. B5 extends D18 (a clockless rung is past no horizon) but closes the permanent-`retrying` hole D18 exists to close - correct. Finding 7 records its one asymmetry |
| R1 + R2 = B1 + B2 | CONFORMS | B1 (`unconfirmed` row reads today's not-confirmed copy): quiet rung overlaid `relayRetryJoin.ts:365-368`, mapped `deliveryStatus.ts:693-701`. B2 (deciding rung's leg for `delivered-on-retry`): `withDecidingRung` `relayRetryJoin.ts:254-279`, `requestedTransport` preserved deliberately | Both adjudicated. `withDecidingRung` clears `errorCode` on both overlaid states; harmless, since neither presentation renders a reason |

---

## B. Spec Sec 7 - the twenty test intentions

Files: `WEB` = `app/test/relayRetryClaim.webhook.test.ts`, `JOB` =
`app/test/relayRetryLeg.test.ts`, `SEV` = `app/test/twilioStatusWebhook.test.ts`,
`JOIN` = `dashboard/src/routes/contact/relayRetryJoin.test.ts`, `DEL` =
`dashboard/src/routes/contact/Timeline.delivery.test.tsx`, `TICK` =
`Timeline.ticker.test.tsx`, `TL` = `Timeline.test.tsx`, `DS` =
`deliveryStatus.test.ts`, `E2E` = `relay-30003-retry.spec.ts`.

| # | Verdict | Test |
|---|---|---|
| 1 | proven | WEB "claims exactly one retry for a forward 30003 on a relay leg". Cannot pass on main - no retry row is ever created there |
| 2 | proven, BOTH guards separately | WEB "claims nothing twice for a duplicate callback, and says so on the line" (the create) AND JOB "sends nothing on a redelivered job (the execution marker)" (the queue). E6 records that the marker is unit-proven only - the lane runs a job once |
| 3 | proven | WEB "stops at the cap and says the cap is what stopped it" - asserts `retryRows()` has length **3** after five failures, not "a retry happened" |
| 4 | proven (note) | WEB "claims nothing for an announcement leg, and keeps it at WARN" + "claims nothing when the source row cannot be read, with its own message". The tour-reminder half is by construction, not by fixture: `SYSTEM_SENDER_KEY` has one writer, so an announcement leg and a tour rung are the same shape at the fence |
| 5 | proven | JOB `it.each(gateCases)` "refuses on %s and closes the retry leg with the gate code" (all four codes, plus `enqueueSpy`/`outbound.delayed` empty and one ERROR line) + JOB "compares the DIGEST, not the current phone, on the changed-number gate" as its own test + JOIN "projects a gate refusal code onto the original leg" + DEL "projects a terminal close code onto the row and the chip reason" |
| 6 | proven | WEB "closes the retry leg enqueue_failed when the enqueue throws" and its versioned twin; prose proven by the pre-existing DS "reads a CAPPED fan-out row as operator prose, with no carrier-code tail" / "reads a NEVER-SCHEDULED fan-out row distinctly, also without a tail" plus DS `it.each(RETRY_CODES)` "renders %s as prose with no (error N) tail" |
| 7 | proven | WEB "never sends to any other member, on any rung" - three sends to the member, zero to anyone else, across five callbacks. E2E confirms in a browser: reachable `['delivered']`, unreachable `['undelivered','delivered']` |
| 8 | proven (display); server half by construction | JOIN "keeps delivered-on-retry when an older rung reports failure afterwards" and "keeps delivered-on-retry when a later rung is still queued". No server test asserts the regression is impossible - it is structural (each rung owns its own row and slot, so `ALLOWED_PRIOR` never sees a cross-rung transition) |
| 9 | proven | JOB "re-enqueues the SAME rung on a transient send error, consuming no retry rung" (asserts `relay_retry_attempt` still 1) + "closes with transient_cap when the retry row pass budget is already spent" + "closes with transient_cap on the LAST claimable pass rather than enqueueing an unreachable rung" |
| 10 | proven | JOB "re-presigns attachments on every attempt", JOB "sends exactly one leg, the stored leg copy verbatim, after a sender rename", WEB "stores the RAW body on the row and the composed leg copy beside it", `messagesRepoRetryLineage.integration.test.ts` "writes no media-pointer rows for a retry row" + "round-trips the attachments a retry row re-presigns from" |
| 11 | proven | WEB "never stamps retry_of on the retry row" (writer) + TL "never hides the original" (reader). Confirmed structurally: `retryOf` appears in `twilio.ts` only in the comment at `:2773`, and `supersededIds` reads `retry_of` alone (`Timeline.tsx:1951`) |
| 12 | proven | DEL block "Timeline relay retry states - the chip, the recital and the row together": "shows delivered-on-retry at the chip, the recital AND the row"; "shows a live ladder as retrying, with the carrier reason, at all three positions"; "projects a terminal close code onto the row and the chip reason"; "reads a stranded claim as not confirmed on the row as well as the chip"; the inbound recital as its own test - "updates the inbound recital when a member-originated leg recovers" (asserts `queryByRole('img')` is null); "renders a bubble with NO retry rows exactly as it did before". Shared label: DS "leaves the all-delivered label untouched without a retry" + "ignores retryState entirely without the retry-aware flag" |
| 13 | proven | WEB "emits message.persisted for the ROOT even when nothing transitioned" (SSE on the claim) + JOB "bumps a group closed mid-backoff without reopening it, and rewrites no preview" (status-preserving, asserted on the group's status, not on a call count) + E2E's pre-backoff `1 retrying` poll |
| 14 | **WEAK** | SEV "logs WARN while a retry is claimed and ERROR once the ladder is exhausted", "keeps 21610 at WARN on a relay leg", "keeps an announcement leg at WARN", "leaves the 1:1 severity unchanged". Two gaps: (a) the intention names "the 1:1 AND native-group-text paths"; only the 1:1 path has a test - the group-text half rests on the shared set being value-identical (`twilio.ts:339`); (b) no case covers a 30003 landing on a slot that already reads `delivered`, which is finding 1's escape |
| 15 | proven | TICK "flips retrying to not confirmed as the clock passes the budget - observable: the rendered chip text, with no refetch and no item change" + TICK "ARMS for a live retry with no other activity" (thread whose every rendered leg is terminal - freezing the ticker IS the failure mode, and no other leg is left able to age) |
| 16 | proven | WEB "RECOVERS a claim lost to a crash between the slot write and the claim" - writes the slot terminal first, then replays. A transition gate fails this |
| 17 | proven | WEB "claims when a code-less terminal callback landed first" |
| 18 | proven | WEB "a LEGACY original produces a legacy retry row and a legacy slot" (+ the versioned twin, + "a versioned INBOUND original carries no message-level requested transport") and JOB "drives a LEGACY retry row down the legacy path" |
| 19 | proven, asserted as FIELDS | All ELEVEN `RelayRetryClaimOutcome` values are asserted somewhere: `claimed`, `already_claimed`, `cap_exhausted`, `gate_refused`, `fenced_announcement`, `to_missing`/`to_malformed` (WEB `it.each` at `:437-452`), `source_unreadable` (WEB `:429`, SEV `:1329`), `slot_ineligible` (WEB `:395`), `code_not_retryable`, `enqueue_failed`. `relayRetryClaim.test.ts` "enumerates exactly the eleven claim outcomes" pins the union itself. SEV "ERRORs an unreadable source with its own message" asserts the distinct message |
| 20 | proven | TICK "STOPS on its own horizon - observable: window.clearInterval with the ticker id, and setInterval never runs a second time" AND "CLEARS the interval once the retry resolves". Distinct from #15, as the spec demands. Two further terminations pinned: "schedules NOTHING for a rung ALREADY past its horizon" and "neither arms nor promises retrying for a rung with no clock at all" |

**Rubber-stamp check.** Three tests would pass with the feature reverted, and all
three are deliberate fences rather than proofs: TL "renders a delivered retry of
an outbound original" (main renders every row, so the positive case is
vacuous - the `it.each` negative cases beside it are the real proof), TL "leaves
the existing retry_of collapse untouched", DS "ignores retryState entirely
without the retry-aware flag" / "leaves every chip untouched when retryRow is
false". Nothing else in the added suites passes on the merge base.

---

## C. Sec 8 obligations and the hard fences

**Obligations.**

1. MET. `docs/issues/relay-30003-retry-lineage.md` and
   `relay-30003-classified-transient-retrying.md` both `status: resolved`,
   `resolved: 2026-09-02`, each with a Resolution paragraph; the lineage issue
   walks all NINE acceptance criteria one by one (`:143-216`), including the
   honest "Met in substance; the 'one bubble' wording was SUPERSEDED" on #6.
   `npm run issues` regenerates a gitignored index, so there is nothing to see
   in the diff; `progress.md` records exit 0 / 286 open / 176 closed.
2. MET. `relay-member-key-collapses-two-phones-one-contact.md` is `status:
   open` and records BOTH workarounds scoped to the retry path
   (`:62-80`): the destination-keyed digest claim identity, and the pre-send
   digest comparison closing with `retry_number_changed`. E5's correction landed
   (the digest is on the retry ROW, not "on the leg").
3. MET. `relay-inbound-source-has-no-delivery-rollup.md` is `status: open` and
   names all three hosts (`:42-45`), with the tour host's merged-list note; E4's
   correction landed - the sentence now says no CHIP, while the rows and the
   `inboundRecipientName` recital DO carry the states (`:66`).
4. MET, not closed. `quiet-hours-ungated-automated-paths.md` stays `status:
   open`; the annotation names the new path, `relayRetryLeg.ts` in `refs:`, and
   states that the ~7-minute bound holds value for value, plus the transient
   sub-ladder note.

**Fences.** `git diff --stat f82c149c HEAD` over each named path:

- `app/src/services/relayAnnouncements.ts` - EMPTY (untouched). Its exports
  `isMemberSuppressed` / `logSafeMemberKey` are imported, never modified.
- `app/src/jobs/tourReminders.ts` - EMPTY.
- `app/src/jobs/retrySend.ts` and `app/src/services/sendMessage.ts` - EMPTY.
  The 1:1 retry path is untouched in code as well as in behavior.
- Native group-text receipts - untouched: the presenter's new arithmetic is
  behind `opts.retryAware` (`deliveryStatus.ts:462`), which only the relay
  Timeline sets (`Timeline.tsx:1052`, `retryAware: isRelayLeg`), and the new row
  copy is behind `rosterKind === 'relay'` (`deliveryStatus.ts:669`). DS "leaves a
  native group-text leg with no retryState untouched" and "leaves a queued native
  group-text leg carrying unconfirmed untouched" pin both gates.
- The 1:1 retry/collapse path - `supersededIds` (`Timeline.tsx:1948-1956`) is
  byte-unchanged in the diff; the D20 rule is a separate `if` beside it.
- `stalenessClockMs` - not touched; it does not appear as a `+`/`-` line
  anywhere in the diff (only in comments explaining why it is NOT used).
  `isStaleLeg` / `canEverGoStale` bodies unchanged; only call sites moved.
- `ALLOWED_PRIOR` - zero hits in the `messagesRepo.ts` diff. D1's whole point
  holds: `queued -> sent -> delivered` on a fresh slot needs no exception.
- The rollup chip's `outbound` gate - `Timeline.tsx:1040`
  (`outbound && msg.delivery_recipients && msg.delivery_status !==
  'queued_pending'`) appears as an unchanged CONTEXT line in the diff.
- `flagPlacementAttention`'s body - `twilio.ts:510-532` is not in the diff. The
  ONLY change is one added condition at the call site (`:2966`), inside the
  pre-existing `if (transitioned)` / `if (mapped is failure)` pair.

**Global Constraints.** Vendor SDK imports: none added outside
`app/src/adapters`. Job traffic: `defineJobHandler` / `enqueue` only
(`relayRetryLeg.ts:233`, `:153`, `:478`). Ladder: 3 / 60s / 120s / 240s
(`relayRetryClaim.ts:13-18`), trigger code 30003 and only 30003
(`twilio.ts:355`, `:2643`).

---

## D. Mission watch items

| Watch item | Result |
|---|---|
| Retry row NEVER carries `retry_of`, writer AND reader | PASS. Writer: `messages.append` in the claim sets no `retryOf` - the only occurrence of the token in `twilio.ts` is the warning comment at `:2773`. Reader: `supersededIds` is built from `i.retry_of` alone (`Timeline.tsx:1951`), and the D20 rule reads `relay_retry_of` (`:1976`). Pinned by WEB "never stamps retry_of on the retry row" and TL "never hides the original" |
| `retryState` never smuggled into `status` | PASS. Separate optional field on `RetryAwareRelayLeg` (`deliveryStatus.ts:177`) and `EffectiveRelayLeg` (`relayRetryJoin.ts:69`). The only `status` values the join ever writes are `'delivered'` (`:336`) and the quiet rung's own `queued`/`sent` via `withDecidingRung` (`:270`) - all inside the closed `DeliveryStatus` union. `retrying` and `terminal` do not touch `status` at all (`:347`, `:376-380`) |
| The join has TWO lifetimes | PASS, and the exact code: LINEAGE half memoized on items - `Timeline.tsx:2007` `const retryIndex = useMemo(() => indexRelayRetries(items), [items]);`. TIME half NOT memoized - `Timeline.tsx:1017-1027` builds `projectedEntries` inline on every render, passing `nowMs: bubbleNowMs` (the value `bubbleClocks(msg, tickNow)` returns at `:996`). The ticker memo carries `retryIndex` in its deps (`:2058-2060`) so a new item set re-arms |
| Claim helper: no early return out of the handler; the tail always runs | PASS for RETURNS. `claimRelayRetry` (`twilio.ts:2635-2834`) has ten `return { outcome: ... }` statements and zero that leave `handleRelayRecipientStatus`; the failure log (`:2906-2928`), the existing SSE (`:2929-2938`) and the escalation (`:2939-2970`) all sit after the single call site at `:2888`. NOT proof against a THROW - see finding 2 |
| Legacy-original case handled on EVERY rung | PASS. `versioned = src.transport_schema_version === TRANSPORT_SCHEMA_VERSION` (`twilio.ts:2717`) is re-evaluated per callback, and on rungs 2-3 `src` IS the previous retry row, which mirrored the root transitively. The job re-derives the mode from the RETRY row (`relayRetryLeg.ts:293-301`), never from the root - which it deliberately never reads (`:282-285`) |
| Mode-appropriate seeded slot | PASS. Versioned: `{status:'queued', requestedTransport?, transportAggregationState:'planned'}` (`twilio.ts:2749-2756`); legacy: `{status:'queued'}` (`:2757`). `transportSchemaVersion` is spread only when versioned (`:2747`). No message-level `requestedTransport` is ever set, so the inbound prohibition is respected while the SLOT still carries one |
| 60/120/240 ladder and the 3-rung cap | PASS. `MAX_RELAY_RETRY_ATTEMPTS = 3` and `60_000 * 2 ** (attempt - 1)` (`relayRetryClaim.ts:13-18`); cap enforced at `twilio.ts:2705` (`attempt > MAX` -> `cap_exhausted`). JOB's backoff-seam describe pins the fallback on BOTH the free enqueue and the handler (E2) |
| `E2E_RELAY_RETRY_BACKOFF_MS` never set outside the lane | PASS. `git grep` finds it in exactly three non-doc places: the reader `registerHandlers.ts:57`, the lane literal `scripts/e2e-session.mjs:260`, and its own tests. ZERO hits in any `.env*`, `*.example`, `infra/`, or `*.tf`. Guarded by `Number.isInteger(x) && x > 0`, and JOB `it.each(['abc','0','-5','','  '])` pins the rejection |
| PII: no phone in a sort key or a log line | PASS. The sort key's second half is `relayretry-<16 hex>-<n>` (`relayRetryClaim.ts:33-35`), pinned by "emits no '#' and no phone digits from the destination". Every new log site redacts: `logSafeStoredRelayMemberKey` (`twilio.ts:410-412`) and `logSafeStoredMemberKey` (`relayRetryLeg.ts:178-180`) both collapse `phone#...` to `phone-only-member`; the roster-member sites use the existing `logSafeMemberKey`. No `body`, `legBody`, `to` or `phone` field appears on any new log object; the job payload is identifiers only (`relayRetryLeg.ts:73-77`), pinned by JOB "puts no body and no phone number on the queue or in the logs" and "redacts a contact-less member key in the log line". Pre-existing exposure (a contact-less member key IS `phone#<E164>` on the wire) is unchanged, as D5/D11 state |
| ASCII on every added line | PASS. `git diff -U0 f82c149c HEAD -- <file> \| grep '^+' \| tr -d '\11\12\15\40-\176' \| wc -c` run over all 75 changed files: ZERO non-ASCII bytes in added lines, every file |
| Commit discipline | PASS with one expected exception. Every authored commit `f82c149c..HEAD` carries `Co-Authored-By`; the sole commit without one is the merge `2af362e2 Merge branch 'main'`, which authors no content. No stray file: every changed path is under `app/`, `dashboard/`, `e2e/`, `scripts/` or `docs/`; nothing from `.superpowers/` is tracked; `git status` is clean and stays clean (this review wrote one file and ran no tests) |

---

## E. Findings

### 1. MUST-FIX - `slot_ineligible` raises an ERROR for a relay leg that already DELIVERED

- **Where:** `app/src/routes/webhooks/twilio.ts:2691-2698` (the outcome) and
  `:395-402` (`isTerminalRelayLegFailure`).
- **Contract:** Spec Sec 6 / D23 states the founder-approved alarm set exactly:
  "every fan-out or team leg that ends terminally on 30003 - whether the ladder
  ran to its cap, was refused at a gate, or was never claimed at all because
  `To` was missing or the source row could not be read." Adjudication S2a
  restates it as "ERROR iff ... (code is 30003 AND the leg is a fan-out/team leg
  AND the outcome is neither `claimed` nor `already_claimed`)".
- **Tree:** the slot gate returns `slot_ineligible` for ANY non-failure slot
  status, `delivered` included (`:2693-2695`). The severity predicate then
  ERRORs it, because `slot_ineligible` is not one of the three WARN outcomes.
- **Failure scenario:** a relay leg goes `sent -> delivered`, then a duplicate or
  out-of-order `undelivered` callback carrying `ErrorCode=30003` arrives -
  precisely the reordering `ALLOWED_PRIOR` exists to absorb.
  `updateRecipientDeliveryStatus` correctly refuses the regression, so the slot
  still reads `delivered`; `mapped` is a failure, so the log block fires; the
  claim declines `slot_ineligible`; `isTerminalRelayLegFailure('30003',
  'slot_ineligible')` returns true and the line is logged at ERROR. That feeds
  `hc-<env>-error-logs` and Recent Errors for a message that was DELIVERED. On
  `main` the same callback is a WARN. The alarm set shipped is therefore strictly
  larger than the one approved, in the direction of false positives - the most
  expensive kind on a brand-new alarm.
- **Smallest fix:** split the outcome, or narrow the predicate. Either return a
  distinct value when `slot.status === 'delivered'` (an already-delivered leg is
  not a dead end) and keep it in the WARN arm beside `claimed` /
  `already_claimed` / `fenced_announcement`; or add that one status test inside
  `isTerminalRelayLegFailure`. Then add the SEV case Sec 7 intention 14 is
  missing (see finding 3).

### 2. SHOULD-FIX - a THROW inside `claimRelayRetry` skips the whole tail, and the placement escalation is then lost for good

- **Where:** `app/src/routes/webhooks/twilio.ts:2888` (un-guarded call),
  `:2939-2970` (the escalation, gated on `transitioned`).
- **Contract:** plan Task 12 Step 3 makes this a correctness requirement, not a
  style one: "A claim block full of early `return`s dropped in there would skip
  all three on four different exits ... No `return` inside the claim logic."
  The RETURN half is honoured; the THROW half is not.
- **Tree:** `claimRelayRetry` performs `getByTsMsgIdConsistent`,
  `conversations.getById` (inside `composeRelayLegCopy`, `:557`) and
  `messages.append` - and D3 explicitly notes `append` RETHROWS a condition
  failure at transaction index 0 (`messagesRepo.ts:2374-2388`). Only the
  `enqueue` call is wrapped (`:2787-2818`).
- **Failure scenario:** any of those three throws (a DynamoDB throttle or
  timeout is the realistic one). Express 5 forwards the rejection, the callback
  gets a 500, and Twilio redelivers. On the redelivery the slot no longer
  transitions, so `if (transitioned)` at `:2939` is false and
  `flagPlacementAttention` never runs. A failed relay leg on a placement-linked
  thread silently loses its escalation to a human - the exact outcome the
  M1.10c comment at `:501-509` says must not happen ("the message failing must
  not mean the communication fails"). The failure-marker log line is lost with
  it, so nothing records the leg either.
- **Smallest fix:** wrap the one call - `try { retryClaim = await
  claimRelayRetry(ptr, mapped); } catch (err) { log.error(...); retryClaim = {
  outcome: 'source_unreadable' }; }` (or a new outcome value) - so control
  always reaches the tail, which is what the design asked for.

### 3. SHOULD-FIX - Sec 7 intention 14 is under-tested on both of its halves

- **Where:** `app/test/twilioStatusWebhook.test.ts:1210-1240` (the "relay
  delivery-failure severity (D23)" block).
- **Contract:** "Severity: WARN while claimed, ERROR when terminal, 21610 still
  carved out, and the 1:1 **and native-group-text** paths unchanged."
- **Tree:** four cases, of which "leaves the 1:1 severity unchanged" covers only
  the 1:1 path. No case posts a native group-text 30003 receipt, and no case
  covers the delivered-slot escape of finding 1.
- **Smallest fix:** two cases - a group-text 30003 asserted at WARN, and a
  30003 callback replayed onto an already-delivered relay slot asserted at WARN
  once finding 1 is fixed. Both are one `postStatus` each on the existing
  harness.

### 4. NOTE - the backoff seam is not where spec Sec 2 says it is

Spec Sec 2 lists "`app/src/routes/dev.ts` and the e2e lane env - the backoff
injection seam". The tree reads the override in
`app/src/jobs/registerHandlers.ts:56-64` and `routes/dev.ts` is untouched. This
is RECORDED, not silent: the plan's own File Structure and Task 14 both say
"WORKER-side, not `dev.ts`", and adjudication E1 accepts the placement while
correcting the plan's stated reason (the job runs in-process in the APP in the
lane, not only in the spawned worker). No action beyond noting that the spec text
now trails the plan.

### 5. NOTE - the retry job has no twin of the fan-out's media-without-store ERROR

`relayFanOut.ts:1015-1024` logs an ERROR when a source carries media but no
`MediaStore` is configured, and adjudication S5 deliberately left that line
OUTSIDE the extracted range. `relayRetryLeg.ts:293-301` instead folds the same
condition into `hasForwardableMedia: sourceMedia.length > 0 && store !==
undefined`, so with `MEDIA_BUCKET` unset an MMS retry re-sends text only,
silently, and a versioned row's seeded `requestedTransport: 'mms'` then sits
beside an SMS send. Config-dependent and absent from dev and prod, hence a NOTE
rather than a fix - but the fan-out's line exists precisely because the failure
is otherwise invisible.

### 6. NOTE - the rendered retry bubble's own chip and its own row disagree

On a delivered retry bubble the rollup reads `delivered 1/1 on retry`
(`deliveryStatus.ts:544-550`, driven by `retryRow` from the wire field at
`Timeline.tsx:1058`), while its per-recipient row and its recital read plain
`Delivered` - the join buckets rungs under the ROOT, so the retry row's own leg
carries no `retryState` and the row falls through to today's copy. D21's
agreement requirement is about the ORIGINAL bubble's three positions, which do
agree, so this is not a violation; it is a small readable inconsistency worth
recording so nobody "fixes" it by feeding the retry bubble a self-referential
projection. The e2e asserts the chip only (`relay-30003-retry.spec.ts:256`).

### 7. NOTE - `isRetryRungLive`'s deliberate asymmetry has one unreachable-today corner

`relayRetryJoin.ts:217-229` resolves a rung two different ways depending on WHICH
clock is missing: no reading clock (`nowMs === undefined`) means live, an
undatable rung means not-live. The reasoning is written out at `:196-215` and is
right. The corner it leaves: on a bubble whose `bubbleNowMs` is undefined (an
imported row - `bubbleClocks`), a genuinely stranded claim would read `retrying`
for ever with the ticker disarmed. Not reachable today, because an imported relay
source carries a synthetic delivery map and never acquires retry rows. Recorded
so the corner is known rather than rediscovered.

---

## Adjudicated deviations - challenged and upheld

I looked for adjudicated deviations that contradict the spec's intent. I found
none I would reverse, and I record the two I pushed hardest on:

- **B3 (`on retry` first after the dash).** The spec's fixed order is "failed,
  retrying, not confirmed", and B3 puts a fourth token AHEAD of all three, which
  reads at first like a violation. It is not: D19 calls `on retry` a suffix on
  the DELIVERED count, not a category, and its own table writes the pure case as
  `delivered 4/4 - 1 on retry`. Placing the suffix adjacent to the count it
  qualifies is the only rendering consistent with both sentences, and the three
  categories keep their order among themselves
  (`deliveryStatus.ts:498-503`). Upheld.
- **B5 (a clockless rung is `unconfirmed`, never `retrying`).** This EXTENDS
  D18, which defines `unconfirmed` strictly as a rung past one of two horizons -
  and a rung with no clock is past neither. The alternative, though, is the
  literal defect D18 exists to prevent: `isQuietSince` answers false for a
  missing clock, so without B5 the rung answers "live" on every tick for ever and
  the copy reads `retrying` permanently, with the ticker (correctly) not armed to
  ever change it. B5 chooses the honest side of an unreachable-by-the-letter
  case. Upheld, and the tests pin both halves ("never yields unconfirmed without
  a clock", "is unconfirmed for a rung it cannot date, rather than retrying for
  ever").

Reviewer: spec-conformance R1. No source file was edited, no test was run, no
commit was made; the working tree carries only this file.
