# Log hygiene: vendor errors, PII, and alarm noise (cluster C3)

Date: 2026-08-24 (v2 after adversarial doc review round 1)
Status: DRAFT - awaiting round-2 review + human review gate
Branch: feat/log-hygiene (worktree W:\tmp\log-hygiene, cut from main @6e707348)
Review artifacts: .superpowers/design-review/ (spec-r1-a.md, spec-r1-b.md,
adjudications.md)

## 0. Scope and issue map

This mission closes the C3 cluster from `docs/issues/_CLUSTERS.md`: the
credential-leak class around vendor SDK errors, plus every rider the same
seam-opening pass reaches. Nine issues:

| # | issue | disposition in this spec |
|---|---|---|
| 1 | `twilio-sdk-error-logs-leak-credentials` (high) | Sections 1-3: safe serializer + sweep + runtime AND static guards |
| 2 | `telemetry-phone-in-url-pii` (med, deferred) | Section 4: masking at every log sink + span hooks; structural half re-filed |
| 3 | `relay-intro-dlr-unknown-sid-noise` (low) | Section 5: system SID markers for unpersisted legs |
| 4 | `relay-direct-sends-unknown-sid-callbacks` (low) | Section 5: same fix, same close |
| 5 | `push-users-scan-failure-logs-error-per-message` (low) | Section 6: attempt floor on the failed refresh |
| 6 | `push-failure-status-not-surfaced` (low) | Section 6: statusCode on the per-device WARN |
| 7 | `voice-push-pii-masking-outdated` (low) | Section 7: push-time full-identity resolution |
| 8 | `ai-runs-throttled-batchget-renders-expired` (low) | Section 8: distinct `unavailable` row state |
| 9 | `abandoned-journal-pii-until-next-contact-read` (low, decision) | Section 9: sanctioned worker sweep (operator decision 2026-08-24) |

