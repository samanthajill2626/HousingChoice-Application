# Planner review - adversarial, round 2 (bounded re-review of the fix wave)

Reviewer: the same plan-blind adversarial reviewer as round 1.
Scope:
- the fix-wave commit `1f7e99b4` on `feat/voicemail-greeting` (previous tip `e271acd2`);
- the whole changed state around it;
- `planner-review-adjudications.md` and `planner-review-conformance.md`.

Order, as asked: (1) new problems in the changed state, (2) the fix diff
itself, (3) contested adjudications, (4) whether the fixes are real.

Severity key: MUST = a defect a user or an attacker can hit; SHOULD = a real
weakness worth fixing before merge; NOTE = worth a sentence.

Result: 0 MUST, 1 SHOULD, 9 NOTE. The SHOULD is new. The fix wave made the
round-1 defect's message wrong in its OTHER reachable case.

What I ran against `1f7e99b4`, from the worktree, with the tree still clean
afterwards:
- `app` vitest on `voicemailGreetingRoutes.test.ts` + `founderTriage.test.ts`:
  88/88 passed.
- `dashboard` vitest on `VoicemailGreetingBlock.test.tsx` +
  `voicemailGreeting.client.test.ts`: 32/32 passed.
- `tsc --noEmit` on `dashboard/tsconfig.json` and `app/tsconfig.test.json`:
  exit 0.
- `npx eslint` on the six touched code and test files: exit 0.

Probe scripts live in the session scratchpad only.

---

## 1. [SHOULD] The new `greeting_record_failed` message is FALSE for a first upload: it says "Callers hear the new greeting" when callers hear the built-in prompt

**What is wrong.** The fix maps `greeting_record_failed` to one fixed string
(`dashboard/src/routes/settings/useVoicemailGreeting.ts:28-29`; its JSDoc at `:24-27` makes the same claim, "the greeting callers hear IS the new file"):

> "The file was stored, but its details couldn't be saved. Callers hear the new
> greeting; upload it again to fix the name and date."

The route answers that code in two states: a REPLACE (an old record exists) and
a FIRST upload (no record). Only in the replace case do callers hear the new
file. On a first upload the record stays absent. The webhook then stops at
`if (org.voicemailGreeting === undefined) return { kind: 'absent' }`
(`app/src/routes/webhooks/voice.ts:398`). It never HEADs or presigns the fixed
key, and the caller hears the spoken prompt.

The new route comment carries the same error. `app/src/routes/settings.ts:416-420`
says "the record is absent (a first upload) or STALE (a replace ...). The webhook
offers the fixed key, so callers hear the new file either way". That is not true
"either way".

**Evidence (reproduced end to end, real router + real webhook via the harness).**
First upload with `putOrgSettings` throwing, then a missed business-line call:

```
first upload: 500 {"error":"greeting_record_failed"} | object stored: true | record: undefined
missed call TwiML has <Play>: false | has the SPOKEN prompt: true | HEADs made: 0
```

The dashboard contradicts itself on the same screen. I rendered the hook under
jsdom with a stubbed `fetch`. After the failed first upload and the re-fetch,
the state is `greeting=none` plus the alert text above. The block therefore
renders "No greeting uploaded - callers hear the built-in prompt."
(`VoicemailGreetingBlock.tsx:88`) directly above an alert saying "Callers hear
the new greeting".

**What it implies.** This is round 1's AD1 defect inverted: the admin is again
told the opposite of what callers hear. The trigger is the same: a DynamoDB
write failure after a successful PutObject. A first upload is not rarer than a
replace. Every org's first greeting goes down this path.

Three more records now describe only the replace case:
- the adjudicated wording, which differed from what shipped: "Reload the page
  to check what callers hear", `planner-review-adjudications.md`, AD1 (see
  finding 5);
- the commit message ("tells the admin the file is live");
- the handback addendum (`handback.md`, "tells the admin the file IS live").

**Fix (small).** Pick the message by the case:
- the hook already computes `replacing` (`useVoicemailGreeting.ts:143`); or
- decide after the re-fetch lands: a record present means the new file is live,
  none means the built-in prompt; or
- ship the adjudicated neutral wording.

Then correct `settings.ts:416-420`. Pin it with a block test whose initial GET
has NO greeting and whose upload rejects `greeting_record_failed`. Today's test
seeds a greeting (`VoicemailGreetingBlock.test.tsx:280`) and so cannot see this.

---

## 2. [NOTE] The re-fetch is not fenced: a Remove or Replace made while it is in flight is overwritten by its stale response

**What is wrong.** On `greeting_record_failed` the hook fires `void load()`
(`useVoicemailGreeting.ts:154`) and then immediately sets `busy` false
(`:156`). `load` never sets `status` to `'loading'`: only the mount effect and
`retry` do (`:117`, `:123`). So Replace, Remove and the file input are all live
while the re-fetch GET is outstanding. Neither `upload`'s success path (`:147`)
nor `remove`'s (`:166`) aborts `abortRef.current`. Whichever finishes last
writes `greeting`.

