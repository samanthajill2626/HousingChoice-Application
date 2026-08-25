# Log hygiene: vendor errors, PII, and alarm noise (cluster C3)

Date: 2026-08-24 (v4 after adversarial doc review rounds 1-3)
Status: DRAFT - awaiting round-4 (terminal-cap) review + human review gate
Branch: feat/log-hygiene (worktree W:\tmp\log-hygiene, cut from main @6e707348)
Review artifacts: .superpowers/design-review/ (spec-r1-a.md, spec-r1-b.md,
spec-r2.md, adjudications.md)

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
| 6 | `push-failure-status-not-surfaced` (low) | Section 6: pushStatusCode on the per-device WARN |
| 7 | `voice-push-pii-masking-outdated` (low) | Section 7: message-push naming chain at voice push time |
| 8 | `ai-runs-throttled-batchget-renders-expired` (low) | Section 8: distinct `unavailable` row state |
| 9 | `abandoned-journal-pii-until-next-contact-read` (low, decision) | Section 9: sanctioned worker sweep (operator decision 2026-08-24) |

NOT in scope (cluster doc marks them a separate mission):
`one-off-scripts-missing-account-guard`, `aws-cli-identity-can-diverge-from-account-guard`.
Also out of scope: the Conversations group rail's deliberately-absent
`syssid#` markers (section 5 boundary), and the `{ errName, errMessage }`
email-path convention (section 2 - it is a deliberate PII bound, not
drift).

Concurrent-work exclusion: another agent's C1 mission is editing
`app/src/lib/unreadFeed.ts`, `app/src/routes/inbox.ts`,
`app/src/routes/contacts.ts`, and the conversations/contacts repos in
`W:\tmp\inbox-unread-read-path`. The sweep (section 2) MUST NOT touch those
files. VERIFIED SAFE to exclude (both round-1 reviewers, independently):
every `{ err }` site in those files uses the wired `err` key, so the
section-1 serializer covers them with no residual exposure. Re-audited at
merge reconcile only for NEW sites added by C1.

## 1. Structural fix: safe error serializer (anchor issue)

### 1.1 The problem being closed

pino's default `err` serializer copies every enumerable own key of any
ERROR-LIKE value (anything with a string `message` -
pino-std-serializers `isErrorLike`). An axios-backed vendor error (the
Twilio SDK's network-failure path) carries `config.headers.Authorization`
(a live Basic credential), `config.data` (form body: phones, message
text), and `request._header` (the serialized request head, credential
included). Today's defenses are a path-literal, case-sensitive redact list
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
   undefined, bigint). Load-bearing: `reason` and `error` are live DOMAIN
   fields carrying plain strings on 25+ production lines
   (twilioSignature.ts:77,143 - under the `webhook_signature_rejected`
   metric-filter line - auth.ts:172, groupCrossCheck.ts x4, api.ts:1326,
   more; spec-r1-b B1). Seven sites also log `err: <string>` and keep
   their shape.
2. NON-Error VALUES PASS THROUGH UNCHANGED. Load-bearing for TWO
   deliberate conventions: `{ err: summarizeError(x) }` at 11 sites
   (groupRail/groupSend/groupIdentityFingerprint/groupReceipts/
   twilio.ts) logs a plain `{ name, code?, status? }` object whose only
   identifying field is `name` (spec-r2 B1), and `err: { name: ... }`
   name-only objects at 7 sites (api.ts:1435, relayGroups.ts:378,:387,
   rosterProvision.ts:366,:376,:667,:678) - a FOURTH posture the sweep
   table records as KEPT (spec-r3 M3). The allowlist trigger is
   `instanceof Error` ONLY, not a structural message-check: every member
   of the dangerous class extends Error (AxiosError, RestException, AWS
   ServiceException - spec-r3 M2), the process has one realm, and a
   structural test would silently gut domain objects that happen to
   carry a string `message` (the RunError shape). Backstop asymmetry,
   stated (spec-r3 M4): the literal `err.*` redact paths still censor a
   credential-carrying plain object under `err`; under
   `error`/`cause`/`reason` there is no backstop - accepted, since the
   pass-through branch only receives our own deliberate summary shapes.
