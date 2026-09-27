# Spike: twilio-node 6.0.2 against the planned fake-twilio routes (SOR Stage 1 build research)

- Date: 2026-09-26. Branch `feat/send-outcome-reconcile` @1280058f (plan revision 4, spec revision 11).
- Gates: plan Tasks 1, 4, 11 and 12 (spec D1, D2, D8a's TTL, D17, D19).
- A THROWAWAY spike run by a build-research sub-agent (opus). Nothing in the worktree was changed except this record.
- Spike source and the full raw output live in the session scratchpad (NOT tracked):
  `C:\Users\Cameron\AppData\Local\Temp\claude\W--AI-Projects-Housing-Choice-HC-Application\98d714e5-2c92-4c2f-84c1-df34cdcf9a3a\scratchpad\spike-sor-twilio\spike.mts`
  and `spike-output.txt` beside it. Every line of that output is reproduced verbatim below, split by question.
- Line citations into `node_modules` are the worktree's install (`W:\tmp\send-outcome-reconcile\node_modules`): twilio 6.0.2, and axios 1.18.0 (the copy twilio resolves; twilio has no nested axios).

## Verdict

| # | Question | Verdict |
|---|---|---|
| 1 | `messages.page` / `messages.getPage` through the redirecting client: instances, order, `nextPageUrl`, `page_size`, field runtime types | **PASS** |
| 2 | `messages(sid).fetch()`: fields; an unknown SID -> the thrown error's shape | **PASS** |
| 3 | create against `reject` (400 / 21211) -> error shape | **PASS** |
| 4 | create against `drop_before_create` and `accept_then_drop` -> error shape; any retry | **PASS** - one POST each, no retry anywhere |
| 5 | the pinned request timeout reaches BOTH the production client and the lane's redirecting client | **FAIL as the plan is written** - `timeout` passed to `twilio(...)` never reaches a passed `httpClient`; the fix is proven empirically (Task 4 amendment below) |
| 6 | plan Task 1 Step 3 `classifySendFailure`, verbatim, on the REAL error objects | **PASS** - reject -> `rejected`; both drops and every timeout -> `unknown` |

**Overall: PASS WITH ONE REQUIRED AMENDMENT (Task 4).** D1, D2, D17 and D19 hold against the real SDK driven
the way the lane drives it; Tasks 1, 11 and 12 need no design change, only the concrete fake-route rules
below. Task 4's instruction ("`twilio(sid, secret, { accountSid, timeout: TWILIO_REQUEST_TIMEOUT_MS, ...httpClient })`")
pins the timeout for PRODUCTION only. On the lane the effective timeout equals `SEND_CLAIM_TTL_MS` today
solely because two independent 30000 literals happen to agree (the SDK's `DEFAULT_TIMEOUT` and
`SEND_CLAIM_TTL_MS`); change either and the lane silently diverges. Task 4 must also thread the timeout
into `createRedirectingHttpClient` (exact instruction below).

## Method

- ONE Node process (node v24.14.1): an Express 5.2.1 mock on `127.0.0.1:47813` plus the client. The mock
  implements plan Task 11 "Interfaces (produced)" as written: list `GET .../Messages.json` answering 200
  `{ messages, next_page_uri (a PATH built with URLSearchParams, or null), page, page_size, first_page_uri,
  previous_page_uri, uri, start, end }` newest first with `PageToken` = integer offset; fetch
  `GET .../Messages/:sid.json` answering the resource or `404 { code: 20404, message, more_info, status: 404 }`;
  resources `sid, status, to, from, body, num_media (string), error_code (int or null), date_created (RFC 2822),
  date_sent (RFC 2822 or null), messaging_service_sid, direction: 'outbound-api'`; create modes `normal` (201),
  `reject` (`400 { code: 21211, message: 'fail-next-send: rejected by the fake', more_info, status: 400 }`),
  `drop_before_create` (`req.socket.destroy()` in the handler, nothing recorded), `accept_then_drop` (recorded,
  then `req.socket.destroy()`), plus a `stall` mode (accepted, never answered) for Q5; and the `fail-list`
  500 `{ code: 20500, ... }` for list and fetch.
- The client is the REAL `TwilioMessagingDriver` imported from the worktree's `app/src/adapters/messaging.ts`,
  constructed with `apiBaseUrl` so its own constructor (`messaging.ts:628-635`) builds
  `twilio(apiKeySid, apiKeySecret, { accountSid, httpClient: createRedirectingHttpClient({ baseUrl }) })` with
  the REAL `createRedirectingHttpClient` (`app/src/adapters/twilioHttpClient.ts`). Creates went through
  `driver.sendMessage` (whose catch rethrows the raw SDK error unchanged, `messaging.ts:692-708`); list and
  fetch went through the driver's own SDK client instance (`driver.client`), because the port methods do not
  exist yet. Credentials: API key SID `SK...` + secret with `accountSid: 'AC...'`; the mock saw the Basic auth
  user `SK...` on every request.
- Q5 built three extra clients (see Q5). Q6 ran the plan's Task 1 Step 3 block verbatim; the only change is
  its one import line, replaced by plan Task 1 Step 1's leaf class body verbatim (the leaf does not exist yet).
- Three probes beyond the brief, because they decide Task 11 rules: Q1b (a `next_page_uri` with a raw `+`),
  Q2b (a resource with its date fields omitted), Q2c (the fail-list 500 on list and fetch).
- Teardown: the mock was closed in-process and the process exited (PID 52500 confirmed gone; no LISTENING
  socket left on 47813, only kernel TIME_WAIT entries). `git status` of the worktree was empty before and after
  the run.

## Q1 - list one page, then the next (PASS)

Observed:
- `client.messages.page({ to, from, pageSize: 2 })` resolves a `MessagePage` whose `instances` are 2
  `MessageInstance`s in the order the fake served them (newest first: `three`, `two`).
- `nextPageUrl`, exact: `https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages.json?To=%2B16175550100&From=%2B15550009999&PageSize=2&Page=1&PageToken=2`.
  The SDK prefixes the fake's PATH with the real API origin (`twilio/lib/base/Page.js:51-60`, via
  `Domain.absoluteUrl`). `getPage(nextPageUrl)` then went through the redirecting client, which rewrote only
  the origin; the mock received the path and query verbatim and parsed `To` as `+16175550100`.
