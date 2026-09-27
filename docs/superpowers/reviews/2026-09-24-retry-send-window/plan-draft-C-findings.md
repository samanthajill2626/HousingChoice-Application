# Plan draft C findings - dashboard (Tasks 14-18)

Drafter: slice C, 2026-09-25, read-only at `fd38ba73` (source identical to `f49a2fe9`).
Tasks written to `.superpowers/plan-drafts/slice-C.md`. Every citation is `path:line`
at HEAD. No code is pasted here.

## 1. The `Date`-header route is sound (asked to verify)

Verdict: the response `Date` header is a fresh server-clock sample on every call
the dashboard makes through its API client, in production and in the lanes.

- One transport. Every API call goes through `requestWithStatus`
  (`dashboard/src/api/client.ts:92-123`); `request` wraps it (`:129-131`). The
  timeline itself is fetched through it (`dashboard/src/api/endpoints.ts:1360-1370`,
  used by `dashboard/src/routes/contact/useContactTimeline.ts:11-22`). The only raw
  `fetch` outside the client is the S3 upload POST (`dashboard/src/api/endpoints.ts:1175`),
  which never touches `noteServerDate`.
- No client-side cache logic. A grep of `dashboard/src` finds no ETag,
  `If-None-Match`, 304 handling or `cache:` fetch option. The service worker has no
  fetch handler (`dashboard/public/sw.js:47-88` registers install, activate, push and
  notificationclick only), so no response is served from a worker cache.
- Browser HTTP cache. The app sets no `Cache-Control` on API JSON: the only
  `Cache-Control` writes are the manifest redirect (`app/src/app.ts:197`),
  app-identity (`app/src/routes/appIdentity.ts:31`, `:36`, `:62`), unit media
  (`app/src/routes/unitMediaServe.ts:69`), and `private, max-age=3600` on the call
  recording and MMS media routes (`app/src/routes/api.ts:2307`, `:2403`). Those two
  are element sources (`<audio src>` at `dashboard/src/routes/contact/Timeline.tsx:1607`,
  `<img>`/link `src` via `messageMediaSrc`), never fetched through the client.
  Express's `res.json` sets no `Last-Modified`, so a browser assigns no heuristic
  freshness and revalidates every GET (Express's default weak ETag; no `etag`
  setting anywhere in `app/src`). A revalidated 304 carries its own `Date`, which
  replaces the stored one (RFC 9111 section 4.3.4) - the spec's D8 premise holds.
- Edge. CloudFront serves `/api/*`, `/webhooks/*`, `/auth/*`, `/public/*` with the
  managed CachingDisabled policy and the all-viewer origin-request policy
  (`infra/modules/cloudfront/main.tf:157-169`); the default behavior is
  CachingDisabled too (`:203-211`); the 502/504 maintenance pages are served with
  `error_caching_min_ttl = 0` (`:213-225`). Nothing on the API path is edge-cached,
  so no stale `Date` can come back from the edge.
- Local dev and hermetic lanes: the Vite proxy forwards `/api` to the app
  (`dashboard/vite.config.ts` proxy block) and passes the app's `Date` through.
- Error bound: the header has one-second resolution (the server drops the
  milliseconds) and is stamped before the trip, so the estimate LAGS the true server
  clock by under a second plus the one-way latency, and never leads it. Consequence,
  and it is the safe direction: the promise shows that much longer, and the Retry
  button never reappears before the server's 409 guard would accept the press.
- Watch item (not a defect): a future API route that sets `max-age` on JSON AND is
  fetched through `request()` would feed a stale `Date`. The rationale is written into
  `serverClock.ts`'s header so the next person to add caching sees it.

## 2. Design choice inside the contract (not a contract change)

- The Timeline judges the promise on ONE server-clock snapshot per arming decision:
  the `tickerArmed` memo (`Timeline.tsx:2101-2104`) takes `serverNowMs()` once,
  arms on it, and hands the same value down beside `tickNow` as a new required prop
  `promiseNowMs` on `StreamItem` (`:1719-1738`) and `MessageBubble` (`:901-929`). One
  module-private predicate, `showsRetryPromise`, serves the chip's copy (`:980`), the
  Retry gate (`:1341`) and the run condition (`:859-899`).