NOT in scope (cluster doc marks them a separate mission):
`one-off-scripts-missing-account-guard`, `aws-cli-identity-can-diverge-from-account-guard`.
Also out of scope: the Conversations group rail's deliberately-absent
`syssid#` markers (see section 5's boundary note).

Concurrent-work exclusion: another agent's C1 mission is editing
`app/src/lib/unreadFeed.ts`, `app/src/routes/inbox.ts`,
`app/src/routes/contacts.ts`, and the conversations/contacts repos in
`W:\tmp\inbox-unread-read-path`. The sweep (section 2) MUST NOT touch those
files. VERIFIED SAFE to exclude: every `{ err }` site in those files uses
the wired `err` key (unreadFeed.ts:543,585; inbox.ts 10 sites;
conversationsRepo.ts:2389; contactsRepo.ts:745 - reviewer A, round 1), so
the section-1 serializer covers them with no residual exposure. They are
re-audited at merge reconcile only for NEW sites added by C1.

## 1. Structural fix: safe error serializer (anchor issue)

### 1.1 The problem being closed

pino's default `err` serializer copies every enumerable own key of the
error it is handed. An axios-backed vendor error (the Twilio SDK's
network-failure path) carries `config.headers.Authorization` (a live Basic
credential), `config.data` (form body: phones, message text), and
`request._header` (the serialized request head, credential included).
Today's defenses are a path-literal, case-sensitive redact list
(`app/src/lib/logger.ts:184-224`) and the discipline of calling
`summarizeError` (`app/src/lib/errors.ts:64`) at vendor-reachable sites.
Both are enumerated defenses: a new SDK key or a new call site silently
reopens the class. The express error handler and the process-level
handlers (`errors.ts:116,126,140,152,159`) log raw `{ err }` by design
(full stacks) and are protected today ONLY by the redact list.

### 1.2 The serializer

`createLogger` (app/src/lib/logger.ts) wires an explicit `serializers` map
binding ONE safe error serializer to four keys: `err` (pino's error key)
and the drift keys `error`, `cause`, `reason`.

Value handling, in order:

1. PRIMITIVES PASS THROUGH UNCHANGED (string, number, boolean, null,
   undefined, bigint). This is load-bearing: `reason` and `error` are live
   DOMAIN fields carrying plain strings on 25+ production log lines
   (twilioSignature.ts:77,143 - under the `webhook_signature_rejected`
   metric-filter line - auth.ts:172, groupCrossCheck.ts x4, api.ts:1326,
   and more; see spec-r1-b B1). Their shapes MUST NOT change. Seven sites
   also log `err: (err as Error).message` (a string) and keep their shape
   for the same reason.
2. Errors and objects get the ALLOWLIST, copying nothing else:
   - `type`: the constructor name (pino's existing field name, kept to
     avoid renaming every error line in CloudWatch), falling back to
     `name` then 'Error'.
   - `message`, `stack`: the error's OWN message and stack (NOT the
     pino-std `messageWithCauses`/`stackWithCauses` concatenations - the
     cause chain is emitted structurally instead, below). This is a stated
     formatting change to existing cause-carrying lines.
   - `code`: string or number, normalized to string (Twilio RestException
     sets numeric codes).
   - `status`: `err.status ?? err.response?.status` (lifted BEFORE
     `response` is dropped - the same two-source lift `summarizeError`
     does, so the two safe shapes agree).
   - `statusCode`: number when present (WebPushError).
   - `moreInfo`: string when present (Twilio's docs URL).
   - `$metadata`: projected to `{ httpStatusCode, requestId, attempts,
     totalRetryDelay }` when present (AWS SDK v3 diagnostics - all
     machine-generated; without this every DynamoDB/S3/SES/SQS failure
     would lose its requestId).
   - `cause`: recursively serialized with the same allowlist, fixed depth
     3; deeper links dropped.
   - `aggregateErrors`: for an AggregateError's `errors`, same treatment,
     capped at 5 entries.
3. The serializer never throws. Any internal failure degrades to
   `{ type: 'UnserializableError' }`.

DROPPED, and stated as the accepted cost: `config`, `request`, `response`
(the credential carriers), Twilio's `details` (vendor free-form), and any
future enumerable an SDK invents. Vendor `message` text can echo a phone
number or an offending parameter - accepted residual, consistent with the
lifted telemetry PII gate (2026-08-15); the credential never rides in
`message`. See section 4 for why structured fields still get masked while
message text does not: a phone in an always-on structured field (URL path,
span attribute) is systematically queryable; a phone inside occasional
vendor prose is incidental. The house rule for call sites: `{ err }` for
diagnostic lines that want stack+message; `summarizeError(err)` for terse
outcome lines that must carry no vendor prose at all. Both are safe for
credentials; they differ only in the message-text posture.

### 1.3 The redact list: extended, with honest limits

The existing redact paths STAY verbatim. After the serializer lands, the
`err.*` vendor paths become unreachable for the wired keys (the serializer
strips those subtrees first) - they are kept anyway as belt-and-suspenders
for any future serializer regression, at zero runtime cost.

ADDED: one-level wildcard variants for the credential carriers -
`*.config.headers.Authorization`, `*.config.headers.authorization`,
`*.config.data`, `*.request._header`, `*.request._headers`,
`*.response.data`, `*.response.config.headers.Authorization`,
`*.response.config.headers.authorization` - so a raw vendor error nested
ONE level deep under any top-level key (`{ ctx: { config... } }` shapes
via `{ ctx: err }`) is censored. HONEST LIMIT, stated plainly: pino
redaction anchors on path segments; a wildcard covers exactly one level,
and deeper smuggling (`{ a: { b: { err } } }`) is covered by NEITHER
serializers NOR redaction. That residual class is closed by the sweep
(section 2) and kept closed by the STATIC guard (section 3), not by
runtime defenses. The spec makes no defense-in-depth claim beyond this.

### 1.4 Interaction notes (verified round 1)

- pino applies `serializers` to top-level merge keys, then redaction on
  the serialized output (`pino/lib/tools.js:173-186`) - the two compose.
- `logger.error(err, 'msg')` wraps the error under `err`
  (`pino/lib/proto.js:221-224`) - covered.
- The dev log ring sits downstream of serialization - e2e logtail
  assertions see the sanitized shape.
- `summarizeError` stays unchanged.

## 2. The sweep (anchor issue, items 1-2)

Audit every `log.*` call whose payload carries an error (the ~331-site
grep universe), and classify:

- VENDOR-REACHABLE under a wired key: now safe. Convert to
  `summarizeError` only where the site wants the terse posture (house
  rule, section 1.2); otherwise leave `{ err }`.
- ERROR UNDER A NON-WIRED KEY or nested deeper than one level (e.g.
  `{ failure: err }`, `{ ctx: { err } }`) or interpolated into `msg`:
  rewire to a top-level wired key. This class is the sweep's primary
  yield; the static guard (section 3) keeps it closed.
- The `{ errName, errMessage }` convention (inboundEmail.ts:377,
  sendEmailMessage.ts:217): normalize to a wired `err`.
- The three pushService string-under-err per-device WARNs
  (pushService.ts:188,219,235): convert to logging the error OBJECT under
  `err` (now safe), which also carries section 6.2.
- DOMAIN-ONLY: leave untouched.

Deliverable: a sweep table in the build report (file, line, class, action),
with the excluded C1 files' rows marked EXCLUDED (verified-safe basis in
section 0).

## 3. Enforcement (anchor issue, item 3)

Two guards, both tests (not eslint - main carries ~117 pre-existing lint
errors and gate 5 is scoped to branch-touched files, so a new repo-wide
lint rule cannot gate):

1. RUNTIME GUARD (`app/test/logSanitization.test.ts`): build a real
   `createLogger` over a capture destination; construct a synthetic
   AxiosError-shaped Error carrying
   `config.headers.Authorization: 'Basic ' + base64('SKfake:secretfake')`,
   `config.data: 'To=%2B15551230000&Body=hello'`, and `request._header`
   with the same fake credential; log it under each wired key and as the
   first-arg form; assert the captured lines contain neither the
   credential sentinel nor the form body. Assert the allowlist (emitted
   keys are a subset; type/message/stack survive; a 2-deep cause chain and
   an AggregateError serialize structurally; `$metadata` projects; a
   primitive under each wired key passes through unchanged). Assert the
   ONE-LEVEL wildcard redact: log `{ ctx: <syntheticAxiosError> }` and
   assert `[REDACTED]` replaces the credential paths.
2. STATIC GUARD (same file or sibling): using the `typescript` package
   (already a devDependency) parse every `app/src/**/*.ts`, find call
   expressions `<obj>.(trace|debug|info|warn|error|fatal)(...)` whose
   first argument is an object literal, and FAIL when an identifier or
   member expression whose name matches /err/i (err, error, sendErr,
   pruneErr, ...) is assigned to any property that is NOT a top-level
   wired key (`err`, `error`, `cause`, `reason`), at any nesting depth.
   An allowlist of reviewed exceptions (file:line) is permitted but starts
   EMPTY after the sweep. This is the check that "fails on a logger call
   whose payload is a bare err" in the anchor issue's words - it sees call
   sites, which the runtime guard cannot.

EXISTING TESTS THAT CHANGE (round-1 finding A-B3):
`app/test/errorSummary.test.ts:107-117` and `:119-141` assert
`[REDACTED]` appears when a raw axios-like error is logged under `err`.
After the serializer, nothing reaches the redactor on that path; both
cases are rewritten to assert the STRONGER property (the credential and
body are ABSENT from the line entirely), keeping their scenario setups.

## 4. Telemetry phone masking (`telemetry-phone-in-url-pii`)

Helper `maskPhonesInText(text: string): string` in `app/src/lib/phone.ts`
(the existing E.164 module - no third masking home): masks E.164-shaped
segments (`+` followed by 8-15 digits, and the URL-encoded `%2B` variant)
to `+1...67` (country code + last two digits). Unit tests per sink shape:
bare paths (`/api/contacts/abc/phones/+14045551234`, `:memberKey` segments
like `phone:+14045551234`), full URLs with query strings (the span case),
multi-phone strings, and no-phone passthrough.

Applied at EVERY sink that writes the raw request path (round-1
enumeration; closing the issue on fewer would be a false close):

- `middleware/requestLogger.ts` - both lines.
- `lib/errors.ts:141,153,160` - the express error handler's three
  `path: req.path` fields (the sink that fires when a phone-bearing route
  throws, at alarm-feeding levels).
- `middleware/rateLimit.ts:113`, `middleware/csrfOrigin.ts:61`,
  `middleware/originSecret.ts:53`,
  `middleware/twilioSignature.ts:44,51,75,110,117,141`.
- `lib/otel.ts` (`buildOtelSdkConfig`): `HttpInstrumentation` gains
  `startIncomingSpanHook` and `startOutgoingSpanHook` returning masked
  overrides for BOTH semconv attribute families - old (`http.url`,
  `http.target`) and stable (`url.full`, `url.path`, `url.query`) - since
  the emitted set depends on `OTEL_SEMCONV_STABILITY_OPT_IN` and hook
  attributes are assigned LAST (verified: instrumentation-http
  `utils.js:346,699`), so they overwrite the instrumentation's own values.
  Both hooks are EXPORTED pure functions unit-tested directly (the
  existing otel tests only check exporter shape and cannot see
  instrumentation config). Hooks are wrapped no-op-safe: a masking failure
  never breaks span export.

Issue close-out: `telemetry-phone-in-url-pii` resolved (all enumerated log
sinks + both span directions). The structural half (phones out of URL
paths) is re-filed as `docs/issues/phone-in-url-paths-structural.md`
(low) with the CORRECT surface list - six routes, not two:
`contacts.ts:2317,:2376` (`:phone`), `relayGroups.ts:467` (`:phone`),
`placements.ts:1084,:1218` and `tours.ts:670,:801` (`:memberKey`, which is
`phone:<E164>` for contact-less members, rosterResolution.ts:317,560).

## 5. Unknown-SID DLR noise (both relay issues)

FINDING (2026-08-24 re-verification; both issues are PARTIALLY STALE):
every production send path whose delivery receipts arrive on the CLASSIC
`/webhooks/twilio/status` webhook now resolves them. The four
`adapter.sendMessage` call sites: relayFanOut fan-out leg (slot +
`putRelaySidPointer`), relayAnnouncements (slot + pointer when
`persist !== false` - intros, member-added, group_closed
(relayGroups.ts:541-551), and group tour reminders all route through it),
voiceApi cell-verification (`putSystemSidMarker`), and the sendMessage
service (persisted message). The webhook already resolves system markers
to an INFO ack (twilio.ts:2438-2447); the retry structure is: second
lookup after ~2.5s, then relay-pointer -> handler, marker -> INFO,
nothing -> ERROR (the "closing the loop" backstop, which STAYS).

BOUNDARY, named so nobody rediscovers it: the native group rail posts via
the Conversations API (`adapters/groupConversations.ts` postGroupMessage,
from `services/groupSend.ts`), whose receipts land on a DIFFERENT webhook
(`twilioConversations.ts`); its `syssid#` markers were DELIBERATELY
dropped (groupReceipts.ts:5-9), and RUNBOOK.md:1781-1814 documents the
latent flood scenario and its own remedy. That is a separate, currently
latent class - explicitly OUT of this mission.

What still ERRORs on the classic webhook, and the fix:

- `persist: false` announcement legs - the dev replay seam
  (`POST /__dev/relay/replay-intros`, its only originator), which skips
  slot AND pointer. Fix: in `relayAnnouncements.ts`, when
  `persist === false`, write `putSystemSidMarker(result.providerSid,
  kind)` for each leg AFTER a successful send, in its OWN try/catch that
  degrades to WARN - a marker failure must never fail the announcement,
  and must never fall into the per-member send catch (which would emit a
  spurious alarm-feeding send-failure ERROR). This mirrors the
  cell-verification precedent (voiceApi.ts:267-271). `kind` is the free
  string the announcement already carries (e.g. 'relay.intro'; the space
  is open by design - tourReminders interpolates `tour.<kind>`).
- Genuine crash-orphans/lost outcomes keep the ERROR and the alarm.

Two costs, chosen deliberately: `putSystemSidMarker` gains an
`expires_at` TTL (30 days; the messages table already has TTL enabled in
deployed envs) applied to BOTH callers - markers are transient by nature
and the dev replay writes one per member per boot, currently forever. Its
per-write INFO (`messagesRepo.ts:2895`) is downgraded to debug so the fix
does not trade N ERRORs for N INFOs; the webhook's per-DLR INFO ack
remains (it is the observable close of the loop).

Verification task for the builder: re-grep for any direct provider SMS/MMS
send that persists neither a message, a pointer, nor a marker - the
expected answer is "none on the classic webhook, Conversations rail
excluded"; prove it in the build report.

Issue close-out: both issues resolved, each noting the stale production
half (announcement persistence closed it in the interim), this change
closing the dev-replay case, and the retained ERROR semantics.

## 6. Push pair

### 6.1 Attempt floor (`push-users-scan-failure-logs-error-per-message`)

`services/pushService.ts` `sendToAll`: add `lastRefreshAttemptAt`
(closure state next to `usersCache`). The refresh is attempted only when
`now() - lastRefreshAttemptAt >= REFRESH_RETRY_FLOOR_MS` (30_000), stamped
on every attempt. Within the floor after a failed attempt: serve the
cached list when inside the stale bound (stale-serve line drops to debug);
otherwise drop the broadcast with a debug line. The first failure in each
window keeps its original WARN/ERROR (the alarm still fires); `fetchedAt`
still never advances on failure; a successful refresh resets naturally.

HONEST BOUND (round-1 finding): the floor is PER INSTANCE.
`createPushService` is constructed ~6 times per process (push.ts, ses.ts,
unmatchedEmail.ts, twilio.ts, voice.ts, worker.ts), so an outage produces
up to ~6 lines per 30s window per process - down from one per inbound
message, which is the issue's actual complaint. Module-hoisting was
REJECTED: it would break the per-test cache isolation every pushService
test gets free from fresh construction. Implementation note: the new
floor-skip branch must early-return like the existing catch arms or the
`usersCache` TS narrowing at :345 breaks. The existing `now` seam
(PushServiceDeps.now) drives the tests; no new seam.

### 6.2 Status surfacing (`push-failure-status-not-surfaced`)

The shared per-device loop's transient-failure WARN (pushService.ts:235
region) currently logs `err: (err as Error).message`. Change (with the
sibling WARNs at :188 and :219, per the sweep): log the error OBJECT under
`err` - the serializer makes it safe and `statusCode` rides the allowlist
automatically - and ALSO lift `statusCode` to a top-level field on the
transient WARN for cheap querying. A 413 (cap regression), 429 (rate
limit), and 5xx (vendor blip) become distinguishable. `SendOutcome` is
unchanged. The issue's note that these lines were frozen by the
inbound-message-push spec is superseded by THIS spec's review.