- `page._payload.page_size` is a number (2), on both pages.
- Page 2: one instance (`one`); its `nextPageUrl` is `undefined` (a `next_page_uri: null` maps to `undefined`,
  never `null`).
- Instance runtime types (camelCase keys only; the snake_case names do not exist on an instance):
  `sid`, `status`, `to`, `from`, `body`, `direction`, `messagingServiceSid`: string. `numMedia`: STRING `'0'`
  (passed through, not converted - `message.js:195`). `errorCode`: `null` when the payload has `null`, a number
  when it has an int (`message.js:201`). `dateCreated`: `Date`. `dateSent`: `null` when the payload has `null`,
  a `Date` when set (`message.js:199-200`). `dateUpdated`: a `Date` equal to NOW when the payload omits it
  (fabricated - see Q2b; the app never reads it).
- Both RFC 2822 spellings parse to a valid `Date`: the seeds alternated `toUTCString()` (`... GMT`) and Twilio's
  `... +0000`. Precision is whole seconds (`...:44.000Z` for a message stored at `...:44.7xx`).

```text
===== Q1 messages.page + getPage =====
seed create 'one' via driver.sendMessage: {"providerSid":"SM00000000000000000000000000000001","status":"queued","providerTs":"2026-09-27T03:07:44.000Z","actualTransport":"sms"}
seed create 'two' via driver.sendMessage: {"providerSid":"SM00000000000000000000000000000002","status":"queued","providerTs":"2026-09-27T03:07:44.000Z","actualTransport":"sms"}
seed create 'three' via driver.sendMessage: {"providerSid":"SM00000000000000000000000000000003","status":"queued","providerTs":"2026-09-27T03:07:44.000Z","actualTransport":"sms"}
p1 ctor: MessagePage
p1.instances.length: 2
p1 bodies in order: ["three","two"]
p1 sids in order: ["SM00000000000000000000000000000003","SM00000000000000000000000000000002"]
p1.nextPageUrl (exact): string("https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages.json?To=%2B16175550100&From=%2B15550009999&PageSize=2&Page=1&PageToken=2")
p1.previousPageUrl: undefined
p1._payload.page_size: number(2)
p1 instance[0] own non-underscore keys: ["body","numSegments","direction","from","to","dateUpdated","price","errorMessage","uri","accountSid","numMedia","status","messagingServiceSid","sid","dateSent","dateCreated","errorCode","priceUnit","apiVersion","subresourceUris"]
p1 instance[0] fields: {"sid":"string(\"SM00000000000000000000000000000003\")","status":"string(\"queued\")","to":"string(\"+16175550100\")","from":"string(\"+15550009999\")","body":"string(\"three\")","numMedia":"string(\"0\")","errorCode":"null","dateCreated":"Date(2026-09-27T03:07:44.000Z)","dateSent":"null","dateUpdated":"Date(2026-09-27T03:07:44.775Z)","direction":"string(\"outbound-api\")","messagingServiceSid":"string(\"MGcccccccccccccccccccccccccccccccc\")"}
p1 instance[1] fields: {"sid":"string(\"SM00000000000000000000000000000002\")","status":"string(\"queued\")","to":"string(\"+16175550100\")","from":"string(\"+15550009999\")","body":"string(\"two\")","numMedia":"string(\"0\")","errorCode":"null","dateCreated":"Date(2026-09-27T03:07:44.000Z)","dateSent":"null","dateUpdated":"Date(2026-09-27T03:07:44.775Z)","direction":"string(\"outbound-api\")","messagingServiceSid":"string(\"MGcccccccccccccccccccccccccccccccc\")"}
p2.instances.length: 1
p2 bodies in order: ["one"]
p2.nextPageUrl: undefined
p2._payload.page_size: number(2)
mock received for p1/p2: [{"method":"GET","url":"/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages.json?To=%2B16175550100&From=%2B15550009999&PageSize=2","authUser":"SKbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","parsedTo":"+16175550100"},{"method":"GET","url":"/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages.json?To=%2B16175550100&From=%2B15550009999&PageSize=2&Page=1&PageToken=2","authUser":"SKbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","parsedTo":"+16175550100"}]
```

