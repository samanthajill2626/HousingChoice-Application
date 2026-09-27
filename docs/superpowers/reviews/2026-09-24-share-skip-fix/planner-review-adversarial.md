# share-skip-fix - planner review, adversarial (plan-blind)

- Branch: `feat/share-skip-fix` at 3abc9796 (main merged in at 813c0c44), worktree `W:\tmp\share-skip-fix`.
- Scope: `git diff main...HEAD` (51 non-docs files) plus an app-wide sweep of every reader and writer of the state the diff touches.
- Method: READ-ONLY. Code read directly; no npm, no tests, no scripts run, nothing in the repository edited except this file. `docs/superpowers/**` and `docs/issues/**` were used as background only; where a finding overlaps an earlier record it says so, and the severity here is this review's own.
- Every citation below is a line actually read. Anything not proven by reading is marked UNVERIFIED.

No BLOCKING finding. Two MEDIUM, the rest LOW. Most severe first.

---

## 1. MEDIUM - D5 still counts never-attempted and never-delivered FAILED slots (and a stranded share's QUEUED slots) as "Already sent"; whether a failed tenant counts depends on the OTHER recipients

What is wrong. The new prior-recipients rule drops only `skipped` slots and keeps everything else, on the stated ground that "a failed text may have been delivered by a retry this share never hears about" (app/src/repos/broadcastsRepo.ts:592-601). That ground holds for exactly one failure class, 30003, the only code the status webhook retries (app/src/routes/webhooks/twilio.ts:3350-3369). For every other failed slot no text reached the tenant and nothing will ever retry it:

- `no_contact` - never dispatched (app/src/jobs/broadcastFanOut.ts:380-389).
- `transient_cap` / `enqueue_failed` - the ladder closes still-deferred slots `failed`; these recipients were never accepted by the carrier (broadcastFanOut.ts:287-302, :358-363, :642-681). This is the path a 429/30022 storm on a large blast takes.
- `30007` carrier-filtered - "NEVER retried" (broadcastFanOut.ts:562-571; twilio.ts:3458-3468).
- `30005` / `30006` - failed and never retried (broadcastFanOut.ts:573-600).
- A share stranded `sending` by the D12 throw path (broadcastFanOut.ts:609-620) keeps its untried slots `queued` forever, and `queued` slots of a `sending` share count (broadcastsRepo.ts:590-601).

The branch's own premise - "a SKIPPED slot means no text was attempted ... so it must not flag them" (broadcastsRepo.ts:592-595) - applies verbatim to `no_contact`, `transient_cap`, `enqueue_failed` and a stranded `queued` slot, yet they count.

The rule is also inconsistent with itself: only `sent`/`sending` shares are read (broadcastsRepo.ts:590), and `finalize` marks a share `failed` when every recipient failed (broadcastFanOut.ts:746-749). So a tenant whose 30007 text failed is "Already sent" if a co-recipient succeeded and NOT "Already sent" if nobody did - the e2e spec says so and works around it on purpose (e2e/tests/dashboard-next/share-skip-fix.spec.ts:15-21, :249-259).

It also disagrees with the app's other "already sent" record: the listing-send row behind "Sent to tenants" / "Properties sent" is written only after a successful dispatch (broadcastFanOut.ts:518-539), so a `no_contact` / `transient_cap` / `enqueue_failed` tenant is absent from the property's "Sent to tenants" card while the composer flags them "Already sent".

What it implies. An unseeded flagged row starts UNCHECKED and "Select all" skips it (dashboard/src/routes/broadcasts/RecipientPreview.tsx:91, :162-168). A tenant who never received the property is silently left out of the next blast of that property - the same symptom as Sam's #5, through the failed door instead of the skipped one. The e2e pins the 30007 case as the interim rule (share-skip-fix.spec.ts:240-275), so gates will keep it green. The provably-unattempted subset (`no_contact`, `transient_cap`, `enqueue_failed`) is separable today by the slot's own `errorCode`; the misleading justification comment should at minimum be narrowed to 30003.

## 2. MEDIUM - a person's share that fails 30003 on a switched-off conversation is never retried, yet its row says "will retry" and D5 flags the tenant "Already sent"; the retry also drops the I8 recipient

(Overlaps whole-branch review A4, which was relayed to feat/retry-send-window for the wording. The D5 interaction and the I8 drop below are not in that record.)

