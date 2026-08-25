# Log hygiene: vendor errors, PII, and alarm noise (cluster C3)

Date: 2026-08-24
Status: DRAFT - awaiting adversarial doc review + human review gate
Branch: feat/log-hygiene (worktree W:\tmp\log-hygiene, cut from main @6e707348)

## 0. Scope and issue map

This mission closes the C3 cluster from `docs/issues/_CLUSTERS.md`: the
credential-leak class around vendor SDK errors, plus every rider that the
same seam-opening pass reaches. Nine issues:

| # | issue | disposition in this spec |
|---|---|---|
| 1 | `twilio-sdk-error-logs-leak-credentials` (high) | Sections 1-3: safe serializer + targeted sweep + guard test |
| 2 | `telemetry-phone-in-url-pii` (med, deferred) | Section 4: masking at the log/span edge; structural half re-filed |
| 3 | `relay-intro-dlr-unknown-sid-noise` (low) | Section 5: system SID markers for unpersisted legs |
| 4 | `relay-direct-sends-unknown-sid-callbacks` (low) | Section 5: same fix, same close |
| 5 | `push-users-scan-failure-logs-error-per-message` (low) | Section 6: attempt floor on the failed refresh |
| 6 | `push-failure-status-not-surfaced` (low) | Section 6: statusCode on the per-device WARN |
| 7 | `voice-push-pii-masking-outdated` (low) | Section 7: full caller identity in voice pushes |
| 8 | `ai-runs-throttled-batchget-renders-expired` (low) | Section 8: distinct `unavailable` row state |
| 9 | `abandoned-journal-pii-until-next-contact-read` (low, decision) | Section 9: sanctioned worker sweep (operator decision 2026-08-24) |

NOT in scope (cluster doc marks them a separate mission):
`one-off-scripts-missing-account-guard`, `aws-cli-identity-can-diverge-from-account-guard`.

Concurrent-work exclusion: another agent's C1 mission is editing
`app/src/lib/unreadFeed.ts`, `app/src/routes/inbox.ts`,
`app/src/routes/contacts.ts`, and the conversations/contacts repos in
`W:\tmp\inbox-unread-read-path`. The sweep (section 2) MUST NOT touch those
files. Any qualifying call sites found in them are recorded in the sweep
report as an owed follow-up pass at merge time.

## 1. Structural fix: safe error serializer (anchor issue)

### 1.1 The problem being closed