### Q1b - probe: a `next_page_uri` whose `+` is NOT percent-encoded (a proven trap)

The SDK passes the path through untouched, and Express decodes a raw `+` as a space, so page 2 filters on
`To = " 16175550100"` and comes back EMPTY with no error - which a reconcile would read as "not found".

```text
===== Q1b trap probe: next_page_uri with a RAW + in To (not percent-encoded) =====
t1.nextPageUrl: string("https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages.json?To=+16175550100&From=+15550009999&PageSize=2&Page=1&PageToken=2")
t2.instances.length (expected 1 if the To survived): 0
mock received for t1/t2 (parsedTo = what Express decoded): [{"method":"GET","url":"/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages.json?To=%2B16175550100&From=%2B15550009999&PageSize=2","authUser":"SKbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","parsedTo":"+16175550100"},{"method":"GET","url":"/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages.json?To=+16175550100&From=+15550009999&PageSize=2&Page=1&PageToken=2","authUser":"SKbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","parsedTo":" 16175550100"}]
```

## Q2 - fetch by SID (PASS)

Observed:
- `client.messages(sid).fetch()` resolves a `MessageInstance` with the same field types as a list instance
  (`errorCode` number 30003 for `error_code: 30003`; `dateSent` a `Date` when set, `null` when `null`).