## 7. Voice push full-identity resolution (`voice-push-pii-masking-outdated`)

Product-behavior rider (operator ruling D4 2026-08-16, re-confirmed
2026-08-24). CURRENT behavior, described accurately (round-1 correction):
the pushes carry the STORED masked `call_party_label` ("Tenant (Jane D.)"
- role + initial-only surname from `maskedCallerLabel`,
voiceMasking.ts:67-74); `pushCallerLabel` (voice.ts:140-143) substitutes
the formatted raw number ONLY for the unknown-caller label. There is no
device gate; `pre_ring` goes to the inbound-line HOLDER, while
`missed_call`/`voicemail` fan out to EVERY admin (resolveFounders). D4's
ruling covers exactly this staff audience: staff-facing pushes carry full
identity like a native phone app; lock-screen privacy is the DEVICE's job.

Design - a new push-time resolution, NOT a deletion of the fallback
(deleting `pushCallerLabel`'s special case alone would REMOVE the one real
number that ships today and deliver strictly less identity):

- New pure helper (voice.ts or voiceMasking.ts, exported for tests):
  `pushCallerIdentity(contact: ContactLike | undefined, phone: string |
  undefined): string` - the contact's FULL name (first + last) when known;
  else `formatPhoneForDisplay(phone)`; else the existing unknown label.