- Why not a raw `serverNowMs()` at each render site (the brief's wording): the
  estimate is re-taken on EVERY API response and jitters by up to about a second plus
  latency between responses. A bubble re-rendered on its own (a reveal click,
  `Timeline.tsx:1159-1162`) or by a composer keystroke would re-judge the promise on a
  clock the memo never saw; an estimate that moved backwards across the edge would
  re-show an expired promise, with Retry hidden, after the ticker had already
  disarmed - a stuck "will retry" until some unrelated re-render. One snapshot makes
  that impossible by construction and does not churn the memo on keystrokes (the
  `EMPTY_RETRY_INDEX` note at `:2044-2046` relies on that memo not recomputing every
  render).
- Why not `bubbleClocks` (`:758-766`, the "bubble clock" the spec's section 4 names
  at `:1016`): that clock is the browser tick and is WITHHELD on imported rows, so it
  cannot carry a server-clock promise. `bubbleClocks` is left unchanged.
- The contract's three `serverClock` exports and two `retryPromise` exports are used
  exactly as specified; nothing was renamed or retyped.

## 3. Intermediate red window between Task 15 and Tasks 17/18 (planner decision)

Task 15 changes the SHARED base 30003 wording, so four tests owned by later tasks go
red at Task 15's commit and stay red through Task 16:
`Timeline.delivery.test.tsx:516` and `:577` (turned by Task 17),
`Timeline.email.test.tsx:96` and `StatChips.test.tsx:134` (turned by Task 18).
Task 15 Step 5 names all four and says who turns them; Task 18 Step 5 runs the whole
dashboard suite to prove the window closed. If every commit must be green, fold those
four expectation flips into Task 15 (they need no source change) and leave Tasks 17
and 18 with the rest.

## 4. Spec line drift (pre-Branch-A numbers) - corrected in the tasks

- `deliveryStatus.ts` order comment: spec D12 and section 4 cite `:959-969`; at HEAD it
  is `:990-1000` (Branch A's `SHARE_SKIP_REASONS`, `:937-966`, landed above it; at the
  branch cut `685f2ede` it was at `:959`). The chain is `:1001-1004`.
- `StatChips.test.tsx`: spec cites `:120-127` (comment) and `:129` (test); at HEAD
  they are `:128-133` and `:134-138`.
- `Timeline.delivery.test.tsx:509-515` itself cites stale Timeline lines (`:1519`,
  `:796`, `:2083`); the rewritten comment cites `Timeline.tsx:1790` and `:906`.
- `deliveryStatus.ts:661-663` (`presentLegDelivery` doc) quotes the order comment's
  phrase "because nothing observable depends on it today"; Task 15's rewrite keeps that
  phrase so the quote still resolves.
- `deliveryStatus.test.ts:750` cites `Timeline.tsx:1037-1042`, which no longer matches
  the per-recipient row (now `:1246-1319`);
  the rewritten order comment names the surface instead of a line.

## 5. Cross-slice dependencies (consumed, not re-specified here)

- Task 1: the mirror test imports `app/src/lib/retrySendWindow.ts` into the dashboard
  program and its vitest run, like `mediaTypeMirror.test.ts:18-25`. The module must stay
  a near-leaf - no import of config, logger or an AWS SDK. Reading `process.env` for a
  lane seam is fine: `dashboard/vite.config.ts` already uses `process` under the
  dashboard tsconfig (`dashboard/tsconfig.json` includes it). The app's
  `isRetryPromiseLive` must answer `false` for `''`, a garbage string and
  `RETRY_PROMISE_WITHDRAWN_AT`, and be exclusive at `due + grace`; the mirror table
  asserts both predicates agree.
- Task 13: `retry_due_at?: string` on `TimelineMessage` (`dashboard/src/api/types.ts`,
  beside `retry_of` at `:2494`). Every Task 17/18 fixture sets it; without it
  `npm run typecheck` fails.
- Task 12: the refusal body `{ error: 'retry_pending' }`, the same shape as the
  route's other 409s (`app/src/routes/api.ts:1586`, `:1594`); `errorFrom`
  (`dashboard/src/api/client.ts:68-76`) makes it `ApiError.code`.
- Tasks 4 and 5: a window decline closes the rung with the pre-send refusal shape -
  `{ status: 'failed', errorCode: 'retry_window_closed' }`, aggregation `excluded` on a
  versioned row (`app/src/jobs/relayRetryLeg.ts:449-467`, `app/src/routes/webhooks/twilio.ts:627-660`).
  Task 16's fixtures use that shape.

## 6. Surface coverage

- The one-to-one promise and the Retry button exist only on the contact timeline:
  it excludes relay and group threads by name (`app/src/routes/contactTimeline.ts:1232`),
  `ConversationDetail` redirects a 1:1 conversation to its contact page
  (`dashboard/src/routes/conversation/ConversationDetail.tsx:1-8`, `:160`), and the
  placement and tour 1:1 tabs embed the same `ContactCommsPane`
  (`PlacementConversation.tsx:11`, `TourConversation.tsx:11`). Only `ContactCommsPane`
  wires `onRetry` (`ContactCommsPane.tsx:304-308`, `:338`).
- Relay and group threads go through `toTimelineMessage`
  (`dashboard/src/routes/conversation/useRelayThread.ts:69-151`), a FIXED field list that
  does not project `retry_due_at`. Correct by design: relay rows are never stamped, and a
  group_text row is stamped only through D3a's fail-open on a failed read - a stamp no
  screen then renders (the contact timeline excludes group threads). Nothing to change.
- The fallback builder (`dashboard/src/routes/contact/buildTimelineFallback.ts:27-80`)
  carries neither `error_code` nor `retry_of` today, so the fallback path shows no reason
  and no promise; unchanged.
- Every `deliveryReason` caller was checked: `Timeline.tsx:614` (recital), `:980`
  (one-to-one chip - the ONLY site that passes `retryScheduled`), `:1286` (row),
  `:1645` (EmailCard), `dashboard/src/routes/broadcasts/broadcastFormat.ts:158`
  (share row), plus the presenters' internal calls (`deliveryStatus.ts:469`, `:732`,
  `:762`). Task 18 Step 4 re-checks this with `git grep`.