What is wrong. D4 sends a dashboard share `automated: false` precisely so it reaches `manual` conversations (broadcastFanOut.ts:463-473; sendMessage.ts:364-367). A 30003 on that text enqueues the automatic retry (twilio.ts:3350-3369), and retrySend always sends `automated: true` (app/src/jobs/retrySend.ts:194-207), so on a `manual` row the wrapper refuses it `manual_mode` (sendMessage.ts:367) and the chain stops at WARN (retrySend.ts:208-217). After the bulk apply the rows that stay `manual` are the breaker-tripped ones (plus any row an import from `main` creates inside the RUNBOOK's import window), so for this population the refusal is certain, not incidental.

- The share row reads "Phone unreachable - will retry (error 30003)": shareRecipientReason sends a failed row to deliveryReason with no relay flag (dashboard/src/routes/broadcasts/broadcastFormat.ts:144-155), which picks the 1:1 wording (dashboard/src/routes/contact/deliveryStatus.ts:777-778). That map's own comment rests on "a 1:1 30003 retry genuinely does send" (deliveryStatus.ts:850-851), which D4 has made false for shares into switched-off threads.
- The slot stays `failed`, so finding 1's rule flags the tenant "Already sent" on the next share of the property.
- The retry carries no `recipient` (retrySend.ts:200-207), so the wrapper judges the phone-matched contact again (sendMessage.ts:319-322): a soft-deleted duplicate on the same phone - the exact case I8 fixed for the first send - refuses the retry `contact_deleted` (sendMessage.ts:342-345), even on a switched-on row.
- The retry payload carries no broadcast id (twilio.ts:3364-3368; retrySend.ts:200-207), so a retry that does deliver never updates the share slot (pre-existing; noted because D5's justification leans on it).

What it implies. The person-send guarantee D4 establishes for the first text does not extend to its only automatic recovery, and the UI promises the recovery anyway. docs/issues/ai-mode-switch-gates-all-automation.md item 3 ("a retry follows the original sender") is the eventual fix; until then this branch widens the set of texts that hit the gap.

## 3. LOW - D4 covers every dashboard share, including a 1,500-recipient filter blast: bulk traffic is never breaker-metered, reaches breaker-tripped conversations the ops process holds for review, and is audited as a person's send with no actor

What is wrong. `createdVia: 'dashboard'` is stamped on every draft the POST route creates, blast or one-to-one (app/src/routes/broadcasts.ts:448-462), and the fan-out keys only on it (broadcastFanOut.ts:463). Consequences:

- The breaker counter is never incremented for any share (sendMessage.ts:366-385), so the only per-conversation rate brake no longer sees bulk traffic. The route de-dupes recipients by contactId only (broadcasts.ts:661-672), so duplicate contacts on one phone - the case I8 is written for - each get the same text, with no cap at any size.
- A breaker-tripped conversation, which the RUNBOOK says to review ("Decide whether the burst was legitimate ... or a loop") before resuming, receives every blast regardless.
- Each blast text is audited `message_sent { automated: false, author: 'teammate' }` with no `actor` (sendMessage.ts:451-455), so bulk marketing traffic is indistinguishable from a hand-typed 1:1 message in the conversation audit and invisible to the byActor GSI.
- A draft created before the deploy has no `created_via` and still sends automated (broadcastsRepo.ts:335-341; broadcastFanOut.ts:462-463); a resumed old draft is refused `manual_mode` with no hint in the composer (whole-branch A3, by design).

What it implies. This matches the human's stated rule (staff-created property sends never read the switch), so it is not a defect of intent; the hazards are the loss of the only per-conversation brake on bulk sends and an audit trail that cannot tell a blast from a person. WP2 item 8 covers engine sends only.

## 4. LOW - the fix script's transactions can fail live writes on the rows it flips, and two of those failures are not benign as the RUNBOOK says

(slice-1 r2 adjudicated the RUNBOOK wording; the consequences below are not in that record.)

What is wrong. RUNBOOK.md:347 says an app write that fails with `TransactionConflictException` during the apply "is this, not a new bug". The SDK does not retry that error: it is not in the throttling or transient lists (node_modules/@smithy/core/dist-es/submodules/retry/service-error-classification/constants.js:10-26) and carries no `$retryable` trait (node_modules/@aws-sdk/client-dynamodb/dist-cjs/models/errors.js:203-214). The rows flipped are the `manual` ones, which D4 is now sending shares into.

- sendMessage's `touchLastActivity` runs AFTER the provider send and the append (sendMessage.ts:412-450). A conflict there throws for a text that already went out. In the fan-out the SDK error carries `name`/`$metadata` and the parsed body, not a `code` or `status` field (node_modules/@smithy/core/dist-cjs/submodules/client/index.js:759-770, :796-807), so `errorCodeOf` returns undefined (broadcastFanOut.ts:176-185) and the loop throws (:609-620): the D12 strand - the sent recipient stays `queued`, the rest of the share is never attempted, the share never finalizes.
- In the dashboard 1:1 route the first batch rethrows (app/src/routes/api.ts:1438-1460) - a 500 for a message that was sent, inviting a duplicate on retry.

What it implies. Rare (a millisecond window per row), but the runbook trains the operator to dismiss the one signal that a share was stranded. "Run it at a quiet moment" should also say "with no share sending".

## 5. LOW - `isOptedOutCode(undefined) === true` files any code-less skip as an opt-out, forever

What is wrong. A skipped slot with no `errorCode` is bucketed `skipped_opted_out` (broadcastsRepo.ts:218-223, :288-291) and rendered "Opted out or number unreachable" (deliveryStatus.ts:960-965). Slots carry no timestamp, so the rule cannot tell a pre-2026-09-25 legacy slot from a NEW skip path that forgets its code. docs/issues/broadcast-skip-code-drift-guard.md says the sibling branches (send-outcome-reconcile, retry-send-window) add codes at exactly these sites. No test asserts that every `status: 'skipped'` write carries a code.

What it implies. A future missing code is not a visible `Not sent (<code>)` - it is silently counted and displayed as an opt-out, a TCPA-flavored statement about a person who never opted out. Consider a one-time backfill of the legacy slots to an explicit legacy code so `undefined` can become an error bucket.

## 6. LOW - the wrapper now trusts a caller-supplied `recipient` with no binding to the conversation

What is wrong. When `recipient` is set, the deleted and JIT-consent gates judge it (sendMessage.ts:319-362), but nothing checks that `recipient.phone` (or contactId) belongs to the conversation whose `participant_phone` the text goes to (sendMessage.ts:313-314, :407). The opt-out WARN logs `contactId: contact?.contactId` - the recipient's id - even when the refusal came from the phone-matched duplicate's flag (sendMessage.ts:323-335), attributing the opt-out to the wrong record in the log.

What it implies. One caller today and it is internally consistent (broadcastFanOut.ts:379, :451, :471). The next caller that passes a mismatched item bypasses consent/deleted for the real recipient silently. A one-line equality assertion would close it.

## 7. LOW - rule copies that must now change in lockstep

- The prior-recipients rule lives twice: the repo (broadcastsRepo.ts:591-601, whose comment says "This is the ONE place the rule lives") and the fake (app/test/helpers/twilioWebhookHarness.ts:3011-3024). Every route-level test, including the new D5 one (app/test/broadcastApi.test.ts:1205-1240), exercises the fake's copy; only broadcastsRepo.integration.test.ts reaches the real one.
- The three-bucket skip sum is written twice in the dashboard (dashboard/src/routes/broadcasts/StatChips.tsx:34; broadcastFormat.ts:100); a fourth bucket needs both.
- The census replays the reminder job's one-to-one pick by copy (app/scripts/conversation-automation-census.ts:335-336 vs app/src/jobs/tourReminders.ts:1092-1093), and the trip-evidence rule rests on a prose-only invariant (census :140-150; enable :19-23) that WP2's switch will break.

## 8. LOW - the lean fixture's promises are contradicted or unenforced at runtime

- lean.ts:31-34 says conv-0002 "must never displace Tasha as the newest inbox row", and seedData.test.ts checks only the static seed. share-skip-fix.spec.ts test 1 sends into conv-0002 (:180-195), and sendMessage's touch moves its `last_activity_at` to now (sendMessage.ts:450), so for every later spec in the same run that does not reseed, Dario's thread is the newest row. UNVERIFIED which later specs read the first inbox row without reseeding; the gate run was green.
- "No other spec may use him as a recipient of ... any automated text" (lean.ts:180-186) is comment-only.
- lean.ts:283 stamps `imported_from: 'quo'` while its comment says it marks the row "the way the import does"; the importer stamps 'quo-airtable-import' (app/src/lib/import/apply.ts:59), and the import's own adopt/retract checks compare against that exact value (apply.ts:599, :702, :725).

## 9. LOW - the new RUNBOOK section is a pre-merge, machine-specific instruction in the permanent ops doc

RUNBOOK.md:339 says the work is owed "BEFORE its merge and deploy" and tells the operator to run from a pinned worktree `W:\tmp\share-skip-fix-ops` at the slice-1 commit; RUNBOOK.md:349 keys a rule to "the MERGE of this branch". All of it is stale the moment the branch merges (the scripts then live on main and the pinned worktree will not exist), and nothing in the section says so.

## 10. LOW - UNVERIFIED: D8's one-to-one default is a bare address plus link

The default is `'[Address] [FlyerLink]'` (dashboard/src/routes/broadcasts/resolveTemplate.ts:40): no greeting, no sender or brand cue. A first-touch text that is only a URL from a 10DLC number is the pattern carrier filters target; a 30007 on a share is never retried (broadcastFanOut.ts:562-571) and, by finding 1, flags the tenant "Already sent". Carrier behavior not verified; the previous default also had no brand name, so this is a reduction of cues, not a new absence.

## 11. LOW - a share of skipped + failed slots with zero deliveries reads "Sent" in the positive tone, pinned by a unit test

(Raised as whole-branch A2 and adjudicated "working as specified"; listed because the pin guarantees gates stay green.) presentShareLabel relabels only an all-skipped share (broadcastFormat.ts:95-104), and dashboard/src/routes/broadcasts/broadcastFormat.test.ts:181 pins `{ audience: 2, skipped_other: 1, failed: 1 }` -> "Sent"/positive. An all-failed share reads "Failed" (broadcastFanOut.ts:746-749); adding one skipped recipient to it flips the pill to green "Sent".

## 12. LOW - PII: the new soft-deleted skip line logs a `phone#` contactKey

broadcastFanOut.ts:429 logs `contactKey`, which is `phone#<E164>` for a phone-keyed recipient (resolveContact, :692-700) - a phone number in a log whose header says never to log phones (:42-43). Pre-existing pattern at :388, :446 and :558; this branch adds one more site.

## 13. LOW - `resolveTemplateForTenant` is dead code

No composer path calls it any more (resolveTemplate.ts:1-10, :100-117; grep finds only resolveTemplate.test.ts). It is still exported, tested and documented as a parity mirror of the backend renderer - maintained code with no caller.

## 14. LOW - raw internal codes reach staff copy (filed)

`shareSkipReason` falls back to `Not sent (<code>)` (deliveryStatus.ts:963-966). Reachable wrapper refusals with no entry: `conversation_not_found`, `relay_not_supported`, `group_text_not_supported` (sendMessage.ts:53-77). Already filed as docs/issues/broadcast-skip-code-drift-guard.md; listed only to answer the charter's raw-code question.

---

## What the five gates cannot see

- Findings 1, 2 and 11 are pinned or untested: the e2e pins the 30007 "Already sent" case (share-skip-fix.spec.ts:240-275), broadcastFormat.test.ts:181 pins finding 11, and no test drives a 30003 retry for a dashboard share on a `manual` row.
- Finding 4 exists only on real AWS under live traffic; DynamoDB Local in `npm test` never produces a cross-writer transaction conflict.
- The ops scripts' real-AWS path (STS guard, `fromIni`, pinned endpoint) is exercised only through injected seams (app/test/stageClient.test.ts:60-177). That is the right design, but no gate proves the operator's real profile.
- No gate checks ASCII on added lines. Verified by hand: no added line in the non-docs diff contains a non-ASCII byte.
- Typecheck does cover app/scripts (app/package.json:13 runs tsconfig.scripts.json, whose include is scripts + src).

## Swept and found clean (so the next reader need not redo it)

- Ops targeting: `--env` alone picks prefix and credentials; `--lane` sets prefix AND access key together and is refused off local (app/scripts/lib/stageClient.ts:112-142, :186-212); repeated or unknown arguments are refused (:194-204); dev/prod refuse any `AWS_ENDPOINT_URL*` before the STS call, re-check the account, and pin the client's region, endpoint and profile credentials (:143-168; scripts/lib/hcAws.mjs:29-57). The STS call itself is not endpoint-pinned, but an accidental redirect fails closed (wrong or no account -> refusal).
- Transaction atomicity: switch + audit Put are one TransactWriteItems (enable-conversation-automation.ts:203-244); only item 0's ConditionalCheckFailed counts as a skip (:246); the SDK auto-fills the ClientRequestToken at serialization (node_modules/@aws-sdk/core/dist-cjs/submodules/protocols/index.js:747-748; the input schema marks it an idempotency token), so SDK-level retries cannot double-apply or misreport a landed row.
- Trip-evidence invariant holds for every current writer of `ai_mode = manual`: the breaker's setMode (sendMessage.ts:370), the import only via `if_not_exists` (apply.ts:1093), group creators on group types only (conversationsRepo.ts:1941, :2385); runtime 1:1 creators write `auto` (conversationsRepo.ts:1273, :1383).
- The bulk apply releases no burst: past-due reminder rungs on `manual` rows were already claimed and refused (tourReminders.ts:1421-1466), placement nudges are held by kind (placementNudges.ts:123, :331-336), and the retry ladder is at most 240s deep (retrySend.ts:39-42).
- `created_via` has one writer, the session-authenticated POST route (broadcasts.ts:448-462); PATCH and markSending leave it alone.
- `bumpStats` ADDs a missing nested `skipped_other` on a pre-deploy row (broadcastsRepo.ts:755-796; integration test broadcastsRepo.integration.test.ts:147-172); SSE and results always carry derived stats (broadcastFanOut.ts:167-173; broadcasts.ts:280-315).
- The script import closure has no module-level client or network side effects (jobs.ts:53, logger.ts:261, dynamo.ts:24 are inert), and the census and enable scripts pass the stage `doc` to every repo they build (census :284-287, :347; enable :186).