- `pre_ring`: the handler already holds `callerContact` (voice.ts:626
  region) - pass it to the new helper instead of reusing the masked label.
- `missed_call` / `voicemail`: the send sites (voice.ts:2288-2294,
  :2325-2331) hold no contact today. Resolve the caller contact by phone
  at push time (one contactsRepo lookup, best-effort: on lookup failure
  fall back to the formatted number). The STORED `call_party_label`, the
  spoken whisper, thread rendering, and the outbound originate path are
  UNCHANGED - `maskedCallerLabel` keeps all its other consumers.
- `pushCallerLabel` is deleted; comments asserting the masked-push posture
  are rewritten to cite D4.
- LOG posture unchanged: payload contents are still never logged.

Tests that pin the OLD posture and are updated with it (enumerated so the
builder does not rediscover them red):
`app/test/founderTriage.test.ts:174` (title string), `:331-353`
(unknown-caller case - note its "number not in logs" half STAYS),
`:590`, `:769`; `app/test/voiceRecording.test.ts:748-754` (asserts the
payload carries no raw E.164 - that assertion INVERTS under D4 for the
payload while remaining true for log lines). Section 11 carries the
voice-push test work explicitly.

Watch item: no changes to `dashboard/public/sw.js` / `dashboard/src/sw/*`
(payload field names are unchanged; only values). If an edit there ever
looks necessary, stop and reassess (sw-mirror literal-pin trap).

