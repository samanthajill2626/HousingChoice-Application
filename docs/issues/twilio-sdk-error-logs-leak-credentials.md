---
id: twilio-sdk-error-logs-leak-credentials
title: App-wide sweep - log.warn({ err }) on a raw Twilio SDK AxiosError writes a live API credential and the request body to CloudWatch
type: security
severity: high
status: resolved
area: app
created: 2026-08-11
resolved: 2026-08-25
refs: app/src/adapters/messaging.ts:607, app/src/lib/logger.ts:150, app/src/lib/errors.ts:79, app/src/services/groupRail.ts:328, app/src/services/groupSend.ts:317
---

**Problem.** Logging a raw error from the Twilio SDK serializes the whole
`AxiosError`, and an `AxiosError` carries the outbound request on `err.config` -
including `config.headers.Authorization` (the string `Basic ` + base64 of
`apiKeySid:apiKeySecret`, a LIVE Twilio API credential) and `config.data` (the
form-encoded request body: phone numbers, message text). Nothing in our logging
stops it.

The chain, verified by reading the vendored sources under `node_modules` rather
than by running anything:

1. `twilio/lib/base/RequestClient.js:167-187` sets
   `headers.Authorization = "Basic " + base64(apiKeySid:apiKeySecret)` and
   `options.data = qs.stringify(...)`. Its `validateStatus` accepts 100-599, so
   HTTP errors do not throw - but line 222's `.catch(error => { throw error })`
   rethrows NETWORK errors (ECONNRESET / ETIMEDOUT / socket hang up) as a raw
   `AxiosError`.
2. `axios/dist/node/axios.cjs:1396` sets `this.config = config` as an own
   ENUMERABLE property.
3. pino's default `err` serializer
   (`pino-std-serializers/lib/err.js:29-39`) copies every enumerable key, so
   `config` lands in the log line whole.
4. `app/src/lib/logger.ts:150-161` redacts eight literal paths -
   `headers.authorization`, `req.headers.authorization`, plus
   cookie / x-origin-verify / x-bridge-token. `err.config.headers.Authorization`
   matches NONE of them: it is a different path, AND pino's `redact` is
   case-sensitive, so even a same-shaped path spelled `authorization` would miss
   the SDK's capitalized header name.

Net: one Twilio network blip is enough to write a live API credential plus the
request payload to CloudWatch, where retention is long and access is broader than
the secret store's.

**Scope of THIS issue.** This is a PRE-EXISTING, repo-wide pattern, not something
one feature introduced - `app/src/adapters/messaging.ts:607-623` has the identical
`throw err` on the 1:1 send path on `main`, and `app/src/lib/errors.ts:79-81`
logs `{ err: toError(err) }` where `toError` passes Errors through untouched, so
any rethrown `AxiosError` reaching the express error handler prints the same
payload.

The `feat/group-texting` branch closed its OWN three call sites
(`groupRail.ts:328, :350, :398` now log a sanitized summary - name, code, status
- and `groupSend.ts:317` wraps the `AxiosError` into a domain error carrying no
`config`) and added redact paths for `err.config.headers.Authorization` /
`err.config.headers.authorization` / `err.config.data`. Those redact paths are
the app-wide backstop and they landed with that branch.

What is left, and what this issue tracks, is the SWEEP: auditing every other
`log.*({ err })` (or `{ err: <something unsanitized> }`) call site that can
receive a vendor SDK error, and giving each one the same sanitized-summary
treatment, so that correctness does not rest solely on a redact list that has
already been shown to be easy to miss with.

**Suggested fix.**

1. Enumerate the call sites: grep for `{ err` / `err:` passed to a logger across
   `app/src`, and intersect with the paths that can receive an error thrown by a
   vendor SDK (Twilio, AWS SDK clients, SES, any HTTP client). `messaging.ts:607`
   and `errors.ts:79` are the two known anchors.
2. Convert each to log a SANITIZED summary (`name`, `code`, `status`, plus our
   own correlation ids) instead of the raw error object. A helper - one
   `summarizeVendorError(err)` in a shared lib - keeps this from drifting again.
3. Make it enforceable rather than a one-time cleanup: an eslint rule or a guard
   test that fails on a logger call whose payload is a bare `err`, so the next
   new call site cannot reintroduce it.
4. Keep the redact paths regardless. They are the backstop for whatever the sweep
   misses, but they must not be the only defense: they are path-literal and
   case-sensitive, and a vendor renaming a header silently defeats them.

Do NOT close this by only re-checking the group-texting call sites - those are
already done. The value here is entirely in the sites nobody has looked at.