3. `instanceof Error` VALUES get the ALLOWLIST, copying nothing else:
   - `type`: constructor name (pino's existing field name), falling back
     to `name` then 'Error'.
   - `message`, `stack`: the error's OWN message and stack (not the
     pino-std `messageWithCauses`/`stackWithCauses` concatenations - the
     cause chain is emitted structurally instead). A stated formatting
     change to existing cause-carrying lines.
   - `code`: string or number, normalized to string.
   - `status`: `err.status ?? err.response?.status` (lifted BEFORE
     `response` is dropped, matching `summarizeError`).
   - `statusCode`: number when present (WebPushError).
   - `moreInfo`: string when present (Twilio docs URL).
   - `$metadata`: projected `{ httpStatusCode, requestId, attempts,
     totalRetryDelay }` (AWS SDK v3 diagnostics, machine-generated).
   - `cause`: recursed to fixed depth 3, WITH ONE RULE CHANGE inside the
     recursion (spec-r3 M1): a nested non-Error value is DROPPED, never
     passed through - the pass-through exists to protect deliberate
     top-level summary objects, and nothing deliberate nests under
     `cause`. (Real chains stay intact: axios sets `cause` to the
     underlying Node error, which is an Error.)
   - `aggregateErrors`: same treatment as `cause`, capped at 5 entries.
4. The serializer never throws; internal failure degrades to
   `{ type: 'UnserializableError' }`.

DROPPED, stated as the accepted cost: `config`, `request`, `response`,
Twilio's `details`, and any future enumerable an SDK invents. Vendor
`message` text can echo a phone or an offending parameter - accepted
residual, consistent with the lifted telemetry PII gate (2026-08-15); the
credential never rides in `message`. Why structured fields still get
masked (section 4) while message text does not: a phone in an always-on
structured field is systematically queryable; a phone inside occasional
vendor prose is incidental. House rule for call sites: `{ err }` for
diagnostic lines (stack + message wanted); `summarizeError(err)` for terse
outcome lines that must carry no vendor prose; the email path's bounded
`errFields` (section 2) is a third, deliberately STRICTER posture and
stays.

### 1.3 The redact list: kept, with honest limits (NO wildcards)

The existing redact paths STAY verbatim. After the serializer lands, the
`err.*` vendor paths are unreachable for wired keys (the serializer
strips those subtrees first); they are kept as belt-and-suspenders for
any future serializer regression, at zero runtime cost (path-literal
stringifiers attach per named top-level key only).

v2 proposed one-level wildcard paths (`*.config.headers.Authorization`
...). WITHDRAWN in v3 (spec-r2 M1 + H4): any `*.` path installs pino's
wildcard stringifier on EVERY top-level field of EVERY line including
`msg`, routing each through slowRedact - a per-field cost on a hot path
this repo already tuned (logger.ts:87-101) - to close a class
(error-under-a-non-wired-key) with ZERO current instances in app/src.
The honest posture, stated plainly: the serializer is the runtime
defense for the wired keys; non-wired/nested smuggling has no runtime
defense and is kept extinct by the sweep (section 2) and the static
guard ratchet (section 3), both of which see call sites.

### 1.4 Interaction notes (verified rounds 1-2)

- pino applies `serializers` to top-level merge keys, then redaction on
  the serialized output - the two compose.
- `logger.error(err, 'msg')` wraps the error under `err` - covered.
- The dev log ring is downstream of serialization - e2e logtail
  assertions see the sanitized shape.
- pino attaches `raw` non-enumerably in its own serializer; ours emits no
  `raw` - no cost.
- `summarizeError` stays unchanged.

## 2. The sweep (anchor issue, items 1-2)

Audit every `log.*` call whose payload carries an error (the ~331-site
grep universe), and classify:

- VENDOR-REACHABLE under a wired key: now safe. Convert to
  `summarizeError` only where the site wants the terse posture; otherwise
  leave `{ err }`.
- ERROR UNDER A NON-WIRED KEY, nested deeper than top level, or
  interpolated into `msg`: rewire to a top-level wired key. EXPECTED
  YIELD: ZERO - round-2 searched for this class and found no instances in
  app/src (spec-r2 H4). The sweep runs as an AUDIT that proves the zero
  and hands the static guard a clean baseline; it is not sized on finding
  members.
- The `{ errName, errMessage }` convention
  (inboundEmail.ts errFields, sendEmailMessage.ts twin; 12 spread sites):
  LEFT ALONE. It is an adjudicated PII hardening (plan F18) bounding a
  mailparser/SES error message to 200 chars because email vendor errors
  can echo addresses/subject/body bytes. Converting it to `{ err }` would
  emit the untruncated message + stack - a PII regression. The sweep
  table marks these sites KEPT-STRICTER. (Reverses v2; spec-r2 B2.)
- The three pushService string-under-err per-device WARNs
  (pushService.ts:188,219,235): convert to logging the error OBJECT under
  `err`, which also carries section 6.2.
