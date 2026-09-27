# S5a report - Task 11 (Slice D, part 1): fake-twilio list/fetch and the seams

Dispatch S5a of the SOR Stage 1 build. Implementer: Claude Opus 5.5 (1M context).
Worktree `W:\tmp\send-outcome-reconcile`, base fbc76f98, HEAD 6766e2a3. The
fake now has the Messages list and fetch routes and the fail-next-send /
fail-list seams; every fast gate is green.

Record note: the implementer returned this report as TEXT (the harness refuses
report-file writes from implementer subagents); the orchestrator landed it
here with its own checkpoint appended, per AGENTS.md.

## Commits

- `7e021cae feat(fake-twilio): Messages list and fetch with Smart-Encoded bodies; fail-next-send and fail-list control seams` - the routes, the two seams, the tests and the e2e helpers; only the 8 in-scope files.
- `6766e2a3 test(fake-twilio): S5a mutant pass - the queued-step callback never stamps date_sent` - one test added after the mutant pass (the M17 survivor).

## Routes and seams as built

**List:** `GET /2010-04-01/Accounts/:accountSid/Messages.json?To=&From=&PageSize=&PageToken=`
- Always answers 200 with `{ messages, next_page_uri, page, page_size,
  first_page_uri, previous_page_uri, uri, start, end }`; `messages` is the only
  non-meta key.
- Newest first by reverse store order (global append order), never a
  createdAt sort.
- Filters on the resource `to` and the resource `from`; both optional (with no
  To it lists every message).
- `PageToken` is an integer offset; page size defaults to 50, capped at 1000;
  `page_size` echoes the size actually used.
- `next_page_uri` is a PATH built with URLSearchParams from To / From /
  PageSize / Page, plus PageToken when the offset is above 0; null on the last
  page; a `+` travels as `%2B`.

**Fetch:** `GET .../Messages/:sid.json` - the resource with 200; an unknown
SID answers `404 { code: 20404, message, more_info, status: 404 }`. The path
does not collide with `Messages.json` or the voice routes (checked with
path-to-regexp and tested).

**Resource fields** (create, list and fetch): `sid, account_sid, status, to,
from, body`, `num_media` (a string), `error_code` (an int or null),
`date_created, date_sent, date_updated, messaging_service_sid`, `direction`
(`outbound-api`, or `inbound` with status `received`), `uri`.
- One clock per message: `date_created` is the stored createdAt, RFC 2822 with
  `+0000`, whole seconds.
- `date_sent` comes from a new `sentAt`, stamped the first time the message
  leaves `queued`; later transitions never move it; while queued it is an
  explicit null.
- Smart Encoding (the 8 characters) is applied only when a list or fetch
  serializes the body; the thread store keeps the body exactly as submitted.

**Create:** the response is the same resource but echoes the submitted body;
`date_created` now comes from the stored clock, not the wall clock; a create
with no From reports `from: null`, so a From filter never matches it (the
stored `from` shown in the phones UI stays the app number).

**`POST /control/fail-next-send { partyNumber, mode, code?, count? }`** answers
`{ ok: true }`; keyed by party number and consumed once per create TO that
party; `count` defaults to 1.
- `reject`: `400 { code: code ?? 21211, message: 'fail-next-send: rejected by
  the fake', more_info, status: 400 }`; nothing recorded.
- `drop_before_create`: `req.socket.destroy()`; nothing recorded.
- `accept_then_drop`: the message is recorded and its callbacks fire as
  normal, then the socket is destroyed with no response.

**`POST /control/fail-list { partyNumber, count? }`** answers `{ ok: true }`:
the next `count` list calls whose To is that party, and fetches whose resource
`to` is that party, answer `500 { code: 20500, message: 'fail-list: provider
unavailable', more_info, status: 500 }`. A list with no To, another party's
list or fetch, and a 404 fetch consume nothing.

**Validation:** both routes answer `400 { error }` when `partyNumber` is
missing or not E.164, `mode` is bad, `count` is not a positive integer, `code`
is not a positive integer, or `code` is given with a mode other than `reject`.

**`reset()`** clears both arming maps.

## Deviations from the plan

1. The engine list method is `listMessages({ to?, from? })`, not
   `listMessagesTo(to, from)`; it scans a new `store.messagesInStoreOrder()`
   (the SID index in append order) rather than one thread - for one party the
   order is identical.
2. `ThreadMessage` gains three optional fields (`sentAt`,
   `messagingServiceSid`, `fromOmitted`); they appear as extra JSON in
   `/control/threads` and the live events. The hand-mirrored type in
   `fake-twilio/web` was not updated (out of scope; the extra fields are
   ignored).
3. Beyond the plan: the create response carries the full resource;
   `date_updated`, `account_sid` and `uri` are included; `next_page_uri` also
   carries Twilio's `Page` parameter; inbound messages read back as
   `received`, with `date_sent` set to when they arrived; party numbers must
   be E.164.
4. The create's `num_media` now counts the stored media URLs (the engine drops
   non-http(s) ones); it only differs from before for a bad URL, which the app
   never sends.
5. A private `transition()` helper stamps `sentAt`; Conversations legs go
   through it too.
6. Per ruling A5 there is no e2e `getMessageBySid` helper and no control route
   for it; the engine has a `getMessageBySid(sid)` method, which the routes use.