The block's own comment names this exact hazard for the initial GET: "an input
present during the initial GET would let a keyboard user start an upload that
the GET's stale response then overwrites" (`VoicemailGreetingBlock.tsx:151-156`).
The re-fetch reintroduces it.

**Evidence (reproduced; hook under jsdom, re-fetch held open, then Remove).**

```
after failed upload: busy=false status=ready error="The file was stored, ..." greeting=A-old.mp3 (re-fetch pending: true)
after Remove succeeded: greeting=none notice="Greeting removed."
after the stale re-fetch lands: greeting=A-old.mp3 notice="Greeting removed." error=null
```

The server holds no greeting, yet the block shows A with a player that 404s. The
"missing file" line appears under a "Greeting removed." notice. A Replace in the
same window loses the same way: its new record is overwritten by the pre-upload
read.

**What it implies.** Display-only, fixed by a reload. The window is one GET, but
the trigger is a DynamoDB write failure, which is exactly when that GET is
likely to be slow. It is a one-line fix in the same branch as finding 1, so
fold it in:
- use `retry()` (set `'loading'` then `load()`), which also unmounts the input;
  or
- abort `abortRef.current` at the start of `upload` and `remove`.

## 3. [NOTE] The block test does not prove the re-fetch is rendered; only that a second GET was issued

`VoicemailGreetingBlock.test.tsx:279-290` does two things:
- It mocks `getSettings` to return the SAME greeting (`sam-greeting.mp3`) for
  both calls (`:280`).
- It then asserts `getByText('sam-greeting.mp3')` and the absence of
  `new-file.mp3` (`:288-289`).

The failure path never calls `setGreeting` (`useVoicemailGreeting.ts:149-154`).
The hook never renders the chosen file's name optimistically either. So both
screen assertions hold before the re-fetch resolves, and they would hold with
the re-fetch's result thrown away. The probe shows it: the state right after the
failed upload, re-fetch still pending, is already `greeting=A-old.mp3`, the
initial record.

Also, `waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2))` (`:287`)
passes as soon as the call STARTS, before its response renders. A mutation of
`void load()` into `void getSettings()` (fetch and discard) would pass every
assertion. That is by inspection; I did not run the mutation, because doing so
needs an edit in the worktree.

To prove it, the second response must DIFFER from local state and the test must
`await findBy...` the second state. Finding 1's first-upload case is the natural
one: the first GET returns A, the second returns none. This is a
`mockResolvedValueOnce` chain.

## 4. [NOTE] `serveMediaObject` serves the store's Content-Type verbatim, the same pattern `media-serve-stored-xss` removed from the MMS route; it is safe today only because both writers canonicalize

`app/src/routes/serveMediaObject.ts` sets `Content-Type` to
`object.contentType ?? opts.defaultContentType` on the dashboard origin. It sets
no allowlist, no `Content-Disposition` and no CSP sandbox. The MMS route got all
three after a stored XSS (`docs/issues/media-serve-stored-xss.md`; `api.ts:2380-2388`
uses `resolveMediaTier(...)`, a canonical type and `mediaCspFor`).

Both current callers are safe:
- Recordings are mirrored with a hardcoded `audio/mpeg`; the issue's "Not
  affected" paragraph covers them.
- The greeting upload stores only the canonical `audio/mpeg` or `audio/wav`
  (`settings.ts:369`, via `normalizeGreetingContentType`). The app-wide nosniff
  is also in force.

But the helper was extracted to be REUSED, and nothing in its contract says the
caller must guarantee the stored type. It will rot the day a third caller serves
a key whose type came from outside. Fix: document the precondition in the
`ServeMediaObjectOptions` JSDoc, or clamp to an `audio/*` allowlist, falling
back to `defaultContentType`. Round 1 and the conformance review both missed
this.

## 5. [NOTE] The records now disagree with the code and with each other

- **Wording.** AD1 adjudicated the message "... Reload the page to check what
  callers hear." The code ships "Callers hear the new greeting; upload it again
  to fix the name and date." The adjudicated text would have been TRUE in both
  cases. The shipped text is not (finding 1).
- **Verdict file.** `planner-review-adjudications.md:7` and `handback.md:282`
  point to `planner-review-verdict.md`, which does not exist at `1f7e99b4`. It
  may still be pending; if so, ignore this.
- **Count erratum (mine).** My round-1 header said "0 MUST, 1 SHOULD, 11 NOTE",
  and so did my returned summary. The body has 13 NOTEs (items 2-14). The
  adjudications count 13 correctly.

## 6. [NOTE] The fix wave re-staled the perf ledger citation that FW8 had just fixed

`e2e/performance/routes.ts:705` cites `useVoicemailGreeting.ts:92-112` for the
Voice tab's GET. The fix inserted six lines above `load`: the new constant at
`:24-29`. So `:92-112` now spans the `useState` declarations and half of
`load`. The cited code is at `:100-120`. It is cosmetic, but the build spent a
commit on exactly this (`359cda92`, FW8).

---

## Contested adjudications

## 7. [NOTE] AD4 (no greeting length limit, deferred) - I accept the deferral; one input Cameron should get with it

