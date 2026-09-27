# Plan review round 1 - reviewer B (adversarial)

Plan: `docs/superpowers/plans/2026-09-26-voicemail-greeting.md` (DRAFT 1, commit b07b85be)
Spec: `docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md` (DRAFT 3)
Worktree: `W:\tmp\voicemail-greeting`, read-only except this file.
Environment for every empirical probe below: Node v24.14.1 on Windows 10
(the machine the completion gates run on), express 5.2.1, supertest 7.2.2 /
superagent 10.3.0, @aws-sdk/lib-storage 3.1070.0, fast-xml-parser 4.5.6
(fake-twilio), @testing-library/dom 10.4.1, @testing-library/user-event
14.6.1, playwright-core 1.61.0, vite 7.3.5. Probe scripts were throwaway
files in the session scratchpad; none touched the worktree.

Question asked: if a builder with no context executes this plan literally,
do they produce the spec? Short answer: no. Task 4's core refusal tests are
red under the plan's own harness for a reason the plan misdiagnoses; the
chunked-refusal mechanism the plan copies from the spec cannot deliver the
413 it is tested for; and Tasks 5, 6, 8 and 9 each contain tests that cannot
pass as written.

---

## 1. [BLOCKING] supertest sends `Connection: close`, so every big-body refusal test in Task 4 resets - and the plan's troubleshooting note blames the (correct) route

**What is wrong.** Task 4 pins the refusal-must-reach-the-client contract
with supertest bodies of 3 MiB and 6 MiB (plan lines 926-943; the refused
replace inside 1004-1021). supertest/superagent send `Connection: close` on
every request by default. When the client says `Connection: close`, Node's
HTTP server closes the socket as soon as the response finishes; the client is
still uploading, the server closes with unread bytes in its receive buffer,
the kernel sends RST, and the client reports ECONNRESET before it reads the
400/413. The route wiring is irrelevant: this happens even when the route is
exactly the spec's `req.pipe(gate)` + `unpipe` + `resume` design.

**Evidence (empirical, deterministic).**
- A supertest request to a plain `http.createServer` records
  `{"connection":"close"}` on the server side.
- Replica of the plan's route (Task 4 Step 5 code, same gate, a `for await`
  put like the harness fake at `app/test/helpers/twilioWebhookHarness.ts:3871-3886`),
  driven by supertest, 3 runs:
  - 3 MiB WAV declared `audio/mpeg` (sniff refusal): ECONNRESET x3
  - 6 MiB with Content-Length (step-3 early 413): ECONNRESET x3
  - SAME requests with `.set('connection', 'keep-alive')`: 400 JSON x3 and
    413 JSON x3.
- A raw `http.request` with Node 24's default keep-alive agent against the
  same server: 400/413 JSON every time; a raw client that sends
  `Connection: close`: ECONNRESET.
- Isolation run: supertest -> raw `http.createServer` answering 413 before
  reading a 6 MiB body: ECONNRESET x3. So it is supertest's header, not
  Express and not the route.

**Where the plan goes wrong.** Task 4 Step 6 (plan line 1448): "If the 3 MiB
sniff test or the chunked 413 test times out or reports ECONNRESET, the
wiring regressed toward `pipeline`/`Connection: close` - re-read the route
comment; do not shrink the bodies." A literal builder whose route matches the
plan byte for byte gets ECONNRESET, re-reads a correct route, is forbidden to
shrink bodies, and is stuck. The spec (section 5, "bodies of at least 3 MiB")
mandates the same tests.

**What it implies.** Task 4 cannot go green as written; Review Focus 1 and 3
("Pinned in Task 4") are unpinned. Fix in the plan: the `admin()` / `upload()`
helpers must `.set('Connection', 'keep-alive')` (verified to work), and the
Step 6 note must name the real cause. Related field consequence (see 11):
the local Vite dev proxy also forces `Connection: close`.

---

## 2. [BLOCKING] The chunked over-cap refusal (`res.once('finish', () => req.destroy())`) resets the client before it reads the 413, so the spec-mandated chunked test cannot pass; supertest cannot even send it