- DOMAIN-ONLY: leave untouched.

Deliverable: a sweep table in the build report (file, line, class,
action), with the C1 files marked EXCLUDED (section 0) and the errFields
sites marked KEPT-STRICTER.

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
   keys a subset; type/message/stack survive; 2-deep cause chain and an
   AggregateError serialize structurally; `$metadata` projects; a
   primitive under each wired key passes through unchanged; a
   summarizeError-shaped plain object passes through unchanged).
2. STATIC GUARD (sibling test, modeled on the repo's established
   source-scanning tests - `app/test/tourCopyCallSites.test.ts`,
   `app/test/dynamoKeyLedger.test.ts`): using the `typescript` package
   (a ROOT devDependency, resolved via workspace hoisting) with a
   program over `app/src` built from the repo's real tsconfig (NodeNext
   module resolution): for every call expression
   `<obj>.(trace|debug|info|warn|error|fatal)(...)` whose first argument
   is an object literal, FAIL when a property at any depth is assigned a
   value that is (a) an identifier DECLARED BY A CATCH CLAUSE (an AST
   fact), or (b) of a type assignable to Error, under a property path
   that is not a top-level wired key. The catch-clause test is the
   load-bearing half (spec-r3 B2): under `strict: true` every bare
   `catch (e)` binding is `unknown` - 464 sites, zero annotations - so a
   purely type-based check is VACUOUS (flags nothing, forever), and a
   name-regex check false-positives on domain uses of
   `err.code`/`errorMessage(err)` (spec-r2 H3a). Catch-origin
   identifiers are exactly "an error", regardless of their static type;
   `summarizeError(err)`/`errFields(err)` call results are neither
   catch bindings nor Error-typed, so the domain conventions stay
   unflagged and the exception allowlist genuinely starts EMPTY.
   POSITIVE CONTROL, required (spec-r3 H3): the test compiles a
   known-bad fixture (an in-test source string logging
   `{ ctx: { err } }` from a catch clause) through the same program
   configuration and asserts the guard FLAGS it - so a misconfigured
   ts.Program fails loud instead of passing empty.
   KNOWN LIMITS, stated in the test header per the tourCopyCallSites
   precedent: a payload hoisted into a const and passed as an
   identifier, a spread of a helper's return, a catch variable laundered
   through a local, and an error stringified into `msg` are invisible -
   accepted; the serializer plus the audit baseline carry those, and the
   guard is a ratchet against the common literal form, not a proof.

EXISTING TESTS THAT CHANGE (round-1 A-B3):
`app/test/errorSummary.test.ts:107-117` and `:119-141` assert
`[REDACTED]` appears when a raw axios-like error is logged under `err`.
After the serializer, nothing reaches the redactor on that path; both
cases are rewritten to assert the STRONGER property (credential and body
ABSENT from the line), keeping their scenario setups.

## 4. Telemetry phone masking (`telemetry-phone-in-url-pii`)

Helper `maskPhonesInText(text: string): string` in `app/src/lib/phone.ts`
- with an explicit header note "server-only helper; the dashboard mirror
does NOT gain it" (phone.ts declares byte-parity intent with
dashboard/src/lib/phone.ts; the mirror files have already drifted and no
cross-package test enforces parity, but the note prevents the wrong
instinct - spec-r2 M8). Masks E.164-shaped segments (`+` followed by 8-15
digits, and the URL-encoded `%2B` variant) to `+1...67` (country code +
last two digits). Unit tests per sink shape: bare paths
(`/api/contacts/abc/phones/+14045551234`, `phone:+1...` memberKey
segments) for the log sinks; full URLs with query strings for the span
hooks; multi-phone; no-phone passthrough.

Applied at EVERY sink that writes the raw request path (closing the issue
on fewer would be a false close):

- `middleware/requestLogger.ts` - both lines.
- `lib/errors.ts:141,153,160` - the express error handler's three
  `path: req.path` fields.
- `middleware/rateLimit.ts:113`, `middleware/csrfOrigin.ts:61`,
  `middleware/originSecret.ts:53`,
  `middleware/twilioSignature.ts:44,51,75,110,117,141`.