## 8. ai-runs: distinct `unavailable` state (full fix)

`repos/aiRunsRepo.ts`:

- `batchGetRuns` accumulates unprocessed keys ACROSS chunks (today `keys`
  is chunk-local and discarded), strips the `run#` prefix (new inverse of
  `runItemId`), and returns `{ found, unprocessedRunIds: Set<string> }`.
  The once-per-call WARN stays. Note the meaning: unprocessed AFTER four
  backoff attempts - rare, sustained pressure, which is exactly why it
  must not render as "expired".
- `listByEntity` maps each pointer: found -> live entry (unchanged); in
  `unprocessedRunIds` -> `{ runId, sortKey, expired: true,
  unavailable: true }`; otherwise -> `{ runId, sortKey, expired: true }`.

SHAPE RATIONALE (round-1 finding; the naive shapes fail): `expired` is the
union's discriminant and several sites narrow by TRUTHINESS
(routes/aiRuns.ts:183,:196; AiRunList.tsx:54). A variant without `expired`
breaks compilation of every narrowing site and test; `expired: false`
without `run` compiles into the LIVE arm and crashes at runtime. Keeping
`expired: true` + `unavailable: true` means every consumer that is NOT
updated degrades gracefully to today's expired rendering - no crash, no
500 - and the two renderers we DO update check `unavailable` first.

