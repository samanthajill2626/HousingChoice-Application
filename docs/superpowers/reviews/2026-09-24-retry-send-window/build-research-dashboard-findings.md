# Build research - dashboard (Tasks 14-18): findings

Read-only verification of plan v3 Tasks 14-18 (and Task 13's `retry_due_at` wire
field) against the live tree, 2026-09-25. Worktree `W:\tmp\retry-send-window`
@`6fb365dd`; code identical to `f49a2fe9` (`git diff --stat f49a2fe9 HEAD -- app
dashboard e2e scripts` is empty), so every plan `file:line` is checked as written.
Quotations, the non-ASCII map, caller lists and the invariant table are in the
gitignored reference `.superpowers/sdd/build-research-dashboard-reference.md`.

Verdict: 0 blockers, 0 must-fix, 10 notes. All 62 quoted anchors and insertion points
in Tasks 14-18 exist byte-for-byte, exactly once, at the cited line (finding 1 is the
one range off by a line). The mirror test's cross-workspace import compiles and runs
under the dashboard's own config (`dashboard/tsconfig.json:6-7`, `:9`, `:12`;
`dashboard/vite.config.ts:116-126`; precedent `mediaTypeMirror.test.ts:27-30`; Task 1's
module has no imports). No caller of `deliveryReason`, no reason-map reader and no test
pinning the old 30003 wording was missed. The ticker skew tests control both clocks
and fail a browser-clock implementation in both the fast and the slow direction.

## Findings

1. **note - Task 18 - one line range is off by one.** The `EmailCard (outbound
   delivery chip)` describe in `dashboard/src/routes/contact/Timeline.email.test.tsx`
   spans :89-117, not :89-116: :116 closes the `it`, :117 closes the describe. The
   plan's text anchor ("through its closing `});`") is correct. Correction: replace
   through :117, so no orphan `});` is left.