- `lib/otel.ts` (`buildOtelSdkConfig`): `HttpInstrumentation` gains
  `startIncomingSpanHook` and `startOutgoingSpanHook` returning masked
  overrides. PER-DIRECTION ATTRIBUTE SETS (spec-r2 L1 - the families are
  disjoint): incoming spans override `http.url`, `http.target`,
  `url.path`, `url.query`; outgoing spans override `http.url`,
  `http.target`, `url.full`. Never return an attribute the
  instrumentation does not set for that direction (Object.assign would
  fabricate it). Hook attributes are assigned LAST (verified
  instrumentation-http utils.js:346,699) so they overwrite; nothing
  re-sets url attributes at response time; the server span NAME uses the
  express route template, no phone. Both hooks are EXPORTED pure
  functions unit-tested directly; wrapped no-op-safe.

Issue close-out: `telemetry-phone-in-url-pii` resolved (all enumerated
log sinks + both span directions). The structural half is re-filed as
`docs/issues/phone-in-url-paths-structural.md` (low) with the CORRECT
surface list - six routes: `contacts.ts:2317,:2376` (`:phone`),
`relayGroups.ts:467` (`:phone`), `placements.ts:1084,:1218` and
`tours.ts:670,:801` (`:memberKey` = `phone:<E164>` for contact-less
members).

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
to an INFO ack (twilio.ts:2438-2447); retry structure: second lookup
after ~2.5s, then relay-pointer -> handler, marker -> INFO, nothing ->
ERROR (the "closing the loop" backstop, which STAYS).

BOUNDARY, named so nobody rediscovers it: the native group rail posts via
the Conversations API (`adapters/groupConversations.ts` postGroupMessage,
from `services/groupSend.ts`), whose receipts land on a DIFFERENT webhook
(`twilioConversations.ts`); its `syssid#` markers were DELIBERATELY
dropped (groupReceipts.ts:5-9), and RUNBOOK.md:1781-1814 documents the
latent flood scenario and its own remedy. Separate latent class,
explicitly OUT of this mission.

What still ERRORs on the classic webhook, and the fix:

- `persist: false` announcement legs - the dev replay seam
  (`POST /__dev/relay/replay-intros`, its only originator), which skips
  slot AND pointer. Fix: in `relayAnnouncements.ts`, when
  `persist === false`, write `putSystemSidMarker(result.providerSid,
  kind)` per leg AFTER a successful send, in its OWN try/catch degrading
  to WARN - a marker failure must never fail the announcement, and must
  never fall into the per-member send catch (spurious alarm-feeding
  send-failure ERROR otherwise). Mirrors voiceApi.ts:267-271. `kind` is
  the free string the announcement carries (open value space by design).
- Genuine crash-orphans/lost outcomes keep the ERROR and the alarm.

Marker changes, chosen deliberately:

- `putSystemSidMarker` gains `expires_at` = EPOCH SECONDS (not ISO -
  DynamoDB TTL silently ignores non-numeric attributes; the messages
  table's TTL attribute is `expires_at`, documented as epoch seconds at
  tables.ts:595), now + 30 days, applied to BOTH callers.
- INVARIANT EDIT, named: tables.ts:213-223 enumerates the TTL-bearing
  row families and states each has "its own authoritative consume step -
  TTL is only the backstop". `syssid#` rows have NO consume step
  (getSystemSidMarker reads, never deletes), so the comment gains a
  fourth family with an explicit exception note: syssid# markers are
  read-only acks whose ONLY reaper is TTL, deliberately. Section 12
  lists this comment edit.
- The marker write's per-row INFO (messagesRepo.ts:2895) is downgraded
  to debug so the fix does not trade N ERRORs for N INFOs; the webhook's
  per-DLR INFO ack remains (verified: no test or e2e asserts the marker
  INFO line).

Verification task for the builder: re-grep for any direct provider
SMS/MMS send persisting neither message, pointer, nor marker - expected
answer "none on the classic webhook, Conversations rail excluded"; prove
it in the build report.

Issue close-out: both issues resolved, each noting the stale production
half, this change closing the dev-replay case, and the retained ERROR
semantics.

## 6. Push pair

### 6.1 Attempt floor (`push-users-scan-failure-logs-error-per-message`)

`services/pushService.ts` `sendToAll`: add `lastRefreshAttemptAt`
(closure state next to `usersCache`). Refresh attempted only when
`now() - lastRefreshAttemptAt >= REFRESH_RETRY_FLOOR_MS` (30_000),
stamped on every attempt. Within the floor after a failed attempt: serve
the cached list when inside the stale bound (stale-serve line drops to
debug); otherwise drop the broadcast with a debug line. The first failure
in each window keeps its original WARN/ERROR (alarm fires); `fetchedAt`
never advances on failure; success resets naturally.