## 7. Residual behavior worth naming

- Hidden tab: the interval only bumps while the tab is visible
  (`Timeline.tsx:2110-2122`), so a promise can outlive "grace plus one tick" while the
  tab is hidden; the focus listener re-renders on return. Same trade the staleness
  ticker already makes.
- Expiry granularity: the promise drops at the first tick at or after
  `retry_due_at + RETRY_PROMISE_GRACE_MS` on the server clock (the ticker tests pin the
  exact millisecond: 180 s for a 60 s backoff), plus the header lag in section 1.

## 8. Risks and small notes

- Test doubles: `requestWithStatus` now reads `res.headers` on every response,
  including a 204 that `parseBody` used to return early on (`client.ts:57`). Every
  current dashboard fetch double exposes `headers` (real `Response`s or `new Headers`:
  `client.maintenance.test.ts`, `mmsMedia.client.test.ts`, `AuthContext.test.tsx`,
  `Login.test.tsx`, `App.test.tsx`, `AppFrame.test.tsx`), but a future hand-built
  double without `headers` would now throw. Production `Response`s always carry it.
- Lint: `EM_DASH` in `deliveryStatus.test.ts:668` stays used (Task 15's ASCII test);
  `EM_DASH` in `Timeline.delivery.test.tsx:68` and the local `emDash` in
  `Timeline.email.test.tsx:112` are deleted with their last use - otherwise
  `@typescript-eslint/no-unused-vars` (an error, `eslint.config.mjs`) fails gate 5.
  The new memo lists every value it reads; `serverNowMs` is an import, so
  `react-hooks/exhaustive-deps` has nothing to flag, and the React Compiler purity rule
  only knows literal `Date.now()`-style globals.
- `Timeline.tsx` imports `serverNowMs` from `api/serverClock.js`, not through the api
  barrel (`dashboard/src/api/index.ts:1-2` calls itself the one import surface). Chosen
  so the barrel stays untouched and a barrel mock in a component test can never erase
  the clock; if the barrel convention must hold, add a re-export there instead.
- No drift guard pins the dashboard's hand-copied relay close codes against
  `RelayRetryCloseCode` (`app/src/jobs/relayRetryLeg.ts:91-97`); the new
  `WINDOW_CLOSED_CODE` literal in `relayRetryJoin.ts` joins the four existing gate codes
  in `deliveryStatus.ts:931-934`, none of which is guarded either. Out of scope; a
  mirror test like `mediaTypeMirror.test.ts` would close it.
- send-outcome-reconcile requirement 7 (spec section 5): both branches edit the join's
  terminal step (`relayRetryJoin.ts:405-415`). This slice's pins that must survive that
  merge: the two `retry_window_closed` join tests and
  `reads a window-declined rung as the plain 30003 failure at all three positions`.
- `hasTickableLeg` keeps its name although clause 7 is not a leg; renaming would churn
  the file's long docblocks for no behavior.
- `sendFailureMessage` (`Timeline.tsx:86-131`) serves the composer's sends too;
  `retry_pending` is emitted only by the retry route, so the new case cannot misname a
  send refusal.
- The spec leaves the route open ("Either route is the plan's", D8). This slice takes
  the `Date` header, so the timeline route needs no `Cache-Control: no-store` and no
  server-now body field - nothing extra for Task 13.
