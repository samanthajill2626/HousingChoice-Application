# Plan review R2 - reviewer A (adversarial, continued)

Plan: `docs/superpowers/plans/2026-09-26-voicemail-greeting.md` DRAFT 2 (commit
87b2f676, plus one uncommitted self-review line in the working tree that is not
mine and changes no step). Spec: DRAFT 3 with the three precision edits.
Inputs read: `plan-r1-adjudications.md`, `plan-r1-reviewer-b.md`, my
`plan-r1-reviewer-a.md`.
Date: 2026-09-26. Node v24.14.1, express 5.2.1, supertest 7.2.2, vitest 3.2.6,
user-event 14.6.1, playwright bundled Chromium, vite 7.3.5.

Method: every "ran" claim is a throwaway probe in my session scratchpad; the
worktree was not touched except for this file. Where I needed the plan's code
under the repo's real harness, I copied the plan's blocks verbatim (only
import specifiers re-pointed to absolute worktree paths) and ran them under
the worktree's own vitest with the app or dashboard as root.

Order: new defects first (1 is new and blocking), then the adjudication
contests, then a list of the round-2 fixes I proved correct.

---

## 1. [BLOCKING] Test (e2) cannot pass: the never-settling settings read hangs the missed-call PUSH before the greeting lookup runs, so the request never returns

**What is wrong.** Test (e2) (plan lines 1695-1716) installs
`world.settingsRepo.getOrgSettings = () => new Promise(() => {})` and then posts
the FIRST no-answer Dial summary. That first delivery transitions the call, so
`/status` awaits `onFounderBridgeMissed(...)` (`app/src/routes/webhooks/voice.ts:1848-1850`)
BEFORE it builds any TwiML. `onFounderBridgeMissed` awaits
`sendMissedCallPush` (`voice.ts:2285`), which awaits `settings.getOrgSettings()`
for the quick replies (`voice.ts:2349-2350`). That read is inside a try/catch,
but a promise that never settles never throws: the push hangs, `/status` never
reaches the greeting code, and the response never arrives. The test dies on
vitest's 60 s `testTimeout` (`app/vitest.config.ts:60`), and it proves nothing
about `withTimeout`.

The adjudication (B10) reasoned that "the router holds the object reference",
so the replaced method is what the router calls. That is correct, and it is
exactly why the test hangs: the push path holds the same reference and calls it
first.

**Evidence (ran).** This is a scratch vitest file under the app root that
reproduces the MISSED describe's `beforeEach` job wiring, `founderHarness`,
`seedRingingBridgeWith` and the (e2) replacement against TODAY's `voice.ts`. The
hang happens before any greeting code would run.
- Control (no replacement): `/status` answered 200 with the spoken prompt in 7 ms.
- (e2) shape: `STILL HANGING after 4000ms`, with zero push sends recorded.
- Redelivery variant: post the no-answer summary once with the real settings,
  THEN install the hang and post the SAME summary again. It answered 200 with
  the prompt in 4 ms. A redelivered summary is not `transitioned`, so it skips
  `onFounderBridgeMissed` (spec section 2 says so; `voice.ts:1845-1850`).

**What it implies.** Task 5 Step 4 cannot go green. The failure mode is a hang
in the one test whose stated purpose is proving `withTimeout`, so a
context-free builder is likely to conclude that `withTimeout` or the webhook is
broken and start editing correct production code. This is the same
misdirection pattern as round 1's supertest finding. Fix: drive (e2) on a
redelivered summary. Post the miss once normally (this first post legitimately
offers `<Play>`, so scope the assertions to lines logged after it), install
the never-settling read, then post the identical summary again. The greeting
lookup's settings read is then the only read in flight, and only
`withTimeout` can end it (`exceeded 50ms`). The alternative is a harness seam
that hangs only the Nth `getOrgSettings` call. Note the knock-on: in the fixed
test `world.mediaHeads` holds ONE entry (from the first post), not zero.

---

## 2. [MEDIUM] The only production proof of Review Focus 1 has no scheduled check, and the spec's new sentence says the one environment that can settle it cannot