HONEST BOUND: the floor is PER INSTANCE (~6 `createPushService` sites per
process), so an outage produces up to ~6 lines per 30s window per process
- down from one per inbound message, the issue's actual complaint.
Module-hoisting REJECTED (breaks per-test cache isolation).
Implementation note: the floor-skip branch must early-return like the
existing catch arms or the `usersCache` TS narrowing at :345 breaks. The
existing `now` seam drives tests.

### 6.2 Status surfacing (`push-failure-status-not-surfaced`)

The shared per-device loop's transient-failure WARN (pushService.ts:235
region) logs `err: (err as Error).message` today. Change (with siblings
:188/:219, per the sweep): log the error OBJECT under `err` (safe;
`statusCode` rides the allowlist automatically), and ALSO lift
`pushStatusCode` to a top-level field on the transient WARN for cheap
querying - named `pushStatusCode`, not `statusCode`, because the request
logger already uses top-level `statusCode` for the HTTP response status
(spec-r2 L2). `SendOutcome` unchanged. The prior spec's freeze on these
lines is superseded by THIS review.

## 7. Voice push identity (`voice-push-pii-masking-outdated`)

Product-behavior rider (operator ruling D4 2026-08-16, re-confirmed
2026-08-24). CURRENT behavior, accurately: pushes carry the STORED masked
`call_party_label` ("Tenant (Jane D.)" - role + initial-only surname from
`maskedCallerLabel`); `pushCallerLabel` (voice.ts:140-143) substitutes
the FORMATTED number only for the unknown-caller label. No device gate
exists; `pre_ring` goes to the inbound-line HOLDER, `missed_call` /
`voicemail` fan out to EVERY admin. D4 covers exactly this staff
audience.

Design: the voice pushes adopt the MESSAGE PUSHES' existing naming chain
(twilio.ts:2284-2290, mirrored :1042-1048) - including its EMPTY-STRING
guard on rung 2 (spec-r3 H2: `??` alone would select a stored empty
string) - plus a TERMINAL rung the message chain does not need
(spec-r3 H1: its terminal `From` is webhook-guaranteed, while here the
phone is `conversation?.participant_phone` and can be undefined; today's
code always yields a non-empty label and this must too):

    contactDisplayName(contact)
      ?? (nonEmptyString(conversation?.participant_display_name))
      ?? formatPhoneForDisplay(phone)
      ?? phone
      ?? UNKNOWN_CALLER_LABEL

- `contactDisplayName` is the EXISTING push-copy helper
  (`app/src/lib/contactName.ts:65`) - imported, never duplicated (its
  header forbids private copies; spec-r2 H2).
- `pre_ring`: the handler already holds `callerContact`
  (voice.ts:574 `contacts.findByPhone(From)`) and the conversation - no
  new reads.
- `missed_call` / `voicemail`: the label-resolution sites
  (voice.ts:2248-2254, :2311-2317) already fetch the conversation
  (:2253, :2316), so rung 2 (`participant_display_name`, the
  denormalized "First Last") is free. Add one best-effort
  `contacts.findByPhone(participant_phone)` for rung 1; on lookup
  failure fall through the chain. (Relay/masked calls cannot reach these
  pushes - gated `masked !== true` - so `participant_phone` is the real
  caller.)
- `pushCallerLabel` is deleted (module-private, three readers, clean);
  comments asserting the masked-push posture are rewritten to cite D4.
- STATED LOSSES, accepted as D4 parity with the message pushes (which
  carry no role word): the role prefix disappears for named contacts
  ("Tenant (Jane D.)" -> "Jane Doe"), and a reviewed-but-nameless
  contact's push shows the number (via rungs 2-4) instead of a bare role
  word - exactly what a message push from that contact shows today.
- The STORED `call_party_label`, spoken whisper, thread rendering, and
  outbound originate path are UNCHANGED - `maskedCallerLabel` keeps all
  its other consumers. LOG posture unchanged: payload contents are never
  logged.

Tests (corrected refs, spec-r2 H7): `app/test/founderTriage.test.ts:174`
(pre-ring BODY string), `:331-353` (unknown-caller pre-ring; its
"number not in LOGS" half stays), `:590`, `:769` (missed-call body) -
updated to the new copy. `app/test/voiceRecording.test.ts:748-754` stays
GREEN as-is (its no-raw-E.164 scan never matched the formatted form) -
do not touch it on this spec's account. NEW REQUIRED TEST: pin the
voicemail push body (no test pins it today).