## Test evidence

- Red first: 21 failed, 22 passed, all for the expected reasons (routes
  answering 404, `smartEncode` missing, fields absent).
- Green: 43/43 in the two files; the full fake suite went from 245 to 268.

**Real-driver chain proof** (a scratch script, because an app import inside a
fake-twilio test would couple the two packages): the session scratchpad
`S5a\chain-proof.mts`, output `chain-proof-final.out.txt`. It drives the real
app `TwilioMessagingDriver` with `apiBaseUrl` pointed at the real fake app
served in-process on 127.0.0.1 with a stub dispatcher (nothing reaches
:8080). On HEAD 6766e2a3: exit 0, 28 PASS, 0 FAIL, no listener left on the
port. Quoted results:
- `listMessages` walks two pages newest first. Page 1's `nextPageToken` is
  `https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Messages.json?To=%2B16175550100&From=%2B15550001111&PageSize=2&Page=1&PageToken=2`.
- Page 1 message three: `{"providerStatus":"queued","body":"It's \"ready\" - see...","mediaCount":0,"createdAt":"2026-09-27T10:00:04.000Z"}`, with no `sentAt`.
- Page 1 message two: `{"providerStatus":"undelivered","errorCode":"30003","mediaCount":2,"createdAt":"2026-09-27T10:00:02.000Z","sentAt":"2026-09-27T10:00:03.000Z"}`.
- Page 2: `[one]`, delivered, `sentAt` T0+1, no `nextPageToken`; the first
  create's `providerTs` equals the `createdAt` the list reports for it.
- Page size 1000 raises no size warning; `getMessage` of an unknown SID
  returns undefined.
- `reject`: `{"ctor":"RestException","message":"fail-next-send: rejected by the fake","code":21211,"status":400}`, classified `{"kind":"rejected","code":"21211","status":400}`.
- `drop_before_create` and `accept_then_drop`: `{"ctor":"AxiosError","message":"socket hang up","code":"ECONNRESET"}`, classified `{"kind":"unknown","code":"ECONNRESET"}`; after `accept_then_drop` the list finds the message; after `drop_before_create` it finds nothing, and the next create to that number succeeds.
- `fail-list`: both `listMessages` and `getMessage` throw `RestException` 500/20500.
- An unpinned send never matches a From filter.

## Mutant spot-check (24 run, every restore verified with `cmp`)

| Area | Mutants | Result |
|---|---|---|
| Seam consumption and keying | M1-M6, M22-M24 | all killed |
| Smart Encoding only at serialization | M7-M9 | all killed |
| Paging math and `next_page_uri` encoding | M10-M14 | all killed |
| The `date_sent` null rule | M15-M17 | M17 survived at first; now killed |
| One clock (create uses the wall clock) | M18 | killed |
| `reset()` keeps each map | M19-M20 | killed |
| From filter on the stored `from` | M21 | killed |

M17 stamped `sentAt` on the queued step itself; on the lane that callback fires
immediately, so every queued message would have carried a `date_sent`. The
test in 6766e2a3 kills it.

## Gates

| Gate | Exit | Result |
|---|---|---|
| `npm run test -w @housingchoice/fake-twilio` | 0 | 34 files, 268 tests |
| `npm run test -w @housingchoice/e2e` | 0 | 21 files, 499 tests |
| `npm run typecheck` (root) | 0 | 0 `error TS` lines |
| `npx eslint` on the 8 touched .ts files | 0 | no output |

The e2e workspace unit tests ran because `support/fakeTwilioChannelPrefix.test.ts`
imports `fixtures/fakeTwilio.ts`. No Playwright run or lane was started. Staged
added lines had 0 non-ASCII bytes on both commits.

## Contract for downstream (Task 12), in `e2e/fixtures/fakeTwilio.ts`

- `failNextSend(request, { partyNumber, mode: 'reject' | 'drop_before_create' | 'accept_then_drop', code?: number, count?: number }): Promise<void>` - throws on any non-2xx.
- `failList(request, { partyNumber, count?: number }): Promise<void>` - a
  reconcile check stops at the first failed call, so `count: 3` fails all
  three checks of one send.

Gotchas:
- Arm only per-run-unique numbers: an arming nobody consumes survives until
  `/control/reset`, which runs once per suite.
- `reject` and `drop_before_create` leave any `setDeliveryOutcome` profile
  armed, so the re-drive picks it up; they also do not auto-register a
  never-seen number as a persona.
- Settle a relay group's intros (poll `getOutboundTo`) before arming a
  member, or the intro consumes the arming instead of the leg.
- Arming `failList` alongside any `failNextSend` mode is fine; spec 4 does this.
- Under `accept_then_drop`, the fake's callbacks reach the app before
  adoption; expect up to two "unknown provider SID" ERRORs in the app log
  (T16-4).

## Concern

`fake-twilio/README.md` lists the control routes but does not mention the two
new seams (outside this dispatch's file scope; a one-line follow-up).

## Orchestrator checkpoint

Verified at 6766e2a3: only the 8 in-scope files changed; 0 non-ASCII bytes in
the added lines; `npm run typecheck` EXIT=0 with 0 `error TS`; the fake-twilio
suite re-run EXIT=0 (34 files, 268 tests). The README follow-up is folded into
the S5b dispatch.