I do not contest deferring a product call. The adjudication gives Cameron no
yardstick, so here is one:
- The CALLER's own message is capped at `VOICEMAIL_MAX_LENGTH_SECONDS = 120`
  (`voice.ts:295`).
- The greeting it precedes can run about 327 s as 8 kHz PCM WAV, or about 5.5
  minutes as MP3, within the 5 MB cap.
- The spoken prompt it replaces is one sentence (`messages/catalog.ts:714-717`).

Decision 5 (spec, lines 244-245) freezes "the recording length", not the
greeting length, so nothing already decided covers this.

Mitigation that exists: the in-page `<audio controls>` shows the admin the
duration. A zero-risk interim step that needs no decision: one clause of helper
copy ("keep it short - callers hear all of it before the beep").

## 8. [NOTE] AD6 (persistent failure is WARN-only, deferred) - the level is Cameron's, but the trade-off handed to him is mis-stated

Decision 3 (spec, lines 234-240, Cameron's own words) says the webhook "logs a
WARN" when the check fails, so the LEVEL is not the planner's to change. I do
not contest that.

I contest the framing. AD6 and assumption F present it as "no warn flood on the
default state vs. no alarm on a broken greeting". The default state, no
greeting, returns at `voice.ts:398`, before every WARN branch. So an alarm on
the failure branches can never fire on the default state. It can only fire when
a SET greeting keeps failing, which is exactly what an alarm is for.

The choice Cameron actually faces is "alarm or no alarm on a broken greeting",
not "alarm vs. warn flood". An option that keeps decision 3 literal: a CloudWatch
metric filter plus alarm on the two WARN messages
(`voice.ts:430,441`; infra, human-run).

## 9. [NOTE] AD7 (uploader email shown to VAs, kept) - no decision requires it, and it is the first VA-visible staff email in the app

The decisions ask for less than was built:
- Decision 4 (spec, lines 241-244) asks the page for "the current greeting's
  name and upload date".
- Decision 2 asks only to STORE the uploader.
- "Uploaded <date> by <email>" for every role is assumption B's addition
  (spec, lines 254-256), rendered at `VoicemailGreetingBlock.tsx:101` and
  shipped to VAs in `GET /api/settings`.

AD7's "staff-facing, same org" misses that the only other surface with staff
emails, the team list, is deliberately admin-only (`app/src/routes/adminUsers.ts:74`).
My dashboard and app greps found no other VA-visible staff email. Keeping it is
defensible, but "no change" is a choice, not a requirement. The cheap
alternative is to render "by <email>" only when `isAdmin`, and/or leave
`uploadedBy*` out of the VA wire shape.

Not contested: AD3, AD5, AD8, AD9 (verified filed:
`media-serve-client-abort-leaves-body-open`), AD10-AD14.

---

## 10. [NOTE] Are the fixes real? Mostly yes; one comment and one message are not (finding 1)

- **Sniff comment** (`voicemailGreeting.ts:51-58`): TRUE now. Round-1 probe:
  ID3+ADTS passes, bare ADTS is refused.
- **Sanitizer comment** (`:153-155`): TRUE now; it matches the probe (C1, bidi,
  LS and ZW are kept).
- **Route record-failure comment** (`settings.ts:416-424`): TRUE for a replace,
  FALSE for a first upload (finding 1).
- **Post-audit comment** ("LIVE (the object is stored and the record now
  matches it)"): TRUE.
- **Route test** `a replace whose record write fails` (`voicemailGreetingRoutes.test.ts`,
  new `it` after the audit-failure case): REAL.
  - It passes and pins new bytes, the old record and ONE ERROR, then the repair.
  - It cannot leak into siblings. Each `it` builds its own `makeWebhookHarness()`
    (own world, repo, router and rate limiter), and the `finally` restore is
    belt-and-braces on a world nothing else sees.
  - Its three uploads stay under the 10/min limiter.
- **founderTriage (e) wording pin**: correct. Its causal comment ("its `err` is
  the AbortError") is also TRUE: 20 of 20 probe runs logged `AbortError`,
  because the abort timer precedes `withTimeout`'s equal timer and the
  rejection settles in the microtasks between them, so `.finally` clears the
  second timer. It is not asserted, though. `expect(warn.err.name).toBe('AbortError')`
  would make the comment a pin. The existing `.signal === true` assertion
  already catches a dropped signal.
- **CF7 exact-message pin**: REAL.
- **CF9 issue refs**: `settings.ts:369`, `:414` and `:445` now point at the put,
  the record SET and the record REMOVE. Correct.
- **CF11 spec G**: the text now matches the ~2x peak.
- **Dashboard mapping + re-fetch**: the mapping is real, the message is wrong
  for first uploads (finding 1), the re-fetch is unfenced (finding 2), and the
  block test does not prove it (finding 3).
- **`load` stale in the closure?** No. `load` is `useCallback(..., [])` over
  setters and `abortRef` only (`useVoicemailGreeting.ts:100-113`), so `upload`'s
  `[greeting, load]` dependency adds no staleness.
- **Notice race?** No. `notice` is cleared at `upload` start (`:129`) and
  untouched by the failure path and by `load`. The only race is on `greeting`
  (finding 2).
