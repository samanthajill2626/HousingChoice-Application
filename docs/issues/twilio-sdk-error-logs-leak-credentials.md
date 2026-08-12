---
id: twilio-sdk-error-logs-leak-credentials
title: App-wide sweep - log.warn({ err }) on a raw Twilio SDK AxiosError writes a live API credential and the request body to CloudWatch
type: security
severity: high
status: open
area: app
created: 2026-08-11
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