**What is wrong.** Spec 4.3 step 4 and plan line 1331-1334 answer a CHUNKED
body that trips `too_large` with 413 and then `req.destroy()` on the response
`'finish'` event. `'finish'` means the bytes were handed to the OS, not that
the client read them; destroying the socket while the client is still
writing produces an RST that discards the response on the client side.
Spec section 5 and plan lines 945-955 require "the 413 JSON reaches the
client" for a chunked 6 MiB body.

**Evidence (empirical).**
- Replica route, raw `http.request` with the default keep-alive agent,
  `Transfer-Encoding: chunked`, 6 MiB written in two writes: ECONNRESET 5/5.
- Same replica with the destroy line replaced by `req.resume()`: 413 JSON 5/5.
  The destroy is the cause.
- The plan's primary test code, supertest `.send(Readable.from([...]))`
  (plan line 951), throws `ERR_INVALID_ARG_TYPE` client-side (superagent does
  not pipe a Readable passed to `send`). Only the plan's fallback prose
  (line 1113) is runnable, and that fallback then hits the reset above.
- The round-2 spec probe that motivated this design
  (`spec-r2-reviewer-b.md`, table at lines 40-46) measured "too_large, 6 MiB
  chunked -> 413 x8" with `req.pipe` + `req.resume()`, i.e. WITHOUT a
  destroy. The destroy-after-flush variant the spec adopted was never
  measured.

**What it implies.** The spec contradicts itself (a destroy that is required
AND a 413 that must arrive). The builder cannot satisfy both; this needs a
planner/spec decision before Task 4 starts: e.g. drain with a hard byte or
time ceiling and destroy only past it, or keep the destroy and change the
test to assert the connection is refused rather than that JSON arrives.
Production impact is small (browsers never send a Blob chunked), but the
test as specified is unpassable.

---

## 3. [HIGH] Task 5 webhook tests reference a `harness` that does not exist and are placed outside the scope that owns `world` and `seedRingingBridge`

**What is wrong.** Tests (a)-(d) read `harness.capture` (plan lines 1508,
1509, 1517, 1528, 1542). In `app/test/founderTriage.test.ts` there is no
module-level `harness`: `seedRingingBridge` (lines 598-605) calls
`founderHarness(world)` (lines 102-114), builds a fresh harness, and returns
only `app`; `world` is a `let` inside the `describe('founder call-triage -
MISSED ...')` block (lines 553-1136) together with its `beforeEach` job
wiring. The plan says "Append to founderTriage.test.ts" and writes two new
top-level `describe`s. Appended at the end of the file, `world`,
`seedRingingBridge` and `harness` are all out of scope (TS errors /
ReferenceError); placed inside, `harness` is still undefined.

Tests (e) and (f) need the holder setup that only `founderHarness` does
(admin cell + `assignInboundVoiceLine`, lines 104-113) on a harness built with
extra options (`voicemailGreetingLookupBudgetMs`, `withoutMediaStore`). The
plan's instruction (line 1593) is premised on a false reading: "if it closes
over a module-level `harness`, extract a `seedRingingBridgeOn(h)`". It does
not close over one; `founderHarness` itself must learn options and
`seedRingingBridge` must return the harness (or its capture).

**What it implies.** As written, Task 5 Step 2's "expected FAIL" is a
ReferenceError, not the intended red, and Step 4 cannot go green without the
builder redesigning the helpers. Delivered only if the builder guesses right.

---

## 4. [HIGH] The plan's `<div aria-labelledby>` makes "Voicemail greeting" an ambiguous label: RTL and Playwright label queries both fail

**What is wrong.** The block (plan line 2595) is
`<div className={styles.greetingBlock} aria-labelledby={headingId}>` whose
`<h3 id={headingId}>` reads "Voicemail greeting"; the player is
`<audio aria-label="Voicemail greeting">` (line 2645). The spec (4.7) never
asked for the `aria-labelledby` on the wrapper. Both test stacks resolve
labels through `aria-labelledby` on ANY element:
- @testing-library/dom 10.4.1: a jsdom probe of exactly this markup gives
  `queryAllByLabelText('Voicemail greeting') -> [DIV, AUDIO]` and
  `getByLabelText` throws "Found multiple elements with the text of:
  Voicemail greeting".
- playwright-core 1.61.0 `getElementLabels` (coreBundle.js) returns
  `getAriaLabelledByElements(element)` for every element, and the label
  engine is substring/case-insensitive by default, so `page.getByLabel(
  'Voicemail greeting')` matches the div and the audio - a strict-mode
  violation on `toBeVisible()` / `getAttribute`.