`routes/aiRuns.ts`: the expired arm is a field-by-field reconstruction
(NOT a pass-through - :195-218); add `unavailable` to it. The pre-map
contact-id collection at :183 needs no change (`!entry.expired` still
excludes both non-live variants).

Dashboard: widen the hand-kept wire union in `dashboard/src/api/types.ts`
(:200-201 - it and the server type move together); `AiRunList.tsx` renders
the unavailable case as distinct NON-INTERACTIVE text
("Temporarily unavailable - reload to retry"), checked BEFORE the expired
branch. Deliberately NO per-row button (round-1: a third button breaks
`ai-run-log.spec.ts:213-214`'s one-button-per-row pin and
`AiRunsSection.test.tsx:165`'s singular `Retry` query; and
`useAiRuns.retry()` resets to page 1, so a row-level "retry" promising an
in-place refetch would lie - the reload affordance the page already has is
the honest offer).

Tests: repo unit test forcing UnprocessedKeys exhaustion via a fake doc
client (split + prefix-strip + cross-chunk accumulation); route
serialization test; dashboard component test for the unavailable row.
Files that pin the current union and get updated with it:
`app/test/aiRunsRepo.test.ts:548-550,:609-621`,
`app/test/aiRunsRepo.integration.test.ts:244,:387-410`,
`app/test/aiRunsApi.test.ts:342-345`,
`dashboard/.../AiRunsSection.test.tsx`, `useAiRuns.test.ts`. No new e2e
spec: the unavailable state requires sustained DynamoDB throttling, which
a hermetic lane cannot produce deterministically; there is no new
interactive control; component tests carry the rendering. Perf-contract
citation comments at `e2e/performance/routes.ts:691,:745` are refreshed in
passing (format-checked only, but they rot otherwise).