pino's default `err` serializer copies every enumerable own key of the error
object. An axios-backed vendor error (the Twilio SDK's network-failure path)
carries `config.headers.Authorization` (a live Basic credential),
`config.data` (form body: phones, message text), and `request._header` (the
serialized request head, credential included). Today's defenses are a
path-literal, case-sensitive redact list (`app/src/lib/logger.ts`) and the
discipline of calling `summarizeError` (`app/src/lib/errors.ts`) at
vendor-reachable sites. Both are enumerated defenses: a new SDK key or a new
call site silently reopens the class. The express error handler and the
process-level handlers (`errors.ts`) log raw `{ err }` by design (full
stacks) and are protected today ONLY by the redact list.

### 1.2 The fix

`createLogger` (app/src/lib/logger.ts) wires an explicit `serializers` map
with ONE safe error serializer bound to the error-carrying keys:

- Keys wired: `err` (pino's error key), plus the common drift keys `error`,
  `cause`, and `reason`.
- Emitted allowlist, copying NOTHING else: `name`, `message`, `stack`,
  `code`, `status`, `statusCode` (each only when present and of the
  expected primitive type; `code` normalized to string as `summarizeError`
  already does for Twilio's numeric codes).
- `cause` chains: when `err.cause` is itself an Error (or object), the
  serializer recurses with the same allowlist, to a fixed depth of 3;
  deeper links are dropped. An `AggregateError`'s `errors` array is
  summarized the same way, capped at 5 entries.
- Non-Error values passed under a wired key are handled without throwing:
  primitives pass through as `{ message: String(value) }` semantics using
  the same guarded stringification `toError` uses; objects get the
  allowlist treatment.
- The serializer never throws. Any internal failure degrades to
  `{ name: 'UnserializableError' }`.

Consequences:

- `config`, `request`, `response`, and every future enumerable an SDK
  invents structurally CANNOT reach a log line through a wired key, at
  every present and future call site - the express error handler,
  uncaughtException/unhandledRejection, and all 92 files of `{ err }`
  sites included.
- Full `stack` and `message` are PRESERVED everywhere, keeping the
  "errors are first-class logs" binding guideline intact.
- Accepted residual (operator ruling, brainstorm 2026-08-24): vendor
  `message` text can echo a phone number or an offending parameter. That is
  consistent with the lifted telemetry PII gate (2026-08-15). The
  credential never rides in `message`.

The existing redact list STAYS, verbatim, as defense in depth (anchor issue
item 4): it still covers a raw error smuggled under an unwired key inside a
larger payload (e.g. `{ ctx: { err } }` - nested objects bypass top-level
serializers).

### 1.3 Interaction notes (load-bearing)

- pino applies `serializers` to top-level keys of the merge object and
  applies `redact` to the SERIALIZED output, so redact remains effective on
  what the serializer emits (nothing to redact in the allowlist, but the
  ordering means the two compose rather than conflict).
- `logger.error(err, 'msg')` (error as first arg) is wrapped by pino under
  the error key, so it flows through the same serializer.
- The dev log ring (`createDevLogTailStream`) sits DOWNSTREAM of
  serialization, so e2e logtail assertions see exactly the sanitized shape.
- `summarizeError` remains the right call for sites that want a TERSE
  summary with no stack and no message (its allowlist deliberately excludes
  `message`). The serializer is the backstop; `summarizeError` is the
  narrow-signal choice. Both stay.

## 2. The sweep (anchor issue, items 1-2)

Audit every `log.*` call whose payload carries an error (the ~331-site,
92-file grep universe for `err:`/`{ err`/`, err`), and classify:

- VENDOR-REACHABLE (the error can originate in a vendor SDK: twilio, any
  @aws-sdk client, web-push, the Anthropic driver, axios/fetch wrappers):
  convert to `summarizeError(err)` where the site wants a terse outcome
  signal, or leave `{ err }` where the full stack is diagnostic - both are
  now safe; the conversion choice is about log volume and signal, not
  safety. The two named anchors (`adapters/messaging.ts` throw path
  consumers, `lib/errors.ts` handlers) are covered by section 1 and stay on
  `{ err }` deliberately (full stack wanted).
- ERROR UNDER A NON-WIRED KEY (e.g. `error: err` in a nested object, or a
  raw error interpolated into `msg`): rewire to a wired key or summarize.
  These are the sites the serializer cannot protect; the sweep's primary
  yield is finding them.
- DOMAIN-ONLY: leave untouched.

Deliverable: a sweep table in the build report (file, line, class,
action taken), including the excluded-C1-files rows marked `EXCLUDED`.

## 3. Enforcement (anchor issue, item 3)

A guard TEST, not an eslint rule (main carries ~117 pre-existing lint
errors; lint is gate 5 scoped to branch-touched files, so a new repo-wide
rule cannot gate). New file `app/test/logSanitization.test.ts`:

1. END-TO-END CREDENTIAL PROBE: build a real `createLogger` over an
   injected capture destination; construct a synthetic AxiosError-shaped
   Error carrying `config.headers.Authorization: 'Basic <fake-base64>'`,
   `config.data: 'To=%2B15551230000&Body=hello'`, and
   `request._header` with the same fake credential; log it under EACH wired
   key (`err`, `error`, `cause`, `reason`) and as pino's first-arg error
   form. Assert the captured JSON lines contain neither the fake credential
   sentinel nor the form body, at any depth (substring scan of the raw
   line). The sentinel is a clearly-fake value (e.g. base64 of
   `SKfake:secretfake`), never a real credential shape from the env.
2. ALLOWLIST PIN: assert the serialized error object's keys are a subset of
   the allowlist and that `name`/`message`/`stack` survive, including
   through a 2-deep `cause` chain and an AggregateError.
3. NESTED-KEY HONESTY: log `{ ctx: { err: syntheticAxiosError } }` and
   assert the REDACT list catches the credential paths it enumerates -
   pinning that the backstop still holds for the shape the serializer
   cannot reach. (If redact does not cover a nested variant, the test pins
   the known-covered shapes only; the sweep keeps such shapes out of the
   codebase.)

The existing redact-list unit coverage (if any) is left in place; this test
is additive.

## 4. Telemetry phone masking (`telemetry-phone-in-url-pii`)

New helper in `app/src/lib/` (e.g. `piiMask.ts`):
`maskPhonesInText(text: string): string` - masks E.164-shaped segments
(`+` followed by 8-15 digits, and the URL-encoded `%2B` variant) to a stable
`+1...07` form (country code + last two digits). Pure, ASCII, unit-tested
against path shapes (`/api/contacts/abc/phones/+14045551234`, query strings,
multiple phones, no-phone passthrough).

Applied at BOTH sinks the issue names:

- `middleware/requestLogger.ts`: `path: maskPhonesInText(req.path)` on both
  the "request received" and "request completed" lines.
- `lib/otel.ts` (`buildOtelSdkConfig`): `HttpInstrumentation` gains hooks
  masking the phone-bearing attributes on BOTH incoming server spans and
  outgoing client spans (`applyCustomAttributesOnSpan` /
  `startIncomingSpanHook`-equivalent - the exact hook name per the
  installed instrumentation version, chosen at build time) for the
  url/target/route attributes. The hook must be a no-op-safe wrapper: a
  masking failure never breaks span export.

Issue close-out: the log/span layer is DONE; the structural half (phones
out of URL paths for the two routes) is re-filed as a new low issue
(`phone-in-url-paths-structural`) referencing the deferred decision, and
`telemetry-phone-in-url-pii` is resolved.

## 5. Unknown-SID DLR noise (both relay issues)

FINDING (2026-08-24 re-verification; both issues are PARTIALLY STALE):
every production send path now resolves its DLRs. The four
`adapter.sendMessage` call sites are: relayFanOut fan-out leg (slot +
`putRelaySidPointer`), relayAnnouncements (slot + pointer when
`persist !== false` - intros, member-added, group tour reminders all route
through it), voiceApi cell-verification (`putSystemSidMarker`), and
sendMessage service (persisted message). The `/webhooks/twilio/status`
handler already resolves system markers to an INFO ack. What still ERRORs:

- `persist: false` announcement legs - the dev replay seam
  (`POST /__dev/relay/replay-intros`, hermetic lanes only), which skips the
  slot AND the pointer. This is the source of the per-e2e-run noise the
  issues describe.
- Genuine crash-orphans and lost outcomes - which MUST keep the ERROR (the
  "closing the loop" backstop feeding `hc-<env>-error-logs`).

Fix: in `relayAnnouncements.ts`, when `persist === false`, write
`putSystemSidMarker(result.providerSid, kind)` for each leg (kind is the
announcement kind, e.g. `relay.intro`). The DLR then lands in the existing
system-marker INFO branch. No webhook change, no From-number heuristic, no
new mechanism. The marker write sits immediately after the send, the same
position as the pointer write on the persisted path; the webhook's existing
second-lookup retry covers the same write-race window either way.

Verification task for the builder: re-grep for any OTHER direct
provider-send path (SMS or MMS) that persists neither a message, a pointer,
nor a marker; the spec's claim is that none remain - prove it in the build
report.

Issue close-out: both issues resolved, each with a note recording the stale
half (announcement persistence closed the production case in the
interim; this change closes the dev-replay case) and the retained ERROR
semantics for genuine losses.

## 6. Push pair

### 6.1 Attempt floor (`push-users-scan-failure-logs-error-per-message`)

`services/pushService.ts` `sendToAll`: add `lastRefreshAttemptAt`
(module-instance state next to `usersCache`). The refresh is attempted only
when `now() - lastRefreshAttemptAt >= REFRESH_RETRY_FLOOR_MS` (30_000);
`lastRefreshAttemptAt` is stamped on every ATTEMPT (success or failure).
Within the floor after a FAILED attempt:

- cache inside the stale bound: fan out to it, and log the stale-serve line
  at DEBUG (was WARN per message) - the WARN/ERROR from the actual attempt
  already told the operator.
- no cache / past the stale bound: drop the broadcast with a DEBUG line
  (the window-opening ERROR already fired and reached the alarm).

Semantics preserved: the FIRST failure in a window still logs at the
original level (alarm fires); `fetchedAt` still never advances on failure,
so the stale bound keeps counting; a SUCCESSFUL refresh resets the floor
naturally. Net: one ERROR/WARN per ~30s failure window instead of one per
inbound message, and one Scan attempt per window instead of per message.

### 6.2 Status surfacing (`push-failure-status-not-surfaced`)

In the shared per-device loop's transient-failure WARN
(`push: send to one device failed (transient) - kept subscription`): add
`statusCode: (err as { statusCode?: number }).statusCode` to the fields
(undefined when absent - network errors carry none). A 413 (cap
regression), 429 (rate limit), and 5xx (vendor blip) become
distinguishable. `SendOutcome` is unchanged; no control-flow change. The
issue's note that these lines were frozen by the inbound-message-push spec
is superseded by THIS spec's review (the freeze was "needs its own review",
which this is).

## 7. Voice push payload alignment (`voice-push-pii-masking-outdated`)

Product-behavior rider (operator ruling D4, 2026-08-16, re-confirmed at
brainstorm 2026-08-24): the three staff-facing voice pushes (`pre_ring`,
`missed_call`, `voicemail` in `routes/webhooks/voice.ts`) carry FULL caller
identity like the message pushes - the caller's real name where known, the
real number where not. `pushCallerLabel`'s founder-device-only raw-number
special case is removed; the comments asserting the masked posture are
rewritten to cite D4. LOG posture unchanged: pushService and the voice
routes still never log payload contents. Out of scope: voice <Say>
prompts, SMS bodies, the masked relay identity system, sw.js rendering
(payload fields keep their names; only their VALUES stop being masked).

Watch item: the sw.js mirror test pins literals
(`sw-mirror-test-pins-literals-not-behaviour`) - this change must not touch
`dashboard/public/sw.js` or `dashboard/src/sw/*`; if it somehow needs to,
stop and reassess.

## 8. ai-runs: distinct `unavailable` state (full fix)

`repos/aiRunsRepo.ts`:

- `batchGetRuns` returns `{ found: Map<string, AiRunRecord>,
  unprocessedRunIds: Set<string> }` (today's unprocessed tally, kept as the
  once-per-call WARN, becomes the set's size).
- `listByEntity` maps each pointer: found -> `{ ..., expired: false, run }`;
  in `unprocessedRunIds` -> `{ runId, sortKey, unavailable: true }`;
  otherwise -> `{ runId, sortKey, expired: true }` (genuinely absent /
  TTL-reaped).
- `AiRunListEntry` union widened with the `unavailable` variant.

`routes/aiRuns.ts`: serialize the new variant verbatim (same pass-through
the `expired` variant gets today).

Dashboard: widen the list-row union in `dashboard/src/api/types.ts`;
`AiRunList.tsx` renders the unavailable case as a non-destructive
"Temporarily unavailable - retry" row whose retry affordance re-fetches the
current page (the list's existing fetch), NOT a per-row endpoint. Copy is
dashboard-internal (staff UI), so no message-catalog entry is required;
wording finalized at build time with the standard self-audit.

Tests: repo unit test forcing UnprocessedKeys exhaustion (fake doc client)
asserting the split; route test for serialization; dashboard component test
for the row rendering + retry invoking the list refetch.

## 9. Abandoned-journal sweep (decision executed)

Operator decision (brainstorm 2026-08-24): the periodic sweep the issue's
"revisit if" clause contemplates is now SANCTIONED, on the existing worker
poll loop - no new infrastructure, no TTL.

Design, reusing the recovery machinery wholesale:

- `repos/suggestionResolutionRepo.ts` gains a bounded enumeration of ACTIVE
  journals: a table Scan over `ai_extraction` with
  `begins_with(itemId, 'resolve#')` and `state = 'active'` filter,
  paginated, returning `{ contactId, target, leaseExpiresAt, <ageAnchor> }`
  parsed from the row (the itemId embeds `resolve#<contactId>#<target>`).
  `resolve#` rows are in NO GSI by design, so a Scan is the only
  enumeration; at this table's size and a daily cadence the cost is
  negligible, and the page size is capped.
- New worker duty `jobs/journalSweep.ts` registered via
  `startPoll('journal sweep', ...)` in `worker.ts`, CADENCED like
  `groupGuardrails` (conditional claim on a settings record) to act once
  per day regardless of process count or poll interval. Per qualifying row
  - lease expired AND older than `JOURNAL_SWEEP_MIN_AGE_MS` (24h) - it
  collects the distinct contactIds and calls the EXISTING
  `suggestionResolution.recoverAbandoned(contactId)`, which takes over and
  drives each journal through `applyJournal` to completion, ending in the
  same `makeCompletedResolution` scrub. No second completion path is
  introduced; leases, fencing, verdict stamping, and the
  MAX_RECOVERIES_PER_READ budget all apply unchanged (the sweep loops a
  contact until `recovered` comes back 0, bounded by a per-run contact cap
  and a per-run recovery cap, both constants).
- Logging: counts and ids only (journals found / recovered / failed), never
  values - the same posture `recoverAbandoned` already has.
- Dev seam: the sweep runs through the worker; hermetic e2e coverage is NOT
  required (unit tests fake the repo + service), keeping the lean-profile
  world byte-stable.

Issue close-out: `abandoned-journal-pii-until-next-contact-read` resolved,
recording the decision reversal and the sweep's constants.

## 10. What this mission deliberately does NOT do

- No eslint rule (guard test instead - see section 3 rationale).
- No repo-wide forced conversion to `summarizeError` (stacks are wanted at
  domain sites; the serializer makes them safe).
- No changes to the C1 agent's files (owed follow-up recorded instead).
- No TTL on `ai_extraction`; no new tables, indexes, or infrastructure.
- No changes to what the SERVER logs about push payloads (section 7 changes
  what the push carries, not what is logged).
- No message-catalog entries: nothing here is automated user-facing copy
  (log lines and staff-dashboard UI only).
- No infra mutations of any kind. Post-merge obligations: none expected
  (code-only; no new deps, no schema changes - the ai_extraction Scan and
  settings-record claim use existing tables).

## 11. Testing and gates

Unit: serializer (shapes, depth caps, non-Error inputs, never-throws),
guard test (section 3), maskPhonesInText, requestLogger masked path, otel
hook wiring (config-shape test like the existing buildOtelSdkConfig tests),
relayAnnouncements persist:false marker writes, pushService floor +
statusCode fields (fake clock), aiRunsRepo split + route serialization,
journal sweep (fake repo/service: claims, age gate, caps, counts).
Dashboard: AiRunList unavailable-row test. E2E: no new spec is REQUIRED by
this spec (no primary user flow changes); the build may extend an existing
spec cheaply where a guardrail assertion fits the logtail seam (e.g. the
absence of unknown-SID ERRORs after a replay-intros boot is observable via
`/__dev/logtail` if an existing spec already exercises that path).

Gates, bare, from the worktree: `npm run typecheck`, `npm test`,
`npm run smoke`, `npm run e2e`, plus `npx eslint <touched files>` (gate 5).
One main sync at the final pre-handback step.

## 12. Issue-file mutations shipped with the branch

- Resolve with dated stamps: items 1, 3, 4, 5, 6, 7, 8, 9 of the table in
  section 0, plus item 2 with its structural remainder re-filed as
  `docs/issues/phone-in-url-paths-structural.md` (low, copied template).
- `npm run issues` regenerates the index (gitignored; run, not committed).
- Inline `TODO(<slug>)` markers touched by the sweep are updated or removed
  where their issue is resolved here.