**Broken steps.** Task 8 tests "a valid file uploads ..." (line 2321) and
"the player's error event ..." (line 2332); Task 9 test 1 (line 2922) and the
phone-width test (line 2971).

**What it implies.** Drop the wrapper's `aria-labelledby` (or give the
wrapper a region role with a distinct name and scope the queries).

---

## 5. [HIGH] Task 8's M4A reject test can never fire: `userEvent.upload` filters the file out against the input's `accept`

**What is wrong.** Plan lines 2286-2292 upload `memo.m4a` / `audio/mp4` with
the direct `userEvent.upload(...)` API into an input whose
`accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav"` (line 2557).
user-event 14.6.1 defaults `applyAccept: true` for the direct API
(`dist/esm/setup/setup.js:20`) and filters files with `isAcceptableFile`
(`dist/esm/utility/upload.js:18,40-58`). `audio/mp4` matches no token, the
filtered list is empty, the "selection did not change" guard returns, no
change event fires, and `findByRole('alert')` times out.

**What it implies.** The test is red for a reason unrelated to the code under
test. Use `userEvent.setup({ applyAccept: false })` or `fireEvent.change`.
(The e2e path is fine: Playwright `setInputFiles` ignores `accept`.)

---

## 6. [HIGH] Task 6: a throwing injected `fetchStatus` aborts `leaveVoicemail`; the plan's own test and spec 4.8 "continues regardless" both fail

**What is wrong.** The plan's `leaveVoicemail` insertion (lines 1926-1931)
does `call.voicemailGreetingFetchStatus = await this.fetchStatus(plan.playUrl)`
with no try/catch; only `defaultFetchStatus` (lines 1906-1914) catches. The
plan's test (lines 1801-1810) injects `fetchStatus: async () => { throw ... }`
and expects status 0 and a `completed` call. The throw propagates out of
`leaveVoicemail`; `scheduleAutoRun` swallows step failures
(`fake-twilio/src/engine/callEngine.ts:345-349`), so the call is left
un-completed with no fetch status.

