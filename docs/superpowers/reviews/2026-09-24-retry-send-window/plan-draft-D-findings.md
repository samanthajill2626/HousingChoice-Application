# Plan draft D findings - Tasks 19, 20, 21 (e2e proof, docs and issues, final gates + handback)

Drafter: slice D. Code citations at `fd38ba73` (source identical to `main` @`da04d0cb`;
`git diff --stat da04d0cb fd38ba73` touches docs only). Output:
`.superpowers/plan-drafts/slice-D.md`. No CONTRACT CHANGE: slice D only consumes the
skeleton's names (listed in finding 14).

## Findings

1. **[med, e2e validity] The Retry action's absence can pass vacuously; the draft
   asserts it only at the same instant as the promise, plus a positive control.**
   The one-to-one Retry button renders on every failed outbound bubble OUTSIDE the
   reveal (`dashboard/src/routes/contact/Timeline.tsx:1341-1353`; `.retry` has no
   display rule, `dashboard/src/routes/contact/Timeline.module.css:349-360`, while the
   reveal only toggles `.metaText`, `:312-324`). Once the automatic retry lands, the
   retry collapse hides the failed original (`Timeline.tsx:1971-1984`), so a lazily
   re-resolved "no Retry button" locator silently re-targets the delivered retry's
   bubble - which has no button either - and passes. Task 19 therefore takes the
   promise text and the button's absence in ONE filtered locator, and adds a
   positive control (a 30007 failure, never retried per spec section 8) proving the
   same accessible name IS found on this surface.

2. **[low, stale doc] `e2e/support/selectors.md:48` says the bubble's reveal
   discloses "the Retry action"; it does not** (finding 1's citations). Task 20
   Step 6(a) corrects it, since the new one-to-one row contradicts it otherwise.

3. **[low, dependency on slice C] The e2e pins two Timeline facts Task 17 must
   keep:** the Retry action's accessible name `Retry sending this message`
   (`Timeline.tsx:1349`) and the one-to-one chip grammar `<label> - <reason>`
   (`Timeline.tsx:1197-1204`). If Task 17 hid the action by `disabled` instead of
   not rendering or hiding it, the e2e fails (a disabled button stays in the
   accessibility tree). D10 says "hidden", so no contract change - flagged so the
   slice C drafter and the reviewer check it.

4. **[low, e2e dependency] The contact-timeline projection carries only `retry_of`
   of the lineage** (`app/src/routes/contactTimeline.ts:442`; Task 13 adds only
   `retry_due_at`). The e2e reads the stored lineage (`retry_attempt`,
   `retry_window_start`, `automated`, `retry_due_at`, `provider_sid`) through
   `GET /api/conversations/:conversationId/messages`, which returns raw `MessageItem`
   rows (`app/src/routes/api.ts:2148-2175`). A later branch that projects that route
   must carry those fields or move the e2e's lineage block. No change requested.

5. **[med, process] `npm run e2e:restart` cannot pick up Task 9's seam.** The
   launcher builds `childEnv` once at start (`scripts/e2e-session.mjs:109`, spawned
   with it at `:502`) and a restart re-spawns children under that same launcher
   (`scripts/e2e-restart.mjs:1-3`). The preflight also refuses a stack booted at an
   older commit (`e2e/support/preflight.ts:104-128`). Task 19 stops any earlier
   session and boots a fresh lane, and the spec asserts the seam through the stored
   `retry_due_at` (at least 10 s and under 60 s after `provider_ts`), so a seam-less
   lane fails with a message naming `E2E_SEND_RETRY_BACKOFF_MS` instead of a
   timeout. The lower bound holds by construction: the webhook's clock is after the
   fake's create, and `provider_ts` is the fake's second-truncated `date_created`
   (`fake-twilio/src/routes/rest.ts:67` -> `app/src/adapters/messaging.ts:745`).

6. **[low, gates] Gate 5 will exit 1 through no fault of this branch.**
   `dashboard/src/routes/contact/Timeline.tsx` (touched by Task 17) carries a
   pre-existing `react-hooks/set-state-in-effect` error at `Timeline.tsx:1495` on
   `main` @`da04d0cb`. Linted read-only from the main checkout: every other existing
   file the skeleton names as modified (messagesRepo, twilioWebhookHarness,
   relayRetryLeg, relayRetryClaim, twilio webhook, relayFanOut, sendMessage,
   retrySend, api, contactTimeline, dashboard types/client/deliveryStatus/
   relayRetryJoin/broadcastFormat/DeliveryBadge/StatChips/ContactCommsPane/
   useContactTimeline, both neighbor e2e specs) and their test files lint clean
   (warnings only in `useContactTimeline.ts:362`, `:364`). Task 21 Step 6 states
   this expectation and attributes by baseline (rule + message multiset per file,
   base content linted from stdin under its own path, HEAD never moves). Also the
   AGENTS.md known hole: `scripts/e2e-session.mjs` (Task 9) is `.mjs` and gate 5
   checks nothing in it; the handback says so.

7. **[low, gates] `timeout 1500` fits the idle suite, not a loaded one.** AGENTS.md
   records a 17.9 min idle baseline and a 34.7 min instrumented run; the playwright
   config records pressure runs at 1.93-1.96x that baseline, i.e. about 35 min
   (`e2e/playwright.config.ts:104-109`). An exit 124
   is an ABORT, and `reuseExistingServer` adopts an orphan on a commit match
   (`e2e/playwright.config.ts:203`), so Task 21 Step 5 proves the lane's ports are
   free (a direct connect probe per port from `e2e/.artifacts/lane.json`, then
   `npm run e2e:stop`, then the probe again) before any re-run, and says to re-run
   on a quiet box rather than raise the ceiling silently. The planner may prefer a
   higher ceiling; the skeleton fixes 1500.

8. **[low, issue text] `manual-retry-double-send-residual-windows` matches spec
   section 9 (draft 7) in substance; three edits (Task 20 Step 5).** Gaps 1-3 are
   section 9's three windows (spec lines 773-776), gap 4 is section 5's joint gap
   (spec lines 625-630), and its second paragraph is section 9's "no Retry can find
   the failure without its promise". Edits: (a) "revision 4" -> "revision 5,
   @616d120d" (`docs/issues/manual-retry-double-send-residual-windows.md:47`; spec
   section 5 names revision 5); (b) gap 2 (`:28-29`) gains "once the promise has
   expired" - before that the route refuses the stale tab's press (D10), which the
   new e2e exercises; (c) `refs` (`:9`) carried `f49a2fe9` line numbers this branch
   moves and become paths. "(spec D7, draft 6)" (`:20`) is left: historically
   accurate.

