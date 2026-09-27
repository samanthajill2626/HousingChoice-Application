# Plan review R1 - reviewer A (adversarial)

Plan: `docs/superpowers/plans/2026-09-26-voicemail-greeting.md` (DRAFT 1, @b07b85be)
Spec: `docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md` (DRAFT 3, approved)
Worktree: `W:\tmp\voicemail-greeting` (read-only for this review; only this file written)
Date: 2026-09-26
Runtime: Node v24.14.1, express 5.2.1, supertest 7.2.2 / superagent 10.3.0,
@aws-sdk/lib-storage 3.1070.0, fast-xml-parser 4.5.6 (fake-twilio), vitest 3.2.6,
@testing-library/user-event 14.6.1, vite 7.3.5.

Question asked: if a builder with no context executes this plan LITERALLY, do
they produce the spec? Answer: not without deviating. Two refusal-path route
tests cannot go green as written (one because of the test client, one because
the spec's own chunked mechanism resets the client), the webhook test block
references a harness that does not exist and ships one spec-required test as
an empty body, and three dashboard/e2e checks fail against the plan's own
component. Findings below, highest consequence first.

Empirical method: every runtime claim marked "ran" was proven with throwaway
scripts in my session scratchpad (never in the repo). The route experiments
replicate the plan's Task 1 gate and Task 4 PUT handler verbatim (transliterated
to JS) inside Express 5 with `express.json()` mounted, plus a consuming fake
`put` identical in shape to the harness fake (`for await` over the body). The
dashboard experiment ran the plan's Task 8 hook, block and test files copied
verbatim from the plan (only import specifiers re-pointed to absolute worktree
paths) under the dashboard's vitest + jsdom + setup file. `git status` in the
worktree was clean before and after.

---

## 1. [BLOCKING] Task 4's large-body refusal tests go through supertest's default `Connection: close` and get ECONNRESET every time; the plan's troubleshooting note blames the (correct) wiring and forbids the only non-fix

**What is wrong.** superagent (under supertest) sends `Connection: close` on
every request. When the handler answers a refusal while the client is still
uploading, Node's server honors that header: after the response flushes it
closes the socket with unread body bytes, which sends a TCP reset, and the
client sees ECONNRESET instead of the JSON. This is exactly the defect spec
round 2 found for a SERVER-set `Connection: close`; here the header comes from
the test client, so the route wiring cannot fix it.

**Evidence (ran).**
- Trace of what superagent puts on the wire (plain `http.createServer`
  logging `req.headers`): `{"host":"127.0.0.1:63046","accept-encoding":"gzip,
  deflate","content-type":"audio/mpeg","content-length":"3145728",
  "connection":"close"}`.
- Plan wiring (req.pipe(gate) + unpipe/resume on refusal), 6 trials each:

  | case | supertest default | supertest + `.set('connection','keep-alive')` | raw `http.request` (keep-alive) |
  |---|---|---|---|
  | 3 MiB WAV bytes declared audio/mpeg (sniff 400) | ECONNRESET x6 | 400 JSON x6 | 400 JSON x6 |
  | 6 MiB with Content-Length (early 413) | ECONNRESET x6 | 413 JSON x6 | 413 JSON x6 |
  | 256 KiB sniff refusal | 400 x6 | - | - |

- Plan tests affected: Task 4 lines 927-934 (3 MiB sniff), 936-943 (6 MiB
  Content-Length 413), 1004-1021 (refused replace at 3 MiB and 6 MiB). All go
  through `admin()` / `upload()` (lines 882-891), which never set Connection.
- Plan Task 4 Step 6 (line 1448): "If the 3 MiB sniff test or the chunked 413
  test times out or reports ECONNRESET, the wiring regressed toward
  `pipeline`/`Connection: close` - re-read the route comment; do not shrink
  the bodies." The wiring is correct (the raw-http and keep-alive columns
  prove it); the reset is the client's header. The note sends the builder
  hunting a regression that does not exist, in the one mechanism the spec
  spent two review rounds getting right, and forbids shrinking the bodies (the
  only thing that would turn it green, and wrongly).