**What it implies.** Task 6 Step 4 cannot pass, and spec 4.8 ("records the
status, and continues regardless") / section 5 ("proceeds when fetchStatus
throws (status 0)") are not delivered. The catch belongs around the call in
`leaveVoicemail`, not only in the default.

---

## 7. [HIGH] The e2e spec's own header comment trips the viewport guard and turns gate 2 red

**What is wrong.** Plan lines 2838-2840, in
`e2e/tests/dashboard-next/voicemail-greeting.spec.ts`:
"NEVER\n// documentElement.scrollWidth here - support/viewport.guard.test.ts
fails the file". `e2e/support/viewport.guard.test.ts:59-63` does a raw
`readFileSync(file).includes('documentElement.scrollWidth')` over every
`.ts/.tsx/.mjs` under `e2e/` (comments included); only
`support/viewport.ts` is allowed (line 40).

**What it implies.** `npm test` fails on the new spec file. Task 9 never runs
`npm test`, so it surfaces only at the gate phase. Reword the comment.

---

## 8. [MEDIUM] Task 4 asserts the wrong uploader identity; the happy-path and audit tests fail

**What is wrong.** Plan lines 963-976 expect `uploadedByUserId: 'user-0001'`,
`uploadedByEmail: 'founder@example.com'` and audit `actor: 'user-0001'` for a
request made with `TEST_ADMIN_COOKIE`. That cookie is
`sessionCookieFor(TEST_ADMIN_USER)` (`app/test/helpers/authSession.ts:115`),
and `TEST_ADMIN_USER` is `usr_testadmin000000000000000` /
`test-admin@housingchoice.org` (lines 33-36). `founder@example.com` is the
e2e lean-seed user, not the unit harness session.

**What it implies.** The central happy-path test fails on correct code. Use
`TEST_ADMIN_USER.userId` / `.email`.

---

## 9. [MEDIUM] Webhook test (g) is an empty `it()` body; spec test (g) is undelivered

**What is wrong.** Plan lines 1556-1559: the masked-relay-miss-with-greeting
test contains only comments. An empty test passes, and Step 2 (line 1598)
lists "(b) and (g) pass already" as if that were a guard. The self-review
(line 3081) claims the only `// ...` lines carry explicit instructions; this
one has no code at all. The setup to copy exists
(`founderTriage.test.ts:1035-1062`: `seedRelayGroup(world)` + masked `/voice`
+ `/status`).

**What it implies.** Spec section 5 (g) (masked miss keeps the goodbye, no
`<Play>`, no head) ships unpinned unless the builder writes it unprompted.

---

## 10. [MEDIUM] Test (e) cannot tell whether the `withTimeout` bound exists; the hung-GetItem and hung-presign cases are unpinned

**What is wrong.** In test (e) the hung head is released by the SAME budget
through two mechanisms: `AbortSignal.timeout(50)` (created first) and
`withTimeout`'s `setTimeout(50)`. Node runs same-duration timers in insertion
order with microtasks between them, so the abort listener rejects the fake
head, the lookup rejects, and the race settles with the `AbortError` before
the withTimeout timer fires. Probe (the plan's `withTimeout` + a lookup whose
head rejects on abort, budget 50): rejected with `AbortError` 5/5, never
`GreetingLookupTimeoutError`. The WARN message is the same string for a
thrown error and a timeout ("lookup failed or timed out"), so the assertion
`toContain('timed out')` (line 1582) cannot discriminate.

**What it implies.** Deleting `withTimeout` from the webhook leaves test (e)
green. The only thing `withTimeout` protects that the abort signal does not -
a hung DynamoDB GetItem or a hung presign - has no test, though spec 4.6
makes "the WHOLE lookup is bounded" the point. There is also no unit test
that `S3MediaStore.head` actually forwards `abortSignal` to `client.send`
(the fake-client pattern exists in `app/test/mediaStore.getStreamRange.test.ts`).
Add a hang seam on the harness settings read (or presign) and a head
adapter test.

---

## 11. [MEDIUM] The e2e "server refusal reaches the browser" check is vacuous, and the guarantee does not hold through the local Vite proxy for multi-MB files

**What is wrong.**
- Plan lines 2958-2961: the second `setInputFiles` (renamed M4A as
  `audio/mpeg`) asserts the SAME alert text that the first (client-side)
  rejection already left on screen. `toHaveText` can be satisfied by the
  stale alert before or regardless of the server's answer; a 500 or a reset
  could pass. It needs a response wait (`page.waitForResponse` on the PUT,
  status 400) or a cleared alert in between.
- The Vite dev proxy has no agent (`dashboard/vite.config.ts:13-16`), and
  Vite's bundled http-proxy then forces `connection: close` on the proxied
  request (`node_modules/vite/dist/node/chunks/config.js:20714-20718`). A
  replica with a `Connection: close` hop and 16 KiB streamed writes: sniff
  refusals at 200 KB and 1 MB returned 400 JSON; at 3 MB ECONNRESET 3/3. So
  the e2e's 200 KB body passes, but a real multi-MB renamed memo in local dev
  gets "Couldn't upload the greeting. Try again." instead of the M4A message.
  Production behind CloudFront (persistent origin connections) is
  UNVERIFIED but probably unaffected.

**What it implies.** Review Focus 1's browser-level claim is not proven by
the e2e, and the local-dev behavior differs from the spec's promise; worth a
sentence in the handback at minimum.

---

## 12. [LOW] Task 4 imports `minimalWav` from a test file, which re-runs the whole Task 1 suite inside the routes file

Plan line 867: `import { minimalWav } from './voicemailGreeting.test.js';`.
Importing a vitest file executes its top-level `describe`/`it`, so every
Task 1 case (including the process-level `unhandledRejection` listener test)
is collected and run a second time under `voicemailGreetingRoutes.test.ts`.
Put `minimalWav` in `app/test/helpers/`.

---

## 13. [LOW] Perf-contract surfaces the plan does not enumerate

- `e2e/performance/routes.ts:699` and `:753` cite
  `VoiceSection.tsx:93-127,176` as the source of the Voice tab's GETs and
  terminal; after Task 7/8 the required `GET /api/settings` comes from
  `useVoicemailGreeting.ts`. The citation test only checks the format
  (`routes.test.ts:419-431`), so this drifts silently.
- `e2e/performance/templates.ts` `ENDPOINT_TEMPLATES` lists every app
  endpoint (including `/api/calls/:callId/recording`); the three new
  endpoints are absent, so a perf run with a greeting set records the
  `preload="metadata"` audio GET as `unmatched_api`.
- `VOICE_TERMINAL` (`routes.ts:428-435`) alternative 2 is
  `[text 'Your cell', role_only status]`; the greeting block's status lines
  now satisfy the status half independently of the cell verification.
None is a gate; `perf:pages` is human-invoked.

---

## 14. [LOW] Stale spec label and hard-coded model trailer

Plan line 11 says the spec is "DRAFT 2"; it is DRAFT 3 (the plan does follow
DRAFT 3's mechanisms). Every commit block hard-codes
`Co-Authored-By: Claude Fable 5.1` (line 22 and each Step "Commit"); AGENTS.md
requires the AUTHORING model and `.claude/CLAUDE.md` forbids children
silently running as Fable, so a literal builder will misattribute.

---

## 15. [LOW] No task carries the spec's handback items

Spec section 3 says assumptions A-H are "flagged for the handback as
questions the planner would have asked"; 4.10 names infra facts "carried to
the handback" (prior versions persist on the versioned bucket; CloudFront
`origin_read_timeout` during a slow 5 MB upload is UNVERIFIED); section 7
defines the dev verification. Task 10 stops at the gates. Add a step that
writes these into the handback.

---

## 16. [LOW] Small spec deltas in the client pre-check and unit-test lists

- `greetingContentTypeFor` (plan lines 2407-2417) also accepts `audio/mp3`,
  `audio/wave`, `audio/vnd.wave`; spec 4.7 says use `file.type` when it is in
  the three-type allowlist, else the extension only when the type is EMPTY,
  else reject. Harmless (the server still sniffs) but an undocumented
  widening of the client-side reject set.
- Spec section 5 lists ADTS `0xFFF9` rejected under both formats; the plan
  tests only `0xFFF1`. Spec 4.7 says `body` + `rawBody` together is a
  programmer error that throws; the plan implements it but pins no test.

---

## Checked and found sound (no finding)

- `mediaStore` is declared at `app/src/routes/api.ts:620`, before the
  settings mount at 724 (no TDZ). The settings router already has `log`,
  `settings`, `audit`, `requireRole`, `AuthedRequest`, `ORG_SETTINGS_ENTITY_KEY`.
- `putOrgSettings({ voicemailGreeting: null })` emits exactly
  `REMOVE #k0` with `{ '#k0': 'voicemailGreeting' }` (`settingsRepo.ts:307-345`);
  `fakeDocReturning` exists (`settings.test.ts:516`).
- lib-storage splits on `currentBuffer.length > partSize` (strictly greater,
  `dist-cjs/index.js:90`), so a body of exactly 5 MiB is one PutObject, and a
  failed body rejects `done()` with the ORIGINAL error
  (`index.js:411-419`); `S3MediaStore.put` rethrows it unchanged
  (`mediaStore.ts:162-182`), so `instanceof GreetingRejectedError` holds in
  production.
- fast-xml-parser 4.5.6 with `preserveOrder: true`: the plan's
  `greetingBeforeRecord` returns play/say/none correctly for all four spec
  cases and for real twilio `VoiceResponse` output (entity `&amp;` decoded).
- Mutation-catalog scanner (`e2e/performance/mutationCatalog.test.ts`): the
  delegated fetch is recognized by symbol + `buildUrl(...)` only, so the
  options-object change in `client.ts` is invisible; the two new
  `request:PUT/DELETE` entries make the non-delegated count 110 and their
  interception flag is derived from the catalog itself.
- `TwilioVoiceWebhookDeps` flows whole through `webhooks/index.ts:17,26`, so
  the new budget dep needs no extra plumbing; `onFounderBridgeMissed` catches
  its own failures (`voice.ts:2282-2298`).
- TypeScript under the repo's flags (`strict`, `noUncheckedIndexedAccess`):
  `toVoicemailGreeting`'s element-access narrowing, the exhaustive `switch`
  without a default, the try/catch definite assignment of `sizeBytes`, and
  the harness hanging-`head` fake all compile (probed with the repo's tsc).
- Every other `MediaStore` implementation or fake either is `S3MediaStore`,
  the harness fake, or a cast `Partial`/structural fake with `head(key)`,
  which remains assignable to the widened signature.