**What is wrong.** Spec 4.3's new local-dev paragraph ends: "Production is
CloudFront -> origin over persistent connections and is expected to deliver
the JSON (UNVERIFIED; a dev-stack call cannot settle it because dev also
fronts with CloudFront - it is the Vite proxy that is absent there)." The
reasoning is inverted. Dev and prod both front with the same CloudFront module
(`infra/envs/dev/stack.tf` and `infra/envs/prod/stack.tf` both instantiate
`module "cloudfront"`; `origin_keepalive_timeout = 5`,
`infra/modules/cloudfront/main.tf:115`). The deployed dev stack is therefore
exactly the path production uses, and the one place where "a multi-MB renamed
M4A gets the M4A message" can be observed. Task 10 Step 3 item 3 carries it only
as UNVERIFIED. Section 7's dev script (Task 10 item 5) uploads a good greeting
and optionally a bad WAV, but never a server-side refusal of a large body.

**What it implies.** Review Focus 1, the plan's first review focus and the
scenario decision 1's message exists for, ships with its production half never
tested. Add one step to the section 7 dev check (and to handback item 5): on
the dev dashboard, rename a 3-4 MB M4A to `.mp3`, upload it, and expect the M4A
message rather than "Couldn't upload the greeting". Also correct the
parenthetical: dev is where the question CAN be settled; local dev is where it
cannot.

---

## 3. [LOW] A stale upload error appears INSIDE the Remove dialog

**What is wrong.** When the dialog is open, the block renders `state.error`
inside the Modal (plan 2920-2924). Nothing clears an UPLOAD error when the
dialog opens: `remove()` clears `error` only when Remove is clicked (2724-2726),
and "Remove greeting" only does `setConfirming(true)` (2868).

**Evidence (ran).** I appended a probe case to the plan's own Task 8 test file,
run verbatim against the plan's block and hook: admin, greeting set, choose an
M4A through Replace (the reject alert shows), click "Remove greeting". The
dialog then contains one alert with the text "Upload an MP3 or WAV file. iPhone
voice memos are M4A; export or convert the recording first."

**What it implies.** The confirm dialog for a removal opens with an unrelated
upload refusal inside it. Clear the error when the dialog opens (a `clearError`
on the hook, or show the in-dialog alert only when the error came from
`remove`), and pin it with the probe above as a test.

## 4. [LOW] The upload route's block comment still says the chunked over-cap body is destroyed after the response flushes

Plan lines 1335-1340, inside the code the builder will commit, say "the one
unbounded shape - a chunked body over the cap ... - is destroyed after the
response flushes". Twelve lines later the code drains (1383-1390), and spec 4.3
now says drain. The comment sits on the most-reviewed mechanism in the feature
and states the variant two reviewers measured to reset the client. Rewrite it
to match the drain.

## 5. [LOW] Each keep-alive large-body refusal test costs about 6 s

**Evidence (ran).** I ran the plan's route replica and the plan's
`request(app)...set('connection','keep-alive')` pattern, 3 runs each:

| case | result |
|---|---|
| 3 MiB sniff refusal | 400 in 6044, 6014 and 6021 ms |
| 6 MiB Content-Length 413 | 413 in 6015, 6020 and 6015 ms |
| 4 KB happy path | 200 in 2-3 ms |
| the plan's raw chunked test (`app.listen(0)` + `server.close` awaited) | 413 in 12-17 ms, close 0-1 ms |

supertest closes its per-request server as soon as the response ends, while
the server is still draining the body. The connection is not idle at
`close()`, so close waits Node's 5 s `keepAliveTimeout` plus its 1 s buffer. The
four refusals in Task 4 (the 3 MiB, the 6 MiB, and two inside the refused-replace
test) add about 24 s to gate 2. That is not a failure (60 s budget), but it is
worth either one line in the plan or a shared listener whose connections are
closed in `finally` (`server.closeAllConnections()`).

## 6. [LOW] The client-side MIME aliases the spec now names are untested