9. **[info, spec wording] Spec section 9's "from a stale tab on an original an
   automatic retry already replaced" (spec lines 774-775) omits the same qualifier**
   as finding 8(b). Not a contradiction - the guard is time-based by D10 - but a
   reader can take it to mean the guard never covers that tab. The spec is frozen at
   draft 7; the issue carries the precise wording.

10. **[info, coverage] What the e2e does and does not prove.** It proves a person's
    send on an AUTO one-to-one thread (`conv-0001` has no `ai_mode`,
    `app/src/lib/seed/lean.ts:255-267`, read as auto by
    `app/src/services/scheduledSendSuppression.ts:36-38`) retried as a person's send,
    with its lineage and `automated: false` stored at append, the D7 stamp, the D10
    server guard and the D8 copy on the real contact page with the Timeline's default
    `rosterKind`. It cannot reach a manual-mode one-to-one thread (D13 forbids
    `conv-0002`, and no other seeded one-to-one thread is manual) or any declined
    retry (window, cap, D3a refusals) or the relay window; those stay unit-proven per
    D13. The optional `E2E_RETRY_SEND_WINDOW_MS` seam (spec D13) is not built - no
    e2e here needs it; the handback says so.

11. **[low, flake risk] The promise's observation window is the lane backoff (10 s)
    minus the SSE path and the timeline's 300 ms refetch debounce**
    (`dashboard/src/routes/contact/useContactTimeline.ts:109`) - the same budget the
    relay spec lives on (`e2e/tests/dashboard-next/relay-30003-retry.spec.ts:219-227`).
    The e2e's stored-row reads select rows by `retry_of`, never by count, so a retry
    that lands early cannot break them. The spec header carries the relay spec's
    rule: if the promise assertions flake, raise BOTH lane backoffs, never weaken
    the assertions.

12. **[info, reseed decision] Reseed before AND after, plus a fake disarm.** Before:
    `e2e/tests/dashboard-next/contact-detail.spec.ts:216-227` toggles Tasha's Do Not
    Contact, and a scheduled text left by an earlier spec would consume the one-shot
    arming (`fake-twilio/src/engine/engine.ts:463-464`). After: NOT for the inbox-order
    reason `e2e/tests/dashboard-next/share-skip-fix.spec.ts:33-40` gives (`conv-0001`
    is already the newest conversation row, `lean.ts:18-20`, `:260`, and a send keeps
    it newest) but for failure hygiene: an unconsumed arming survives a reseed (only
    `/control/reset` clears arms, `e2e/support/preflight.ts:152-158`,
    `engine.ts:173-186`; re-arming `normal` replaces it, `engine.ts:171`), and a retry
    job left pending by a failed run finds no original after a reseed
    (`app/src/jobs/retrySend.ts:112-116`). No other spec reads Tasha's thread in a way
    this spec disturbs: all add and filter run-unique bodies; the one `getOutboundTo`
    reader of her number filters by `since` and body
    (`e2e/tests/dashboard-next/message-transport-fidelity.spec.ts:336-344`).

13. **[info, commands] Root `npm run e2e` eats `--grep`** (root script
    `package.json:41` re-invokes npm, whose parser takes unknown `--flags`). Task 19
    uses the workspace form `npm run e2e -w @housingchoice/e2e -- <spec paths>`
    (`e2e/package.json:7`), which boots its own hermetic lane or reuses this
    worktree's live `e2e:session` (`e2e/playwright.config.ts:26-52`). The full suite
    stays Task 21's `timeout 1500 npm run e2e`.

14. **[info] Contracts consumed (no change):** Task 9's seam and
    `resolveSendRetryBackoffMs`; Task 8's `automated` on every append; Task 10's
    `updateDeliveryStatus(..., { retryDueAt })` + `enqueueSendRetry(payload, runAt)`;
    Task 11's append-time `retry_of` / `retry_attempt` / `retry_window_start` /
    `automated`; Task 12's `409 { error: 'retry_pending' }` in the route's existing
    409 body shape (`app/src/routes/api.ts:1586`, `:1593`); Task 13's `retry_due_at`
    projection; Tasks 14/15/17's copy and Retry hiding. The handback template needs
    slice A's final placement of `'deadline_exceeded'` in `sendOneRelayLeg`'s return
    union (skeleton Task 6 leaves it to that drafter); Task 21 tells the builder to
    state it from the code.

15. **[info, dates] Task 20 writes `2026-09-25` into issue frontmatter and bold
    dates;** it tells the builder to use the actual day if the task runs later.

16. **[info, handback content] Section 9's residuals are mapped in Task 20's table:**
    only two are issue-recorded (`manual-retry-double-send-residual-windows`,
    `relay-retry-stranded-claim-window`); the other five are accepted in the spec
    and listed in the handback so the "Relay for SOR" and Branch B carry them.