**Resolution (2026-08-25).** Closed structurally on `feat/log-hygiene`, not by
call-site discipline. `app/src/lib/logSerializers.ts` exports
`serializeLoggedError`, which `createLogger` binds to the four error-carrying
keys named by `LOG_SERIALIZER_KEYS` (`err`, `error`, `cause`, `reason`). An
`instanceof Error` value now emits an ALLOWLIST and nothing else - `type`,
`message`, `stack`, `code`, `status`, `statusCode`, `moreInfo`, a four-field
`$metadata` projection, an Error `cause` recursed to depth 3, and at most five
`aggregateErrors`. `config`, `request` and `response` have no path onto the
line, so an `AxiosError` cannot carry `config.headers.Authorization` or
`config.data` into CloudWatch even from a brand-new call site. `status` is
lifted from `err.status` or `err.response.status` BEFORE `response` is dropped,
so the diagnostic that mattered survives. `type` prefers the DECLARED `err.name`
when it is present and not the generic 'Error', else the constructor name, so
vendor classes stay identifiable. The serializer never throws; a hostile getter
degrades the value to `{ type: 'UnserializableError' }`.

Deliberately NOT a blanket sanitizer: primitives and non-Error objects pass
through UNCHANGED. `reason` and `error` are live domain string fields on 25+
production lines, and `{ err: summarizeError(x) }` (11 sites) plus
`err: { name }` (7 sites) are deliberate summary shapes whose fields must keep
reaching the line. Every member of the dangerous class extends Error, so
`instanceof Error` is the allowlist trigger rather than a structural
message-check, which would have gutted domain objects carrying a `message`. The
redact list of item 4 is KEPT verbatim as the belt-and-suspenders backstop.

Item 3 (enforceability) shipped as two guards rather than the eslint rule the
issue suggested. (1) A runtime credential probe,
`app/test/logSanitization.test.ts`: a real `createLogger` over a capture stream
fed a synthetic AxiosError-shaped Error carrying a clearly-FAKE credential
sentinel, once per wired key and once in the first-arg
`logger.warn(err, msg)` form, asserting the sentinel and the body digits are
absent AND that `[REDACTED]` does not appear - absent, not censored, which is
what makes the probe discriminating on `err`. (2) A static AST guard,
`app/test/logCallSiteGuard.test.ts`: it compiles `app/src` with the real
`app/tsconfig.json` and fails when an identifier DECLARED BY A CATCH CLAUSE (or
any Error-typed value) is assigned to a logger-call property that is not a
top-level wired key. Its allowlist starts and remains EMPTY; a virtual canary
overlaid into the real program is the positive control, and a health case
asserts >50 source files and zero TS2307 diagnostics so a misconfigured program
cannot scan an empty world and pass.

The sweep item 1 asked for was done and classified: 334 grep hits across
`app/src` - 235 WIRED-OK, 38 non-payload matches (parameter types, catch
bindings, comment prose), 32 in the five files excluded by the concurrent C1
mission (all already the wired `{ err }` shape), 23 KEPT-SUMMARY, 2
KEPT-STRICTER, 4 CONVERTED. The four conversions are the `pushService.ts`
per-device WARNs, which now log the error OBJECT under `err` instead of
`(err as Error).message` (see
[push-failure-status-not-surfaced](./push-failure-status-not-surfaced.md)).

Residuals, named rather than implied:

- Vendor MESSAGE TEXT is an accepted residual. `message` and `stack` ride the
  allowlist by design, and a vendor is free to put anything in them.
- NESTED smuggling under a non-wired key has no runtime defense. The serializer
  only sees the four wired keys, and the static guard is a ratchet against the
  common literal form, not a proof: a payload hoisted into a const, a spread of
  a helper's return, a catch variable laundered through a local, and an error
  stringified into the message argument are all invisible to it. That territory
  is covered by the guard plus the sweep baseline, and by nothing else.
- Three other `err: (x as Error).message` sites remain unconverted -
  `routes/auth.ts:311`, `services/systemStatus.ts:204` and `:258`. A string
  under a wired key can carry no vendor object, so this is a posture choice, not
  a leak; recorded so a later pass can revisit it deliberately.
- The email path's `errFields` convention (`services/inboundEmail.ts`,
  `services/sendEmailMessage.ts`: 2 helper definitions + 11 spread call sites)
  was deliberately NOT converted - it is a stricter 200-char PII bound, not
  drift.
- The `summarizeVendorError(err)` helper item 2 proposed was not written. The
  serializer supersedes it: correctness no longer depends on any call site
  choosing the right helper.
- WHAT "CLOSED" MEANS, precisely (phase-6 adversarial review): the CREDENTIAL
  class is closed structurally - config/request/response and every future
  enumerable an SDK invents cannot serialize through a wired key. The
  serializer deliberately KEEPS `message` and `stack` (operator-approved spec
  residual, 1.2): vendor error prose can and does name phone numbers (Twilio
  21211 echoes the To number), so `{ err }` lines on send paths still carry
  phone PII in `err.message` - accepted under the lifted 2026-08-15 telemetry
  PII gate, and the reason `summarizeError` (which drops message) remains the
  right choice for terse outcome lines. A future stricter posture would mask
  E.164s inside the serializer's message/stack fields; nothing structural
  prevents that.