Spec 4.7 (edit) now names `audio/mp3` -> `audio/mpeg` and `audio/wave` /
`audio/vnd.wave` -> `audio/wav`. `greetingContentTypeFor` (plan 2613-2623)
implements them, but no Task 8 case exercises an alias (grep: the strings
appear only in the implementation). One `it` covering `new File([...], 'a.mp3',
{ type: 'audio/mp3' })` -> `uploadVoicemailGreeting(..., 'audio/mpeg')` pins it.

## 7. [LOW] The "unbounded" chunked drain is bounded at 300 s by Node's default, and the plan and spec should say so

`app/src/index.ts:150-152` sets only `keepAliveTimeout` (65 s) and
`headersTimeout` (66 s). Node 24's default `server.requestTimeout` is 300000 ms
(ran: `http.createServer().requestTimeout === 300000`). A chunked drain therefore
ends after 5 minutes at most per request, not never. Spec 4.3 and handback item 4
call it unbounded. Saying "bounded at 300 s by Node's default requestTimeout"
is both more accurate and a guard: nobody should later "fix" a slow upload
by setting `requestTimeout = 0`, which would make the drain truly unbounded.

## 8. [LOW] The file maps are stale

The top-level File map (plan 38-58) omits three things round 2 added:
`app/test/helpers/audioFixtures.ts` and `app/test/mediaStore.head.test.ts`
(both created), and `e2e/performance/templates.ts` (modified). Task 7's Files
header (2117-2120) also omits `templates.ts`, although its Step 4 edits it and
its commit adds it. Plan-anchored reviewers read the map first.

## 9. [LOW] One cosmetic lint warning

I linted the plan's `app/src/lib/voicemailGreeting.ts` through
`npx eslint --stdin --stdin-filename app/src/lib/voicemailGreeting.ts` from the
worktree root. It reports one warning: "Unused eslint-disable directive (no
problems were reported from 'no-control-regex')". The rule is not enabled
(`tseslint.configs.recommended` does not include `eslint:recommended`).
It is a warning, not a gate-5 error; drop the directive.

---

## Contesting the adjudications

**Drain instead of destroy for the chunked case (B2/A2): DEFEND, with a
stronger bound.** Drain is the only posture that delivers the 413 (ran: drain
413 6/6; destroy-after-finish ECONNRESET 6/6 and 10/10 in round 1), and it is
time-bounded, not unbounded (finding 7). Keep it.

**Vite proxy limitation accepted as local-dev-only (B11/A10): DEFEND the
classification; CONTEST the verification story.** Vite 7.3.5's bundled proxy
forces `connection: close` whenever no agent is configured
(`node_modules/vite/dist/node/chunks/config.js:20714-20718`), and
`dashboard/vite.config.ts:13-16` configures none. Production has no Vite hop.
The limitation is real and local. But the spec text then claims the deployed
dev stack cannot settle production behavior, which is wrong (finding 2).
Aside, not a finding for this plan: the comment at `app/src/index.ts:115-122`
says "the Vite dev proxy pools sockets to this server"; with no agent it
opens a fresh `Connection: close` socket per request.

**VOICE_TERMINAL left alone (B13/A12): CONCEDE.** An early terminal cannot
skip the new required GET. Readiness waits for `pendingCount === 0` over every
tracked first-party GET (`e2e/performance/readiness.ts:117-123`;
`collect.ts:441,547`, where every first-party GET not classified as
background is `required` and tracked). The Spinner's `role="status"` cannot end
a sample early. I also checked the one way the new conditional audio GET could
wedge readiness, a `preload="metadata"` request that never finishes. With
bundled Chromium against a local server that honors Range, a 3 MB MP3 and a 3 MB
WAV each got `requestfailed net::ERR_ABORTED` after metadata (readyState 4),
and a 4 KB WAV got `requestfinished` (ran). CDP's `loadingFailed(canceled)`
removes the request from in-flight (`collect.ts:468-470`), so readiness does
not hang.

---

## Round-2 fixes: checked and correct (so nobody re-litigates them)