Watch item: no changes to `dashboard/public/sw.js` / `dashboard/src/sw/*`
(field names unchanged, values only). If an edit there ever looks
necessary, stop and reassess (sw-mirror literal-pin trap).

## 8. ai-runs: distinct `unavailable` state (full fix)

`repos/aiRunsRepo.ts`:

- `batchGetRuns` accumulates unprocessed keys ACROSS chunks (today
  chunk-local, discarded), strips the `run#` prefix (new inverse of
  `runItemId`), returns `{ found, unprocessedRunIds: Set<string> }`. The
  once-per-call WARN stays. Meaning: unprocessed after four backoff
  attempts - rare, sustained pressure.
- `listByEntity` maps: found -> live entry (unchanged); in
  `unprocessedRunIds` -> expired entry with `unavailable: true`;
  otherwise -> expired entry.

SHAPE, exactly (spec-r2 M3 - two separate union members do not typecheck
at the truthiness-narrowed renderers): ONE non-live member with an
OPTIONAL discriminant, on BOTH the server union and the hand-kept wire
duplicate:

    { runId: string; sortKey: string; expired: true; unavailable?: true }

Every consumer that is NOT updated degrades gracefully to today's
expired rendering (no crash, no 500, no compile error); the two updated
renderers check `unavailable` first, which typechecks because the flag
is present-optional on the single non-live member.

`routes/aiRuns.ts`: the expired arm is a field-by-field reconstruction
(:195-218) - add `unavailable` to it. The pre-map contact-id collection
at :183 needs no change.

Dashboard: widen the wire union in `dashboard/src/api/types.ts:242`
(server type and wire duplicate move together); `AiRunList.tsx` renders
the unavailable case as distinct NON-INTERACTIVE text: "Temporarily
unavailable - reload the page to retry" (meaning a BROWSER reload -
stated because the list's Retry button renders only in the error state,
not the ready state this row appears in; spec-r2 M4). Deliberately NO
per-row button (a third button breaks ai-run-log.spec.ts:213-214's
one-button pin and AiRunsSection.test.tsx:165's singular Retry query;
useAiRuns.retry() resets to page 1, so an in-place row retry would lie).

Tests: repo unit test forcing UnprocessedKeys exhaustion via a fake doc
client (split + prefix-strip + cross-chunk accumulation); route
serialization test; dashboard component test for the unavailable row.
Union-pinning files updated with the shape:
`app/test/aiRunsRepo.test.ts:548-550,:609-621`,
`app/test/aiRunsRepo.integration.test.ts:244,:387-410`,
`app/test/aiRunsApi.test.ts:342-345`,
`dashboard/.../AiRunsSection.test.tsx`, `useAiRuns.test.ts`. No new e2e
spec: the state needs sustained DynamoDB throttling a hermetic lane
cannot produce; no new interactive control. Perf-contract citation
comments at `e2e/performance/routes.ts:691,:745` refreshed in passing.

## 9. Abandoned-journal sweep (decision executed)

Operator decision (2026-08-24): the periodic sweep is SANCTIONED, on the
existing worker poll loop - no new tables, no new indexes, no TTL on
`ai_extraction`.

### 9.1 What the operator is approving (the gate paragraph)

This sweep is not only a PII scrub. `recoverAbandoned` drives abandoned
journals through `applyJournal`, which COMMITS the abandoned human
decision - contact/phone writes, PERMANENT `dism#` dismissal tombstones,
activity rows, audit rows backdated to the journal's `claimedAt`, and
ai_runs verdict stamps - then scrubs. Identical semantics to what a READ
of that contact's suggestions triggers today; the sweep makes it
time-driven. Three consequences stated for the approval, not buried:

- The 24h gate bounds which CONTACTS are visited, not which journals
  complete: a journal abandoned 31 seconds ago is committed if its
  contact also carries a 25-hour-old one (recovery filters on lease
  expiry alone). "Nothing under 24h is auto-committed" would be FALSE.
- The phone-conflict ending is `release()`: the journal is deleted and
  the pending suggestion snapshot is RE-PUT - a suggestion chip an
  operator resolved can REAPPEAR on a live dashboard (with the SSE emit,
  in real time, possibly at 3am). Rare, bounded, and the machinery's own
  behavior - but user-visible.
- The backlog drains at the caps' rate: every daily run enumerates ALL
  qualifying journals the same way (there is no first-run special case),
  so a backlog of N contacts commits over ceil(N/25) days, 25 contacts
  per day.

### 9.2 Enumeration - a bounded daily Scan, deliberately NOT an index