## 9. Abandoned-journal sweep (decision executed)

Operator decision (2026-08-24): the periodic sweep the issue's "revisit
if" clause contemplates is SANCTIONED, on the existing worker poll loop -
no new infrastructure, no TTL on `ai_extraction`.

STATED PLAINLY, because it is the decision's substance (flagged for the
human spec gate): this sweep is not only a PII scrub. `recoverAbandoned`
drives abandoned journals through `applyJournal`, which COMMITS the
abandoned human decision - contact/phone writes, PERMANENT `dism#`
dismissal tombstones, activity rows, audit rows backdated to the journal's
`claimedAt`, and ai_runs verdict stamps - then scrubs. That is exactly
what already happens today when anyone READS the contact's suggestions
(the lazy hook); the sweep only makes it time-driven instead of
read-driven, so no NEW semantics are introduced - but "complete the
abandoned action" IS the semantics, and the operator should confirm that
knowingly. The stale-write guard (`superseded_by_human_edit`) bounds the
blast radius; the phone-conflict path can end in `release()` (snapshot
re-put) rather than completion - both endings are the machinery's own.

Mechanics (corrected round 1):

- `repos/suggestionResolutionRepo.ts` gains `listActiveResolutionRows()`:
  a paginated table Scan with
  `FilterExpression: begins_with(itemId, :p) AND #state = :active`
  (`state` is a DynamoDB reserved word - alias it, as the repo already
  does elsewhere), returning `{ contactId, target, leaseExpiresAt,
  claimedAt }` from the STORED attributes (contactId/target are
  first-class on the row; no itemId parsing). `claimedAt` is the age
  anchor - it exists only on ACTIVE rows and `takeover` deliberately does
  not refresh it. `leaseExpiresAt`/`claimedAt` are ISO strings; compares
  are Date.parse.
- New worker duty `jobs/journalSweep.ts` via `startPoll('journal sweep',
  ...)`, cadenced ONCE PER DAY through the settings-record claim the
  group-guardrail duties use. NAMED EDIT: `GroupPeriodRecordId` is a
  closed union (settingsRepo.ts:78-82) - it widens by one id (or the
  claim helper generalizes); this is a code edit, not a schema change.
  Like groupGuardrails, the runner takes a `force` bypass and gains an
  app-side dev seam `POST /__dev/journal-sweep/tick` (triple-gated like
  its siblings) - without it the duty is untestable from e2e (worker
  logs never reach the app logtail, A16) and unobservable in a lane.
- Per run: rows qualify when the lease is expired AND
  `now - claimedAt >= JOURNAL_SWEEP_MIN_AGE_MS` (24h). Distinct
  contactIds of qualifying rows are processed under two caps (own
  constants: max contacts per run, max recovery calls per run). Per
  contact: call the EXISTING `recoverAbandoned(contactId)` repeatedly
  while it reports `recovered > 0` and the cap allows. GRANULARITY
  HONESTY: recovery acts per CONTACT and recovers any lease-expired
  journal of that contact regardless of age - identical to what a
  suggestions READ triggers today, so the 24h gate bounds which contacts
  are VISITED, not which journals complete. That is accepted.