**What it implies.** Task 4 cannot reach a green Step 6 as written. The fix
is one line in the test helper, verified: `admin()` adds
`.set('Connection', 'keep-alive')`. The plan should say so and say WHY, and
the Step 6 note must be rewritten, or a builder will damage the route.

---

## 2. [BLOCKING] The chunked over-cap refusal cannot deliver the 413 JSON under the spec/plan's destroy-after-flush, so the spec-required chunked test is unpassable with any client

**What is wrong.** Spec 4.3 (lines 447-452) and plan Task 4 (route lines
1331-1333) handle a chunked body that trips `too_large` by answering 413 and
then `res.once('finish', () => req.destroy())`. Destroying a socket that still
has unread incoming data resets the connection, and the client loses the
response it had not yet read. Spec section 5 (lines 858-860) and plan lines
945-955 require that the chunked 413 JSON "must" arrive. The mechanism and
the test contradict each other.

**Evidence (ran).**
- Raw `http.request`, `Transfer-Encoding: chunked`, 6 MiB written as 2 MiB +
  4 MiB, plan wiring: `reqError ECONNRESET` 10/10 in one run, 6/6 in a second
  (64 KiB piped writes).
- Same, with the chunked branch changed to `req.resume()` (drain, the round-1
  posture): `413 {"error":"file_too_large"}` 6/6.
- The plan's primary test form cannot even run: `.send(Readable.from([...]) as
  never)` throws `TypeError: The "string" argument must be of type string or
  an instance of Buffer or ArrayBuffer. Received an instance of Readable`,
  because superagent computes `Buffer.byteLength(data)` for Content-Length on
  any non-Buffer body (node_modules/superagent/lib/node/index.js:946-947). The
  plan's fallback (raw http, line 1113) then hits the reset above.

**What it implies.** The build stops at Task 4 Step 6 on a spec-internal
conflict a builder is not entitled to resolve. The planner must choose, e.g.:
(a) drain the chunked remainder up to a further bound (say another
`VOICEMAIL_GREETING_MAX_BYTES`) and only then destroy, which delivers the 413
for the test's 6 MiB body and still bounds an abusive stream; or (b) keep
destroy-after-flush and change the test to "413 or reset, and zero puts",
recording that a chunked client may not see the JSON (browsers never send a
Blob chunked). Either is a spec edit.

---

## 3. [HIGH] Task 5's webhook tests use a `harness` that does not exist, and the seeding helper they are told to reuse cannot take the harness options (e)/(f) need

**What is wrong.**
- Tests (a), (b), (c), (d) read `harness.capture` (plan lines 1508, 1509,
  1517, 1528, 1542). There is no `harness` binding anywhere in
  `app/test/founderTriage.test.ts`: `seedRingingBridge` (lines 598-605) is a
  function local to the MISSED `describe` (line 553), closes over that
  describe's `let world` (554), builds the harness via `founderHarness(world)`
  (107-120) and returns ONLY `app`, discarding `capture`. Every existing test
  uses `const app = await seedRingingBridge()`.
- The new block is written as a separate top-level `describe` (plan 1476),
  outside the MISSED describe, so it cannot see `seedRingingBridge` or `world`
  either, nor that describe's `beforeEach` job wiring (556-584).
- Plan line 1593: "if it closes over a module-level `harness`, extract a
  `seedRingingBridgeOn(h)` variant". The premise is false (it closes over a
  describe-scoped `world`, not a harness), and the harness that makes the miss
  reach the voicemail branch is `founderHarness`, which sets the admin's
  verified cell and `assignInboundVoiceLine` (110-118) and accepts no options.
  Tests (e) and (f) need `voicemailGreetingLookupBudgetMs: 50` and
  `withoutMediaStore: true`; built with a bare `makeWebhookHarness` (plan
  1548, 1565) they skip the holder wiring.

**What it implies.** A literal builder gets ReferenceErrors and must redesign
the test scaffolding (return the harness from the seed helper, give
`founderHarness` an options parameter, move the block inside the MISSED
describe or duplicate its setup). That is exactly the kind of improvisation
in which assertions get weakened. The plan should show the restructure.

---

## 4. [HIGH] Test (g) - the masked relay miss with a greeting set - is an empty test body that passes vacuously

**What is wrong.** Plan lines 1556-1559: the `it('(g) ...')` body is two
comment lines and no code. Step 2 (line 1598) then predicts "(b) and (g) pass
already", which for (g) is true forever. The self-review (line 3081) claims
the only `// ...` lines are in (e)/(f) and the fake-twilio tests.