DECISION HISTORY, kept because it reversed twice: v2 proposed this Scan;
round 2 (spec-r2 H1) refuted its "no alternative" justification with the
sparse byDueAt idiom and v3 adopted that; a round-3 deep verification of
the byDueAt lifecycle then refuted the ADOPTION on stronger grounds, and
v4 returns to the Scan with the honesty fixes. Why the index loses:

- PII INVERSION: every `ai_extraction` GSI projects ALL (hardcoded in
  the terraform module; tables.ts:60 states it). Indexing `resolve#`
  rows would copy each active journal's FULL PII snapshot and replay
  plan into the index - and the issue being closed records, as its
  accepted-residual SAFETY property, that "no API, GSI or pending list
  can return" these rows. A PII-hygiene mission must not be the change
  that puts journal PII into a GSI.
- LIFECYCLE FRAGILITY, found by verification: legacy rows never enter a
  sparse index without a backfill writer; `takeover()` would need both
  key attributes; `complete()` is a whole-item Put (not a REMOVE edit);
  the backfill's gating signal (cadence-record absence) is destroyed by
  claim-first ordering, by `force`, and by devReset - four independent
  ways to orphan PII permanently.
- Write amplification on every claim/takeover/complete, for a
  once-a-day consumer.

The Scan, with its costs stated: one paginated Scan per day,
`FilterExpression: begins_with(#id, :p) AND #state = :active AND
#claimedAt <= :cutoff` (`state` is reserved - alias it; `:cutoff` is
`new Date(nowMs - 24h).toISOString()`). The filter applies AFTER the
page read, so `Limit` bounds RCU per page, not matches per page; pages
are capped at `MAX_SCAN_PAGES = 20` with `Limit: 200` (up to 4000 rows
examined per run - far above any realistic journal count). Cost is
proportional to TABLE size (dism#/due#/sugg# rows included), not the
working set - accepted at daily cadence; this is the system's first
recurring production Scan and says so here. Every run sees every row,
so nothing is ever orphaned: caps defer work to tomorrow, never strand
it. `dynamodb:Scan` is already granted (verified round 1).

INVARIANT, asserted rather than hedged (round-3 verification):
`claimedAt` is ALWAYS `new Date().toISOString()` in production - its
only writers go through the service's `now()` default, and the
injectable `deps.now` is wired only from test seams. The string compare
above is therefore chronologically correct. The sweep treats an
unparseable `claimedAt` as qualifying (fail-toward-scrub). Note the
attribute name also appears on extraction `due#` rows - harmless, the
`begins_with` filter excludes them.

### 9.3 The duty

- New worker duty `jobs/journalSweep.ts` via `startPoll('journal
  sweep', ...)`, cadenced ONCE PER DAY through the settings-record claim
  the group-guardrail duties use. NAMED EDITS: the settings record-id
  union widens by one id (code edit, not schema); the runner takes a
  `force` bypass and gains `POST /__dev/journal-sweep/tick`
  (triple-gated like its siblings) - without it the duty is untestable
  from e2e (worker logs never reach the app logtail, A16).
- CLAIM-FIRST HONESTY (spec-r2 H5, upheld round 3 - the conditional
  write IS the cross-process dedup, and concurrent sweeps that commit
  domain decisions would be worse than a burned day): the cadence stamp
  lands BEFORE the work and has no release path, so a mid-run failure
  burns the day. Accepted ON CONDITION the failure is loud, and "loud"
  covers MORE than throws (spec-r3 H4): the sweep logs alarm-feeding
  ERROR when (a) its body throws, OR (b) the run ends with work known to
  remain - a cap was hit, the page bound was hit, or the post-loop truth
  check found persistent actives - naming the counts and that the next
  natural retry is tomorrow (or a force tick). NAMED EDIT: reading the
  cadence state needs a read method for period records (the existing
  getGroupTimestamp is typed to the liveness union only) - or the duty
  simply relies on the claim's conditional failure, which needs no read.
- Caps, named: `MAX_CONTACTS_PER_RUN = 25`,
  `MAX_RECOVERY_CALLS_PER_RUN = 100` (the bound that actually governs
  write volume - spec-r3 M5), `JOURNAL_SWEEP_MIN_AGE_MS = 24h`,
  `MAX_SCAN_PAGES = 20`, `SCAN_PAGE_LIMIT = 200`.
- Contact selection: the Scan returns JOURNAL ROWS; contactIds are
  DEDUPLICATED across the run before dispatch (one contact owns up to 12
  journals; without dedup the 25-contact cap is a ~2-contact cap -
  round-3 verification).
- Per contact: call `recoverAbandoned(contactId, { maxAttempts: 12 })` -
  recoverAbandoned gains an OPTIONAL maxAttempts (default 2, preserving
  read-path behavior; 12 = the closed DECISION_TARGETS key set) so a
  poison pair of persistently-failing journals cannot starve the other
  ten (spec-r2 H6). Loop while `recovered > 0` and the run caps allow;
  OR `stateChanged` across ALL calls (the terminating call always
  reports false - spec-r2 M7) and emit `suggestion.updated` for the
  contact when the OR is true (real registered event; the event bridge
  forwards to app SSE in all deployed/lane environments).
- POST-LOOP TRUTH CHECK (spec-r2 B3 - the v2 WARN fired on every
  contact): after the loop, re-read the contact's journals via the
  existing `listJournals(contactId)` (one consistent BatchGet over the
  closed 12-key set) and WARN with counts ONLY when a row is still
  active, lease-expired, and past the age gate - the genuine
  persistent-failure signal. Counts and ids only, never values.
- Logging: per-run summary INFO (contacts visited, recovered, WARNs);
  the per-journal failure WARN inside recoverAbandoned already exists.

Issue close-out: `abandoned-journal-pii-until-next-contact-read`
resolved, recording the decision reversal, the commit-the-decision
semantics (9.1), and the constants.

## 10. What this mission deliberately does NOT do

- No eslint rule (two guard tests - section 3).
- No wildcard redact paths (withdrawn v3 - section 1.3).
- No repo-wide forced conversion to `summarizeError`; no conversion of
  the email path's bounded errFields convention.
- No changes to the C1 agent's files (verified-safe exclusion,
  section 0).