- **Task 4 keep-alive helper:** turns the 3 MiB sniff and 6 MiB 413 refusals
  into 400/413 JSON (ran, 3/3 each; slow, per finding 5). The raw
  `http.request` chunked test, exactly as written (`app.listen(0)`,
  synchronous `address()`, keep-alive, two writes, awaited `server.close`),
  gets the 413 JSON with the drain in place (ran, 3/3).
- **Task 8, verbatim under the dashboard's vitest:** all 11 block tests pass,
  including the new failed-Remove test (one alert, inside the dialog). The
  `applyAccept: false` setup, the plain-div wrapper and the in-dialog error all
  work. I also mounted the block in a copy of `VoiceSection.tsx` and ran
  `VoiceSection.test.tsx` with the plan's `getSettings` mock: 9/9 pass, existing
  assertions untouched (ran).
- **Lint on the new material:** `useVoicemailGreeting.ts`,
  `VoicemailGreetingBlock.tsx`, `VoicemailGreetingBlock.test.tsx`,
  `serveMediaObject.ts`, `mediaStore.head.test.ts`, `audioFixtures.ts` and
  `voicemailGreeting.test.ts` lint clean at their target paths through
  `eslint --stdin`, react-hooks v7 rules included (ran). The one warning is
  finding 9.
- **Task 7 perf contract:** copied `e2e/performance/*` plus the two dashboard
  files `routes.test.ts` reads, and applied the Step 4 edits (`VOICE_GETS` with
  `conditional('/api/settings/voicemail-greeting/audio', ['v'])`, the two
  `ENDPOINT_TEMPLATES` entries, the `'...?v#conditional'` string, and the
  `; dashboard/src/routes/settings/useVoicemailGreeting.ts:1-40` citation
  suffix). With the edits, `routes.test.ts` (24), `redact.test.ts` (92) and
  `firewall.test.ts` (19) pass (ran). The citation suffix matches the format
  regex at `routes.test.ts:420`.
- **Mutation scanner vs the new client test:** `sourceFilesUnder` skips
  `*.test.ts` (`e2e/performance/mutationCatalog.test.ts:35`), so the new
  `request('/api/x', { method: 'PUT', ... })` call in
  `voicemailGreeting.client.test.ts` is not discovered, and the count stays 110.
- **Task 6:** the file-handling instruction now matches reality
  (`fake-twilio/test/twimlInterpreter.test.ts` exists and already imports both
  bindings; `REC` and `wrap` collide with nothing). The try/catch around an
  injected `fetchStatus` delivers status 0 and a completed call, since engine
  step failures are otherwise swallowed at `callEngine.ts:345-349`. Trivial:
  `makeEngine`'s new third parameter needs a `type CallEngineDeps` import the
  step does not mention; tsc will name it.
- **Task 5 (g):** mirrors the existing masked-miss case
  (`founderTriage.test.ts:1035-1062`) and runs in the right scope.
  `founderHarness(world, opts)` / `seedRingingBridgeWith(opts)` reproduce the
  holder wiring (probe: the miss reaches the voicemail branch in 3-7 ms). I ran
  these helpers from a scratch copy and did not compile them in place, so their
  types are UNVERIFIED. (e2) is finding 1.
- **Log guard:** the new route and webhook log calls put errors only under the
  wired `err` key. `reason: 'client_aborted'` is a wired serializer key
  carrying a plain string, which passes through untouched
  (`app/src/lib/logSerializers.ts:28`; serializer described at
  `app/src/lib/logger.ts:180-191`). `logCallSiteGuard.test.ts` flags nothing
  new, and the serializer keeps `message` (`logSerializers.ts:56`), which is
  what (e2)'s `exceeded 50ms` assertion reads once finding 1 is fixed.
- **No other surfaces touched by the changes:** there is no WAF or edge
  function on `/api/*` (no `wafv2` / `function_association` in `infra/`). The
  dashboard service worker has no fetch handler. No existing voice test
  overrides `getOrgSettings`, so no WARN-count assertion elsewhere picks up
  the new lookup.