- STARVATION/FAILURE HONESTY: `recoverAbandoned` counts successes;
  failures are swallowed inside it (and its internal
  MAX_RECOVERIES_PER_READ = 2 budgets attempts). When a pass over a
  contact ends with `recovered === 0` while the scan says qualifying
  journals remain, the sweep logs WARN with counts (contactId, remaining)
  - the persistent-failure case `ai-run-log-recovery-hook-unbounded.md`
  records - instead of silently reporting a clean run. Counts and ids
  only, never values.
- SSE: when any recovery reports `stateChanged`, emit
  `suggestion.updated` for that contact on the worker bus - the event
  bridge forwards it to app SSE clients exactly as extraction's emits do;
  without it an open dashboard keeps rendering chips the sweep completed.
- COST, honestly: this is the system's first recurring production Scan.
  `ai_extraction` has no TTL and grows monotonically (dism# tombstones,
  due# cursors); `Limit` caps page size (RCU per page), not pages; the
  filter applies after the read. At once per day, cost is proportional to
  table size and accepted. `dynamodb:Scan` is already granted to the
  runtime role (verified round 1) - no infra change.

Issue close-out: `abandoned-journal-pii-until-next-contact-read` resolved,
recording the decision reversal, the commit-the-decision semantics, and
the constants.

## 10. What this mission deliberately does NOT do

- No eslint rule (two guard tests instead - section 3).
- No repo-wide forced conversion to `summarizeError`.
- No changes to the C1 agent's files (verified-safe exclusion, section 0).
- No TTL on `ai_extraction`; no new tables, indexes, or infrastructure.
- No Conversations-rail `syssid#` restoration (separate latent class,
  section 5 boundary).
- No changes to what the SERVER logs about push payloads (section 7
  changes what the push carries, not what is logged).
- No message-catalog entries (log lines + staff dashboard UI only).
- No infra mutations. Post-merge obligations: none expected (code-only;
  the syssid TTL uses the messages table's existing TTL attribute).

## 11. Testing and gates

Unit: serializer (allowlist, primitives pass-through, cause depth,
AggregateError cap, $metadata projection, never-throws), runtime guard,
static guard, errorSummary.test.ts rewrite (section 3), maskPhonesInText,
each masked sink (requestLogger, errors.ts handler, middleware sites),
exported otel hook functions, relayAnnouncements persist:false marker
(success, marker-failure WARN, TTL attribute), putSystemSidMarker TTL,
pushService floor + statusCode + err-object conversion (existing fake
clock), voice pushCallerIdentity + the five enumerated test-site updates,
aiRunsRepo split + route serialization, journal sweep (fake repo/service:
age gate, caps, zero-recovery WARN, SSE emit, cadence claim + force).
Dashboard: AiRunList unavailable-row component test. E2E: no NEW spec
required (no new interactive control; rationale per section). The build
may cheaply extend an existing logtail-based assertion where one already
exercises a touched path.

Gates, bare, from the worktree: `npm run typecheck`, `npm test`,
`npm run smoke`, `npm run e2e`, plus `npx eslint <touched files>`
(gate 5). One main sync at the final pre-handback step.

## 12. Issue-file mutations shipped with the branch

- Resolve with dated stamps: issues 1, 3, 4, 5, 6, 7, 8, 9 (section 0
  table), plus issue 2 with its structural remainder re-filed as
  `docs/issues/phone-in-url-paths-structural.md` (low; six-route surface
  list per section 4).
- `npm run issues` regenerates the gitignored index (run, not committed).
- Inline `TODO(<slug>)` markers for resolved issues updated or removed.
- Comment-citation refreshes: `e2e/performance/routes.ts:691,:745`
  (section 8).