- Unknown SID: constructor `RestException` (`instanceof` the SDK's `RestException`: true; NOT an AxiosError),
  `.name` `'Error'` (the class never sets it), `.status` number `404`, `.code` number `20404`, `.message` = the
  body's `message` verbatim, `.moreInfo` = the body's `more_info`, `.details` undefined. Own keys:
  `status, code, moreInfo, details`.
- The plan's `getMessage` mapping (`e.status === 404 || Number(e.code) === 20404` -> `undefined`) matches this
  object on both fields.

```text
===== Q2 messages(sid).fetch =====
fetch(two: undelivered, error_code 30003, date_sent set) ctor: MessageInstance
fetch(two) fields: {"sid":"string(\"SM00000000000000000000000000000002\")","status":"string(\"undelivered\")","to":"string(\"+16175550100\")","from":"string(\"+15550009999\")","body":"string(\"two\")","numMedia":"string(\"0\")","errorCode":"number(30003)","dateCreated":"Date(2026-09-27T03:07:44.000Z)","dateSent":"Date(2026-09-27T03:07:46.000Z)","dateUpdated":"Date(2026-09-27T03:07:44.782Z)","direction":"string(\"outbound-api\")","messagingServiceSid":"string(\"MGcccccccccccccccccccccccccccccccc\")"}
fetch(three: queued, error_code null, date_sent null) fields: {"sid":"string(\"SM00000000000000000000000000000003\")","status":"string(\"queued\")","to":"string(\"+16175550100\")","from":"string(\"+15550009999\")","body":"string(\"three\")","numMedia":"string(\"0\")","errorCode":"null","dateCreated":"Date(2026-09-27T03:07:44.000Z)","dateSent":"null","dateUpdated":"Date(2026-09-27T03:07:44.784Z)","direction":"string(\"outbound-api\")","messagingServiceSid":"string(\"MGcccccccccccccccccccccccccccccccc\")"}
fetch unknown SID -> error: {"ctor":"RestException","name":"Error","message":"The requested resource /2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages/SMffffffffffffffffffffffffffffffff.json was not found","code":"number(20404)","status":"number(404)","moreInfo":"https://www.twilio.com/docs/errors/20404","details":"undefined","errno":"undefined","syscall":"undefined","isAxiosError":"undefined","hasResponse":false,"instanceofRestException":true,"instanceofAxiosError":false,"ownKeys":["status","code","moreInfo","details"]}
```

### Q2b - probe: a resource with `date_created`, `date_sent`, `error_code`, `num_media` OMITTED (a proven trap)

`deserialize.rfc2822DateTime(undefined)` is `dayjs.utc(undefined, ...)`, which is NOW
(`twilio/lib/base/deserialize.js:41-42,63`). An omitted `date_sent` therefore arrives as a `Date` equal to the
fetch time (the plan's `summarize` would report a fabricated `sentAt`), and an omitted `date_created`
fabricates `createdAt` = now (which would put any message inside the reconcile window). An omitted
`error_code` / `num_media` arrive as `undefined` (harmless to `summarize`).

```text
===== Q2b trap probe: resource with date_created / date_sent / error_code / num_media OMITTED =====
fetched at (wall clock): 2026-09-27T03:07:44.786Z
fetch(omit probe) fields: {"sid":"string(\"SMeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\")","status":"string(\"queued\")","to":"string(\"+16175550100\")","from":"string(\"+15550009999\")","body":"string(\"omit probe\")","numMedia":"undefined","errorCode":"undefined","dateCreated":"Date(2026-09-27T03:07:44.787Z)","dateSent":"Date(2026-09-27T03:07:44.787Z)","dateUpdated":"Date(2026-09-27T03:07:44.787Z)","direction":"string(\"outbound-api\")","messagingServiceSid":"undefined"}
```

### Q2c - the fail-list 500 on list and on fetch

Both paths throw `RestException`, `.status` 500, `.code` 20500, `.message` = the body's message (the list path
throws from `Page.processResponse`, `Page.js:133-134`; the fetch path from `Version.throwException`,
`Version.js:46-50`). The seam is consumed per call and the next list succeeds.

```text
===== Q2c fail-list 500 on list and on fetch =====
list under fail-list -> error: {"ctor":"RestException","name":"Error","message":"fail-list: provider unavailable","code":"number(20500)","status":"number(500)","moreInfo":"https://www.twilio.com/docs/errors/20500","details":"undefined","errno":"undefined","syscall":"undefined","isAxiosError":"undefined","hasResponse":false,"instanceofRestException":true,"instanceofAxiosError":false,"ownKeys":["status","code","moreInfo","details"]}
fetch under fail-list -> error: {"ctor":"RestException","name":"Error","message":"fail-list: provider unavailable","code":"number(20500)","status":"number(500)","moreInfo":"https://www.twilio.com/docs/errors/20500","details":"undefined","errno":"undefined","syscall":"undefined","isAxiosError":"undefined","hasResponse":false,"instanceofRestException":true,"instanceofAxiosError":false,"ownKeys":["status","code","moreInfo","details"]}
list after fail-list consumed -> instances: 2
```

## Q3 - create against `reject` (PASS)

`RestException`, `.name` `'Error'`, `.status` number 400, `.code` number 21211,
`.message` `'fail-next-send: rejected by the fake'` (the body's message), `.moreInfo` the body's `more_info`.
One POST reached the mock; nothing was stored for that party.

```text
===== Q3 create -> reject (400 21211) via driver.sendMessage =====
reject -> error: {"ctor":"RestException","name":"Error","message":"fail-next-send: rejected by the fake","code":"number(21211)","status":"number(400)","moreInfo":"https://www.twilio.com/docs/errors/21211","details":"undefined","errno":"undefined","syscall":"undefined","isAxiosError":"undefined","hasResponse":false,"instanceofRestException":true,"instanceofAxiosError":false,"ownKeys":["status","code","moreInfo","details"]}
reject elapsed ms: 1
reject POSTs received by mock: 1
reject messages stored for TO_REJ: 0
```

## Q4 - create against `drop_before_create` and `accept_then_drop` (PASS)

Both modes produce the SAME client-side object, in 4-5 ms:
- constructor `AxiosError` (`isAxiosError: true`, `instanceof` axios's `AxiosError`: true), `.name` `'Error'`
  (copied from the cause by `AxiosError.from`, `axios/lib/core/AxiosError.js:79`), `.message` `'socket hang up'`,
  `.code` string `'ECONNRESET'`, `.status` undefined, `.errno` undefined, `.syscall` undefined, no `.response`.
- `.cause`: a plain `Error`, message `'socket hang up'`, code `'ECONNRESET'`, errno and syscall undefined.
- Own keys: `message, name, isAxiosError, code, config, request, cause` (`config` carries the request headers,
  including `Authorization` - see the cross-cutting note at the end).

Retries: exactly ONE POST per mode reached the mock. twilio-node retries only a 429 RESPONSE and only when
`autoRetry` is set (`RequestClient.js:54-59`, wired at `:127` only under `opts.autoRetry`; the app never sets
it); axios and the redirecting client never retry. The destroyed socket does not poison the keep-alive pool: the next normal send
succeeded on one POST. After `accept_then_drop` the recorded message is found by a list on `To`/`From` (the
adoption path works at the SDK level); after `drop_before_create` that list is empty (the re-drive path).

```text
===== Q4 create -> drop_before_create via driver.sendMessage =====
drop_before_create -> error: {"ctor":"AxiosError","name":"Error","message":"socket hang up","code":"string(\"ECONNRESET\")","status":"undefined","details":"undefined","errno":"undefined","syscall":"undefined","isAxiosError":"boolean(true)","hasResponse":false,"instanceofRestException":false,"instanceofAxiosError":true,"cause":{"ctor":"Error","name":"Error","message":"socket hang up","code":"string(\"ECONNRESET\")","errno":"undefined","syscall":"undefined"},"ownKeys":["message","name","isAxiosError","code","config","request","cause"]}
drop_before_create elapsed ms: 5
drop_before_create POSTs received by mock (1 = no retry): 1
drop_before_create messages stored for TO_DROP: 0
```

```text
===== Q4 create -> accept_then_drop via driver.sendMessage =====
accept_then_drop -> error: {"ctor":"AxiosError","name":"Error","message":"socket hang up","code":"string(\"ECONNRESET\")","status":"undefined","details":"undefined","errno":"undefined","syscall":"undefined","isAxiosError":"boolean(true)","hasResponse":false,"instanceofRestException":false,"instanceofAxiosError":true,"cause":{"ctor":"Error","name":"Error","message":"socket hang up","code":"string(\"ECONNRESET\")","errno":"undefined","syscall":"undefined"},"ownKeys":["message","name","isAxiosError","code","config","request","cause"]}
accept_then_drop elapsed ms: 4
accept_then_drop POSTs received by mock (1 = no retry): 1
accept_then_drop messages stored for TO_ATD: 1
list To=TO_ATD after accept_then_drop (the reconcile would find this): [{"sid":"SM00000000000000000000000000000005","body":"accepted then dropped","status":"queued","dateCreated":"Date(2026-09-27T03:07:44.000Z)"}]
list To=TO_DROP after drop_before_create (expected empty): 0
recovery: normal send to TO_DROP after the drops: {"providerSid":"SM00000000000000000000000000000006","status":"queued","providerTs":"2026-09-27T03:07:44.000Z","actualTransport":"sms"}
recovery POSTs: 1
```

## Q5 - the request timeout (FAIL as written; fix proven)

Code reading (twilio 6.0.2):
- `timeout?: number` IS a client option (`twilio/lib/base/BaseTwilio.d.ts:24`, documented under "https.Agent
  options"). `setOpts` stores it (`BaseTwilio.js:59`) and stores a passed `httpClient` (`:72`).
- It is consumed in exactly ONE place: the lazy `get httpClient()` (`BaseTwilio.js:98-101`), which builds
  `new RequestClient({ timeout: this.timeout, ... })` ONLY when no `httpClient` was passed.
  `BaseTwilio.request` forwards only the PER-REQUEST `opts.timeout` (`:167-176`), which the generated
  resources (create, fetch, page, getPage) never set.
- `RequestClient`: `DEFAULT_TIMEOUT = 30000` (`RequestClient.js:47`); `this.defaultTimeout = opts.timeout ||
  DEFAULT_TIMEOUT` (`:92`), which is also the https.Agent socket timeout (`:99`); each request uses
  `timeout: opts.timeout || this.defaultTimeout` as the axios timeout (`:173`), with `maxRedirects: 0` (`:174`).
- So with a passed `httpClient` (the lane), the timeout is that client's constructor `defaultTimeout`; today
  `createRedirectingHttpClient` builds `new RequestClient()` (`twilioHttpClient.ts:32`) -> 30000, whatever
  `twilio(...)` was given.
- axios 1.18.0: a timeout rejects with `new AxiosError('timeout of <N>ms exceeded', ...)` whose code is
  `ECONNABORTED` - `ETIMEDOUT` only when `transitional.clarifyTimeoutError` is set, which twilio never does
  (`axios/lib/adapters/http.js:553`). With `maxRedirects: 0` axios uses the native transport and arms a
  wall-clock timer from request start until the response headers (`http.js:1267`) as well as the socket-idle
  timer (`:1275`), so the value bounds one whole request. The lane is plain `http://`, so the https.Agent (and
  its socket timeout) is not used there at all; only the axios timeout applies.

Empirical (the stall: the create is accepted and never answered; three clients in parallel):
- A - the lane client as built today plus `twilio(..., { timeout: 2000 })`: `client.timeout` is 2000 but
  `httpClient.defaultTimeout` is 30000; the error arrived after **30014 ms**: `AxiosError`,
  `'timeout of 30000ms exceeded'`, code `ECONNABORTED`.
- B - a redirecting client built as `new RequestClient({ timeout: 2000 })` (what a fixed
  `createRedirectingHttpClient` would do): **2012 ms**, `AxiosError`, `'timeout of 2000ms exceeded'`, code
  `ECONNABORTED`.
- C - the current `new RequestClient()` with the wrapper injecting `timeout: 2000` per request: **2012 ms**,
  same shape as B.
- Production path, no `httpClient`: `twilio(..., { accountSid, timeout: 2000 }).httpClient` is a
  `RequestClient` with `defaultTimeout` 2000 and https.Agent `options.timeout` 2000; with no option it is 30000.
- Timeout error shape (all three): constructor `AxiosError`, `.name` `'AxiosError'` (created directly, not
  from a cause - unlike the dropped socket's `'Error'`), `.message` `'timeout of <N>ms exceeded'`, `.code`
  `'ECONNABORTED'`, `.status` / `.errno` / `.syscall` undefined, no `.cause`, no `.response`. One POST per client.

```text
===== Q5 timeout plumbing - static =====
prod-like, no timeout opt: httpClient.defaultTimeout: 30000
prod-like, timeout 2000, NO httpClient: httpClient ctor: RequestClient
prod-like, timeout 2000, NO httpClient: httpClient.defaultTimeout: 2000
prod-like, timeout 2000, NO httpClient: httpsAgent.options.timeout: 2000
lane as built today + twilio({ timeout: 2000 }): client.timeout: 2000
lane as built today + twilio({ timeout: 2000 }): httpClient.defaultTimeout: 30000
lane fixed (new RequestClient({ timeout: 2000 })): httpClient.defaultTimeout: 2000
lane per-request inject: httpClient.defaultTimeout (constructor default): 30000
```

```text
===== Q5 timeout plumbing - empirical STALL (create accepted, never answered), 3 clients in parallel, 40 s guard =====
A lane-as-built-today + twilio({ timeout: 2000 }) -> elapsed ms: 30014
A lane-as-built-today + twilio({ timeout: 2000 }) -> error: {"ctor":"AxiosError","name":"AxiosError","message":"timeout of 30000ms exceeded","code":"string(\"ECONNABORTED\")","status":"undefined","details":"undefined","errno":"undefined","syscall":"undefined","isAxiosError":"boolean(true)","hasResponse":false,"instanceofRestException":false,"instanceofAxiosError":true,"ownKeys":["message","name","isAxiosError","code","config","request"]}
B fixed: new RequestClient({ timeout: 2000 }) wrapped -> elapsed ms: 2012
B fixed: new RequestClient({ timeout: 2000 }) wrapped -> error: {"ctor":"AxiosError","name":"AxiosError","message":"timeout of 2000ms exceeded","code":"string(\"ECONNABORTED\")","status":"undefined","details":"undefined","errno":"undefined","syscall":"undefined","isAxiosError":"boolean(true)","hasResponse":false,"instanceofRestException":false,"instanceofAxiosError":true,"ownKeys":["message","name","isAxiosError","code","config","request"]}
C per-request timeout injected by the wrapper -> elapsed ms: 2012
C per-request timeout injected by the wrapper -> error: {"ctor":"AxiosError","name":"AxiosError","message":"timeout of 2000ms exceeded","code":"string(\"ECONNABORTED\")","status":"undefined","details":"undefined","errno":"undefined","syscall":"undefined","isAxiosError":"boolean(true)","hasResponse":false,"instanceofRestException":false,"instanceofAxiosError":true,"ownKeys":["message","name","isAxiosError","code","config","request"]}
stall POSTs received by mock (3 = one per client, no retry): 3
```

## Q6 - the plan's classifier on the real errors (PASS)

| Real error | Classification | Design requirement |
|---|---|---|
| reject (RestException 400 / 21211) | `{ kind: 'rejected', code: '21211', status: 400 }` | rejected - met |
| drop_before_create (AxiosError ECONNRESET) | `{ kind: 'unknown', code: 'ECONNRESET' }` | unknown - met |
| accept_then_drop (AxiosError ECONNRESET) | `{ kind: 'unknown', code: 'ECONNRESET' }` | unknown - met |
| timeout, all three clients (AxiosError ECONNABORTED) | `{ kind: 'unknown', code: 'ECONNABORTED' }` | unknown - met |
| fetch 404 (RestException 404 / 20404) | would be `{ kind: 'rejected', code: '20404', status: 404 }` | never classified: `getMessage` maps it to `undefined` first - it MUST keep doing so |
| list or fetch 500 (RestException 500 / 20500) | `{ kind: 'unknown', code: '20500', status: 500 }` | not a send outcome (the reconcile's lookup-failure path); shown for completeness |

```text
===== Q6 plan Task 1 Step 3 classifySendFailure on the REAL errors =====
classify(fetch404): {"kind":"rejected","code":"20404","status":404}
classify(list500): {"kind":"unknown","code":"20500","status":500}
classify(fetch500): {"kind":"unknown","code":"20500","status":500}
classify(reject): {"kind":"rejected","code":"21211","status":400}
classify(dropBeforeCreate): {"kind":"unknown","code":"ECONNRESET"}
classify(acceptThenDrop): {"kind":"unknown","code":"ECONNRESET"}
classify(stall A): {"kind":"unknown","code":"ECONNABORTED"}
classify(stall B): {"kind":"unknown","code":"ECONNABORTED"}
classify(stall C): {"kind":"unknown","code":"ECONNABORTED"}
CHECK reject expects {"kind":"rejected","code":"21211","status":400}: PASS
CHECK dropBeforeCreate expects {"kind":"unknown"}: PASS
CHECK acceptThenDrop expects {"kind":"unknown"}: PASS
CHECK stall A expects {"kind":"unknown"}: PASS
CHECK stall B expects {"kind":"unknown"}: PASS
CHECK stall C expects {"kind":"unknown"}: PASS
```

## Environment and teardown (verbatim)

```text
===== ENV =====
node: v24.14.1
pid: 52500
mock: http://127.0.0.1:47813
twilio: 6.0.2
axios (twilio resolves): 1.18.0
express: 5.2.1
driver client ctor: Twilio
driver client httpClient.defaultTimeout: 30000
```

```text
===== TEARDOWN =====
mock server closed; process exiting; pid: 52500
```

## Instructions for the build

### Task 1 (the classifier)

1. Step 3's `classifySendFailure` is correct against the real objects; no change.
2. The real shapes its tests should mirror: a Twilio rejection is a `RestException` with a NUMERIC `code` and a
   NUMERIC `status` (the `restException(status, code)` fixture matches); a network failure is an `AxiosError`
   with a STRING `code` and NO `status`, `errno` or `syscall` (the `networkError(code)` fixture matches).
3. The SDK's timeout arrives as `ECONNABORTED`, never `ETIMEDOUT`. Both are `unknown`, so nothing changes, but any
   test that fakes "the SDK timed out" should use `code: 'ECONNABORTED'`, message `'timeout of 30000ms exceeded'`.
4. Never key a test or a branch on `err.name`: a RestException and a dropped-socket AxiosError both say `'Error'`;
   only the timeout AxiosError says `'AxiosError'`.

### Task 4 (the port and the pinned timeout) - REQUIRED AMENDMENT

1. Keep `timeout: TWILIO_REQUEST_TIMEOUT_MS` in the `twilio(...)` options: it pins the PRODUCTION client (no
   `httpClient`).
2. ALSO add `timeout?: number` to `RedirectingHttpClientOpts` in `app/src/adapters/twilioHttpClient.ts` and build
   `new RequestClient({ timeout: opts.timeout })` there (RequestClient treats `undefined` as its 30000 default, so
   the other caller, `app/src/adapters/groupConversations.ts:455`, is unaffected and needs no edit).
3. Pass it from `TwilioMessagingDriver`: `createRedirectingHttpClient({ baseUrl: deps.apiBaseUrl, timeout:
   TWILIO_REQUEST_TIMEOUT_MS })`. Pass the VALUE from `messaging.ts`; do not import `lib/sendOutcome.ts` into
   `twilioHttpClient.ts`. (Per-request injection in the wrapper, variant C, also works; the constructor option is
   simpler and makes the pinned value observable as `client.httpClient.defaultTimeout`.)
4. `twilioHttpClient.ts` joins Task 4's Modify list and its commit's explicit paths.
5. The plan's test "pins the request timeout to SEND_CLAIM_TTL_MS" only compares two constants and would pass
   with the lane unpinned. Add plumbing assertions that need no network: construct `TwilioMessagingDriver`
   WITHOUT `client` (a) with `apiBaseUrl: 'http://127.0.0.1:1'` and (b) without it, and expect
   `(driver as unknown as { client: { httpClient: { defaultTimeout: number } } }).client.httpClient.defaultTimeout`
   to equal `TWILIO_REQUEST_TIMEOUT_MS` in both (reading the getter builds the RequestClient; no request is made -
   the spike read exactly these fields). Optionally extend `app/test/twilioHttpClient.test.ts` (the RUNBOOK's
   upgrade contract) with a stall server and `createRedirectingHttpClient({ baseUrl, timeout: 200 })`: expect a
   rejection with `code: 'ECONNABORTED'` well under 2 s (the spike saw 2012 ms for 2000).
6. `listMessages` / `getMessage` as written work against the real SDK objects: `page.instances`,
   `page.nextPageUrl` (a string or `undefined`; never `null` from the SDK, though the `PageLike` type may keep
   `| null`), `page._payload.page_size` (a number). In `summarize` the real instance is camelCase only, so the
   `?? m['error_code']` style fallbacks serve only the unit fakes; they are harmless. `numMedia` is a string on the
   real instance - keep the `parseInt`.
7. `nextPageToken` is the ABSOLUTE `https://api.twilio.com/...` URL even on the lane (the redirecting client
   rewrites it on `getPage`). Keep it in memory within one check; never put it in a payload.
8. Never pass `autoRetry: true` to `twilio(...)`: the SDK would then re-issue a create on a 429 response, and one
   provider call could outlive the claim TTL. Today it is off and each SDK call is exactly one HTTP request.

### Task 11 (fake-twilio routes and seams)

1. The list route answers status **200 exactly**: `Page.processResponse` throws a `RestException` for any other
   status, 201 included (`Page.js:133-134`).
2. The list body's ONLY non-meta key is `messages`. `Page.loadPage` (`Page.js:148`) returns the single key not in
   `Page.META_KEYS` (`Page.js:182`: `end, first_page_uri, last_page_uri, next_page_uri, num_pages, page, page_size,
   previous_page_uri, start, total, uri`); with several non-meta keys it takes the first array-valued one. Do not
   add a `meta` object (a `meta.key` overrides the lookup). The planned shape passed as-is.
3. `next_page_uri` is a PATH (the SDK prefixes `https://api.twilio.com/`; a full `http://127.0.0.1:...` URL would
   become `https://api.twilio.com/http://...`), and it is **percent-encoded - build it with `URLSearchParams`**.
   Q1b proves a raw `+` turns page 2 into a silent empty page. Add a fake test: `next_page_uri` contains
   `To=%2B`, and following it returns the remaining messages (the planned test already follows it; with `+`
   numbers that test is what catches this).
4. `next_page_uri: null` on the last page is correct (the SDK's `nextPageUrl` becomes `undefined`).
5. Every resource ALWAYS carries `date_created`, and carries `date_sent: null` EXPLICITLY while unsent - never
   omit either (Q2b: the SDK fabricates NOW for an omitted date). `date_updated` may be omitted (it is fabricated
   too, but nothing reads it).
6. Dates: `toUTCString()` (`... GMT`) and `... +0000` both parse; serialize from the ONE stored `createdAt`.
   Precision is whole seconds, so a fake or driver test comparing `createdAt` must truncate to the second. Also
   serialize the CREATE response's `date_created` from that same stored value: today the create handler reads a
   second clock (`fake-twilio/src/routes/rest.ts:67`, `new Date().toUTCString()`), and the driver's `providerTs`
   comes from it.
7. `error_code` is an int or `null` (the SDK yields a number or `null`); `num_media` is a string (the SDK passes
   it through as a string).
8. Error bodies stay `{ code, message, more_info, status }` -> `RestException` with numeric `code`/`status`,
   `.message` = the body's `message`. Never give a fake error body BOTH a string `type` and a string `title`: the
   SDK then throws `TwilioServiceException` instead (`Version.js:46`), whose message is `[HTTP <status>] <title>`
   and whose `code` defaults to 0.
9. `drop_before_create` / `accept_then_drop` as `req.socket.destroy()` inside the Express handler (after the
   urlencoded parser has consumed the body) give the client `AxiosError` `ECONNRESET` `'socket hang up'` with no
   status - the expected `unknown`. The underlying Node error is the same `'socket hang up'` / `ECONNRESET`, so the
   planned supertest expectation `/socket hang up|ECONNRESET|aborted/` should match (supertest itself was not
   exercised by this spike).
10. `fail-list` 500 `{ code: 20500, ... }` surfaces as `RestException` 500 / 20500 on both list and fetch.

### Task 12 (lane seams and e2e)

1. `reject`, `drop_before_create` and `accept_then_drop` reach the send site within ~5 ms as ONE POST; the SDK
   never re-posts, so for spec 1 (`accept_then_drop` on a relay leg) `getOutboundTo(B)` holds exactly one message
   unless the app itself re-sends. The only waiting in specs 1, 2 and 4 is the lane's `2000,4000,8000` check
   ladder.
2. After `drop_before_create` the fake holds nothing for that party (the list is empty -> `never_sent` -> the
   re-drive), and the next POST to the same party succeeds on a fresh socket.
3. The send site sees `code: 'ECONNRESET'` (not a provider code): `isProviderCode` is false, so the slot gets
   `send_unconfirmed` and never a numeric code (D10, D23).
4. Build no e2e on a stall or timeout: on the lane it costs the full 30 s request timeout per attempt (variant A:
   30014 ms).

### Cross-cutting (Tasks 3 and 7-10): logging and persisting the raw provider error

A network-failure `AxiosError` has own keys `config` and `request`; `config.headers.Authorization` is the live
Basic API-key credential, and `AxiosError.prototype.toJSON` emits `config` unredacted
(`axios/lib/core/AxiosError.js:128-153`; twilio never sets axios's `redact`). The app's serializer
(`app/src/lib/logSerializers.ts`) makes it safe ONLY under the keys `err`, `error`, `cause`, `reason`, and it
recurses into `.cause`, so a `ProviderSendFailedError` logged as `{ err }` is safe. Therefore: log the typed
errors and their causes only under those keys; never spread them into a log object, never `JSON.stringify`
them, and never persist the raw cause (the attempt record's `cause` stays a code or status string, as the plan
already says).