2. **note - Tasks 14-18 - no commit step runs the ASCII check.** Task 13 runs one
   (plan :7300); Tasks 14-18 do not, although Global Constraints require it (plan
   :17). Seven of the edited files already carry non-ASCII, so the whole-file `tr`
   check is non-zero by design: `deliveryStatus.ts` (21 lines), `Timeline.tsx` (47),
   `Timeline.test.tsx` (21), `deliveryStatus.test.ts` (7), `broadcastFormat.test.ts`
   (5), `StatChips.test.tsx` (4) and `client.ts` (2). Correction: add the diff-scoped
   check to each task's Step "Typecheck, lint and commit". The whole-file check stays
   valid for the five all-ASCII edited files and for the new ones. Hazard lines, which
   the builder must select rather than retype:
   - Inside an edit: `deliveryStatus.ts:778` (U+2014). Task 15 (a) replaces this
     line, and this is the one non-ASCII character that must go.
   - Next to an edit: `deliveryStatus.ts:773-774`, `deliveryStatus.test.ts:430`
     (just after Task 15 (a)'s range ends at :428), `Timeline.tsx:130`, `:911`
     (between Task 17 (6)'s two anchors), `:1337-1338`, `:1351` (around the Retry
     gate at :1341), `Timeline.test.tsx:926` and `:928` (just above the 409 test's
     insert point at :931), and `client.ts:1`.

   The reference's section C lists every non-ASCII character with its column.

3. **note - Task 17 - new comments cite lines that Task 17 itself moves.** The
   rewritten comments in `Timeline.delivery.test.tsx` (plan :8401-8402 and :8440)
   cite the `rosterKind` defaults at `Timeline.tsx:1790` and `:906`. By Task 17's
   commit, its own inserts have moved them: +56 lines above :906 and +83 above
   :1790, to about :962 and :1873. Correction: cite by symbol (the `Timeline` props
   destructure and `MessageBubble`'s default), or recompute the lines after the
   edit.

4. **note - Task 21, caused by Task 17 - the known lint error moves.** Global
   Constraints (plan :28) name `Timeline.tsx:1495` as the pre-existing gate-5 error:
   `react-hooks/set-state-in-effect` on the call card's `setNow(fresh)`. Task 17
   inserts 77 lines above it, so gate 5 will report it at about :1572. Attribution by
   baseline diff (AGENTS.md) still holds; only the number in the plan will not match.

5. **note - Task 14 - `receivedAtMs` is never tested with a distinct value.** Every
   `noteServerDate` call in `serverClock.test.ts` (plan :7375-:7420) passes the pinned
   `Date.now()` as `receivedAtMs`, or omits it. An implementation that ignored the
   parameter and read `Date.now()` would pass the whole file. This is harmless in
   production, because the only caller (`client.ts`) uses the default. Correction,
   if the parameter is kept: add one case that notes a header with a receipt instant
   different from the pinned clock.

6. **note - Tasks 15 and 17 - the "ahead of the media map" order is not observable.**
   `MMS_ERROR_CODE_REASONS` holds only 30005 and 30006 (`deliveryStatus.ts:815-818`).
   So `keeps the promise on an MMS one-to-one 30003 - retryScheduled goes ahead of the
   media map` (plan :7835) and `keeps the promise on an MMS one-to-one bubble - the
   promise is checked ahead of the media map` (plan :8469) pass with either chain
   order. They pin only that `media: true` does not suppress the promise. The plan's
   own comments concede this (:7833-7834, :7963-7964). The order is held by the chain
   in Task 15 (f) and by review, not by a test. Correction: retitle the two tests, or
   accept them as written.

7. **note (risk) - Task 17 - the server-clock estimate is not monotonic across
   responses.** Each response replaces the offset (plan :7633-7638). The truncated
   second in the `Date` header, Node's cached `Date` string and the trip time all vary
   per response, so the estimate can step back by about a second, or more under
   server load.

   The single snapshot in the memo (plan :9113-9121) keeps one recompute consistent.
   It does not cover a recompute that a refetch triggers (`visible` changes) within
   that margin after the tick that expired a promise. That snapshot can land back
   before `retry_due_at + grace`: "will retry" returns and Retry hides again for up to
   one more tick (60 s). This is the "plain failure that later turns into will retry"
   shape that spec section 1 excludes, here at the end of the promise rather than the
   start. It needs a refetch inside a window of about a second, so it is rare, and no
   test covers it.

   Correction: record it as a residual (spec section 9 or the Task 20 residual table)
   or rule on it. No redesign is proposed here.

8. **note - Task 17 - one new comment overclaims.** The chip comment (plan
   :8975-8977) says a native group text "gets no stamp (D11)". Under D3a's fail-open
   a `group_text` row can be stamped (spec D11: "If the read fails, D3a fails
   open"). What holds is that no screen shows that stamp:
   - The contact timeline skips `group_text` conversations
     (`app/src/routes/contactTimeline.ts:1228-1232`).
   - The group view's fixed field list drops the field
     (`dashboard/src/routes/conversation/useRelayThread.ts:101-152`).

   Correction: say that no screen renders a group text's stamp. D12 exists to keep
   comments true.

9. **note - surfaces the plan does not name.** Each was checked and needs no change.
   - `dashboard/src/routes/contact/buildTimelineFallback.ts:63-100`, the 404-only
     fallback (`useContactTimeline.ts:175-178`), projects neither `error_code` nor
     `retry_of`, and will not project `retry_due_at`. On that path a bubble shows no
     reason and keeps Retry; a press gets Task 12's 409, which Task 17 maps.
   - Some fetches bypass `requestWithStatus`, and each correctly leaves the clock
     alone:
     - The SSE `EventSource` (`dashboard/src/api/EventStreamProvider.tsx:160`) exposes
       no headers and only triggers refetches, which do go through the client.
     - The presigned S3/MinIO upload (`dashboard/src/api/endpoints.ts:1143-1182`) is
       a cross-origin XHR or a credential-less `fetch`, and S3's clock is not the
       app's.
     - Dev-login (`endpoints.ts:1722-1723`) and the public pages
       (`routes/public/publicApi.ts:12`) go through `request`.
   - The spoken summary cannot carry the promise. `recipientSummaryName`
     (`Timeline.tsx:588-630`) builds leg reasons from `{ media, relay }` only (:605).
     The one recital that reads the message-level `reason`, `messageChipName`
     (:1128-1139), exists only for a non-empty recipient map where every member opted
     out. If the promise ever reached a recital, `speakDeliveryText` (:564-566) would
     split it at " - " and read "Phone unreachable, will retry (error 30003)".

10. **note - optional comment remnants outside D12's list.**
    - `Timeline.delivery.test.tsx:439-440` says 30003's "will retry" copy must not
      appear. After Task 15, no 30003 copy says "will retry" except the scheduled
      promise; the assertion at :457 stays valid.
    - `Timeline.tsx:950-951` says failures expose a reason and Retry. After Task 17,
      Retry is withheld while the promise is live.

    Neither misleads enough to require an edit. Touch them only while already
    editing nearby.