**Evidence.** Spec section 5 webhook (g) (line 902): "masked relay miss with a
greeting set -> still the goodbye, no `<Play>`"; spec 4.6 (lines 625-627): the
masked/outbound branch is untouched. The file already has the setup to copy
(`seedRelayGroup`, founderTriage.test.ts:67-87, used by the existing masked
test).

**What it implies.** The privacy-side guard (a masked relay call must never
get the business greeting or a HEAD) ships unpinned while the suite is green.

---

## 5. [HIGH] The block's container is labelled "Voicemail greeting", the same accessible name as the `<audio>`, so every by-label lookup of the player matches two elements (unit tests and e2e)

**What is wrong.** Plan line 2595 renders `<div className={styles.greetingBlock}
aria-labelledby={headingId}>` pointing at the `<h3>Voicemail greeting</h3>`,
and line 2645 gives the player `aria-label="Voicemail greeting"`. Both
Testing Library and Playwright resolve aria-labelledby labels on ANY element,
not just form controls.

**Evidence (ran).**
- The plan's Task 8 test file run against the plan's own hook and block (only
  import paths re-pointed): 3 of 10 fail. 'a valid file uploads and renders
  name, date, player and Replace/Remove' fails with `TestingLibraryElementError:
  Found multiple elements with the text of: Voicemail greeting` (plan line
  2321); "the player's error event renders the missing-file status line"
  times out on `findByLabelText('Voicemail greeting')` (line 2332).
- A jsdom probe with @testing-library/dom `queryAllByLabelText` over that
  markup returns `[DIV, AUDIO]`.
- Playwright: `getElementLabels` in playwright-core's injected script returns
  `getAriaLabelledByElements(element)` first, for every element, before the
  aria-label and form-control branches. `page.getByLabel('Voicemail greeting')`
  at plan lines 2922 and 2971 therefore resolves two elements and fails strict
  mode.
- Removing `aria-labelledby` from the div (plus finding 7's fix) turns the
  plan's dashboard file 10/10 green (ran).

**What it implies.** Task 8 Step 5 and Task 9 fail as written. A generic
`div` with `aria-labelledby` is also prohibited ARIA (generic role). Drop the
attribute (or give the block `role="region"` and select the player by role
`audio`-free means such as `locator('audio')`), and say which.

---

## 6. [HIGH] The e2e spec's own header comment contains the literal the viewport guard forbids, so gate 2 fails on the new file

**What is wrong.** Plan line 2839 (inside the spec file's header comment):
"NEVER\n// documentElement.scrollWidth here - support/viewport.guard.test.ts
fails the file". `e2e/support/viewport.guard.test.ts:63` does
`readFileSync(file, 'utf8').includes('documentElement.scrollWidth')` over every
`.ts/.tsx/.mjs` under `e2e/`, comments included; only
`support/viewport.ts` is allowed (line 40).

**What it implies.** `npm test` (gate 2, which runs the e2e workspace's
vitest) goes red the moment Task 9 lands. Reword the comment (for example
"never the document-level scroll width idiom").

---

## 7. [MEDIUM] The dashboard test "an audio/mp4 file shows the reject message WITHOUT calling the endpoint" can never fire the change event

**What is wrong.** `userEvent.upload` in user-event 14.6.1 filters files
through the input's `accept` attribute by default
(`dist/esm/setup/setup.js:20` `applyAccept: true`;
`dist/esm/utility/upload.js` `.filter((file) => !this.config.applyAccept ||
isAcceptableFile(file, input.accept))`). `memo.m4a` / `audio/mp4` matches no
token of `audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav`, the file list is empty,
and the "selection unchanged" short-circuit dispatches no change event.

**Evidence (ran).** Plan lines 2286-2292 time out in the run described in
finding 5. With `userEvent.setup({ applyAccept: false }).upload(...)` it
passes (ran).

**What it implies.** Red Task 8 Step 5. If a builder "fixes" it by deleting
the test, spec section 5's client pre-check pin for a non-accepted type is
lost at unit level (the e2e covers the real-browser path, where
`setInputFiles` ignores `accept`).

---

## 8. [MEDIUM] Task 4's happy-path assertions pin the wrong uploader identity

**What is wrong.** Plan lines 968-969 expect `uploadedByUserId: 'user-0001'`,
`uploadedByEmail: 'founder@example.com'`, and line 976 expects audit
`actor: 'user-0001'`. The request carries `TEST_ADMIN_COOKIE`, minted from
`TEST_ADMIN_USER` (`app/test/helpers/authSession.ts:115`), whose identity is
`usr_testadmin000000000000000` / `test-admin@housingchoice.org` (lines 33-37).

**What it implies.** Red on first run for a reason that is not the code. Use
`TEST_ADMIN_USER.userId` / `.email`.

---

## 9. [MEDIUM] Task 6's `leaveVoicemail` does not survive a throwing `fetchStatus`, contradicting both the spec and the plan's own test

**What is wrong.** Plan lines 1926-1931 do `call.voicemailGreetingFetchStatus =
await this.fetchStatus(plan.playUrl)` with no try/catch; only the DEFAULT
implementation (1906-1914) catches. The plan's test (1801-1810) injects
`fetchStatus: async () => { throw ... }` and expects status 0 and a completed
call.

**Evidence.** An engine step failure is swallowed by design
(`fake-twilio/src/engine/callEngine.ts:348`, "a step failure must not leave
settle() hanging"), so the call stays un-completed and the field undefined.
Spec 4.8 (lines 761-762): "records the status, and continues regardless";
spec section 5 (lines 907-908): "proceeds when `fetchStatus` throws (status 0)".

**What it implies.** Task 6 Step 4 ("the whole fake-twilio suite PASS") is
red as written. Wrap the call: `try { ... } catch { status = 0 }`.

---

## 10. [MEDIUM] The Vite dev proxy forces `Connection: close` upstream, so in the e2e lane, local dev and self-QA a refused multi-MB upload is reset exactly as in finding 1; the e2e reject test's body is small enough to hide it

**What is wrong.** `dashboard/vite.config.ts:13-16` defines `appProxy` with no
`agent`; Vite 7.3.5's bundled proxy then sets
`outgoing.headers.connection = "close"` for every proxied request
(`node_modules/vite/dist/node/chunks/config.js:20714-20718`). Every upload
from the browser to the app in the hermetic lane, in `npm run dev`, and in any
self-QA at :5174 therefore reaches Node with `Connection: close`: the finding-1
mechanism.

**Evidence.** Finding 1's table (the app side does not care who set the
header). Plan Task 9 line 2960 sends a ~200 KB renamed M4A; a 256 KiB sniff
refusal survived `Connection: close` 6/6 in my runs, so the e2e passes while
proving nothing about a realistic 1-5 MB memo. The production hop is
CloudFront -> Node with keep-alive (`infra/modules/cloudfront/main.tf:115`
`origin_keepalive_timeout = 5`; no reverse proxy in `infra/`), so production
likely delivers the JSON; how CloudFront relays an early origin response
mid-upload is UNVERIFIED (spec 4.10 already flags the neighbor question).

**What it implies.** Review Focus 1 ("that message must REACH the browser") is
proven only for small files and never through the hop users hit. Worse, an
orchestrator self-QA with a real renamed voice memo through :5174 will see a
network error, conclude the refusal wiring is broken, and "fix" correct code.
The plan should (a) state this in the Task 9 / self-QA notes and the
handback, and (b) either set a keep-alive agent on `appProxy` (a dev-config
change outside the spec's file list, so a planner call) or accept and record
the limitation.

---

## 11. [MEDIUM] A failed Remove shows its error outside the still-open dialog, behind the modal backdrop

**What is wrong.** On a remove failure the plan keeps the dialog open
(`onConfirmRemove` catch, lines 2582-2590) but renders the error as the
block's `<p role="alert">` (2671-2675), i.e. outside the `Modal`, which is a
`position: fixed` backdrop (`dashboard/src/routes/contact/Modal.module.css:3-4`)
with `aria-modal="true"`. The user sees "Removing..." revert to "Remove" with
no visible reason; assistive tech is scoped to the dialog. Spec 4.7 (720-725)
names the ConfirmRemoveDialog shape, whose error renders INSIDE the dialog
(`dashboard/src/routes/settings/ConfirmRemoveDialog.tsx:59-61`).

**What it implies.** A real UX defect with no test to catch it (no
remove-failure case in Task 8). Render `state.error` inside the Modal body
while `confirming`, and add a test.

---

## 12. [MEDIUM] Unenumerated reader: the Voice tab's conditional audio GET is absent from the perf route contract and the endpoint-template registry

**What is wrong.** With a greeting set (the steady production state after the
first upload), `<audio preload="metadata">` issues
`GET /api/settings/voicemail-greeting/audio?v=...` on every Voice-tab load.
The plan adds only `required('/api/settings')` to `VOICE_GETS` (line 2153).
`e2e/performance/templates.ts:20-160` (`ENDPOINT_TEMPLATES`) lists
`/api/calls/:callId/recording` (138) for the analogous recording player but
nothing for the greeting routes, so the request sanitizes to `unmatched_api`
and is undeclared (`e2e/performance/report.ts:316,337` add
`undeclared_background` / `unexpected_endpoint`). Separately, the block's
loading `Spinner` is `role="status"` (`dashboard/src/ui/Spinner.tsx:20`), which
can satisfy `VOICE_TERMINAL`'s `[text 'Your cell', status]` alternative
(`e2e/performance/routes.ts:428-435`) before the now-required `/api/settings`
finishes.

**What it implies.** Not a gate-2 failure (the hermetic perf seed has no
greeting), but `npm run perf:pages -- local|hosted-dev` against any stack with
a greeting reports a contract mismatch on /settings/voice. Spec 4.9's static
surface table missed it too; the plan should add a `conditional` shape and
the two templates, and reconsider the terminal.

---

## 13. [LOW] The S3 adapter's `abortSignal` forwarding is never tested

Plan Task 4 Step 3 changes `S3MediaStore.head` to pass `{ abortSignal }` to
`client.send`, but adds no case to `app/test/mediaStore.test.ts` (its `head`
tests at lines 108-139 use a fake `send` that ignores the second argument).
Tests (a)/(e)/(h) only prove the webhook hands a signal to the harness fake.
Consequence if wrong: an abandoned HEAD holds a pooled socket (spec 4.6), which
is what the change exists to prevent. A two-line fake-client assertion would pin it.

## 14. [LOW] Task 4 imports a helper from another test file

Plan line 867: `import { minimalWav } from './voicemailGreeting.test.js';`.
Importing a vitest module executes its top-level `describe` calls inside the
importer, so every Task 1 suite (including the one that attaches a
process-level `unhandledRejection` listener) runs twice. Move `minimalWav` to
`app/test/helpers/`.

## 15. [LOW] Task 6's "append" block re-imports what the target file already imports

Plan lines 1745-1750 begin with `import { describe, expect, it } from 'vitest'`
and `import { interpretTwiml } ...`; `fake-twilio/test/twimlInterpreter.test.ts`
already has both at lines 1-2. Appended verbatim this is a duplicate-declaration
SyntaxError for the whole file. Say "append the describe only".

## 16. [LOW] The plan cites the spec as DRAFT 2

Plan line 11 says "(DRAFT 2)"; the approved spec is DRAFT 3 (spec line 3). The
plan's mechanics do follow DRAFT 3 (pipe+drain, result-returning lookup, head
signal), but a downstream plan-anchored reviewer is told the wrong baseline.

## 17. [LOW] Task 9 runs Playwright outside the sanctioned entry point

Plan line 2997 uses `cd e2e && npx playwright test <spec>`; AGENTS.md says to
run Playwright only through `npm run e2e`, and `e2e/README.md:68` documents
`npm run e2e -- tests/dashboard-next/<file>.spec.ts` for a single spec.

## 18. [LOW] Spec-required handback content is not tasked

Spec section 3 says assumptions A-H are "flagged for the handback as
questions"; spec 4.10 names two infra facts for the handback (prior versions
persist; CloudFront `origin_read_timeout` during slow uploads UNVERIFIED); spec
section 7 defines the dev check. Task 10 Step 3 says only "hand back with the
outputs quoted". Add finding 10's dev-proxy note to the same list.

## 19. [LOW] The client-side type mapping widens the spec's allowlist

Plan lines 2407-2417 accept `audio/mp3`, `audio/wave`, `audio/vnd.wave` and map
them to canonical types. Spec 4.7 (lines 673-677): use `file.type` "when it is
in the allowlist, else from the extension when `file.type` is EMPTY ..., else
reject". Harmless (the server sniffs), arguably better, but it is an
unannounced deviation a conformance reviewer will flag; either record it as a
deliberate choice or match the spec.

---

## Checked and found correct (so nobody re-litigates them)

- lib-storage 3.1070.0 chunker yields early only when the buffer is STRICTLY
  greater than the part size (`dist-cjs/index.js:90`); a gate-limited body of
  exactly 5 MiB became ONE `PutObjectCommand` (ran), and a gate error before or
  at the cap rejects `done()` with the SAME error instance (`instanceof` held,
  zero commands sent) (ran). The route's classification works on the real
  store, not just the harness fake.
- The plan's gate and `withTimeout` behave as Task 1's tests claim: byte-exact
  pass-through across sub-sniff chunks, `empty`, 2-byte `invalid_format`,
  `too_large` at max+1, timeout rejection, no unhandled rejection from the
  abandoned promise (ran).
- `greetingBeforeRecord` with fast-xml-parser 4.5.6 `preserveOrder` over the
  real twilio 6.0.2 `VoiceResponse` output returns `play` + the entity-decoded
  URL, `say`, `none`, and `play` for Say+Play+Record (ran). `VoiceResponse`
  escapes `&` as `&amp;`, matching Task 5 (a)'s regex (ran).
- The mutation-catalog scanner keys the delegated fetch only on
  `requestWithStatus` + a `buildUrl(...)` first argument
  (`e2e/performance/mutationCatalog.test.ts:158-162`); the plan's hoisted
  `outgoing` does not disturb it, and extra option keys are ignored by
  `methodFromObject` (112-155). 108 -> 110 is right; the new entries' default
  `first_party_api` interception is consistent with `firewall.ts:188-236`.
- `vi.spyOn(serverClock, 'noteServerDate')` does intercept client.ts's call
  under the dashboard's vitest (ran).
- The harness hang-fake shape (`return new Promise(...)` inside the contextually
  typed async `head`) and the exhaustive `switch` without a trailing return
  both typecheck under the repo's strict options (ran with the worktree's tsc).
- `app/tsconfig.test.json` includes `../fake-twilio/src/engine`, so the app's
  typecheck covers Task 6's engine edits; no other workspace constructs a
  `record` TwimlPlan or a `FakeWorld` literal, and every other `MediaStore`
  fake's one-parameter `head` stays assignable.
- `putOrgSettings` has exactly one production caller
  (`app/src/routes/settings.ts:219`); every `getOrgSettings` consumer reads
  named fields; `voice.voicemail_prompt` has exactly one emitter
  (`app/src/routes/webhooks/voice.ts:1875`).