- No TTL on `ai_extraction`; no new tables or indexes, and NO journal
  attributes written into any existing index (the projection-ALL PII
  inversion - section 9.2). The daily bounded Scan is the accepted cost
  of that line.
- No Conversations-rail `syssid#` restoration (section 5 boundary).
- No changes to what the SERVER logs about push payloads (section 7
  changes what the push carries, not what is logged).
- No message-catalog entries (log lines + staff dashboard UI only).
- No infra mutations. Post-merge obligations: none expected.

## 11. Testing and gates

Unit: serializer (allowlist, primitives + non-error-like objects pass
through, cause depth, AggregateError cap, $metadata projection,
never-throws), runtime guard, static guard (+ its known-limits header),
errorSummary.test.ts rewrite, maskPhonesInText, each masked sink,
exported per-direction otel hooks, relayAnnouncements persist:false
marker (success, marker-failure WARN, epoch-seconds TTL value),
putSystemSidMarker TTL for both callers, pushService floor +
pushStatusCode + err-object conversion, voice identity chain (all five
rungs including the empty-string guard and the terminal fallback; the
enumerated founderTriage updates; NEW voicemail push body pin),
aiRunsRepo split + route serialization + optional-discriminant shape
(house `!== undefined` spread form), journal sweep (fake repo/service:
scan paging + filter, contact dedup, age gate + unparseable-claimedAt
fail-toward-scrub, all five caps, maxAttempts pass-through, post-loop
truth check, OR'd SSE emit, cadence claim + force, loud-failure ERROR
including the work-remaining non-throw case). The static guard's
positive-control canary is part of its own test.
Dashboard: AiRunList unavailable-row component test. E2E: no NEW spec
required (no new interactive control; rationale per section); the build
may cheaply extend an existing logtail-based assertion where one already
exercises a touched path.

Gates, bare, from the worktree: `npm run typecheck`, `npm test`,
`npm run smoke`, `npm run e2e`, plus `npx eslint <touched files>`
(gate 5). One main sync at the final pre-handback step.

## 12. Issue-file mutations shipped with the branch

- Resolve with dated stamps: issues 1, 3, 4, 5, 6, 7, 8, 9 (section 0
  table), plus issue 2 with its structural remainder re-filed as
  `docs/issues/phone-in-url-paths-structural.md` (low; six-route list).
- `npm run issues` regenerates the gitignored index (run, not
  committed).
- Inline `TODO(<slug>)` markers for resolved issues updated or removed.
- Comment edits shipped with their code: tables.ts:213-223 TTL-family
  enumeration (+ syssid# exception), phone.ts server-only masking note,
  `e2e/performance/routes.ts:691,:745` citation refresh.
- One line added to the open
  `docs/issues/consolidate-contact-display-name-helpers.md`: the voice
  pushes become a second push-copy consumer of `contactDisplayName`.
