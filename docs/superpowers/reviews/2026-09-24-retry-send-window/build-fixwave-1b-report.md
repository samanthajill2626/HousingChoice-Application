# Retry send window build - fix wave 1b report

Implementer: the fix wave 1b implementer (Claude Opus 5.5), 2026-09-26.
Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`, from
`5aa7d1db` (clean) to `3b081fdb`, plus the commit that adds this report.
Instruction list: `build-rereview-adjudications.md` (this folder), section "Fix
wave 1b" and rows 4.1, F1 and N1; the brief (`.superpowers/sdd/fixwave-1b-brief.md`)
added specifics. The two never conflicted. Test and docs only: no production
code changed (`git diff 5aa7d1db..3b081fdb -- app/src dashboard/src` is empty).

Raw logs are under the worktree's gitignored `.superpowers/sdd/fixwave1b-*.log`;
everything that matters from them is quoted below. Console glyphs in the logs
(check marks, the ellipsis, an arrow, middle dots) are transcribed as ASCII.

## Verdicts

| Item | Verdict | Commit | Where (live, at `3b081fdb`) |
| --- | --- | --- | --- |
| 4.1 | DONE | `ac61485e` | `app/test/relayRetryClaim.webhook.test.ts:1028` (root captured), `:1060-1067` (comment + assertion) |
| F1 | DONE | `3b081fdb` | `docs/issues/one-to-one-retry-promise-outlives-job-decline.md:48-85` |
| N1 | DONE, one wording precision (below) | `3b081fdb` | `docs/issues/optional-call-outcome-breaks-already-loaded-bundles.md:9-10` (frontmatter), `:50-91` (note) |

## Per item

### 4.1 - the root slot on a versioned claim-time GATE decline

In "retry-send-window D3: a TEAM send declined at the claim keeps its mirrored
shape and its gate code" (seeds `versioned: true`, an outbound team original,
Bob removed from the roster), the root is now captured from `seedSource(...)`
and the case ends with a one-line comment citing spec section 6 intention 2
("the slot on the root is unchanged in every case") and:

`expect(slotOf(root)).toEqual({ status: 'undelivered', requestedTransport: 'sms', transportAggregationState: 'attempted', errorCode: '30003', sentAt })`

This is the C4 versioned window literal (`:1125-1135` now), and it holds for
this case too: the outbound team shape changes nothing on the root slot.

- With the assertion, before any mutant (`fixwave1b-claim-assert-added.log`):
  EXIT=0, "Test Files 1 passed (1)", "Tests 54 passed (54)".
- Mutant (re-review section 4.1), in `app/src/routes/webhooks/twilio.ts` step
  8a, inserted just before `announceRootClaim();` in the `if (decline !==
  undefined)` exit. The local names were exactly the re-review's, so no
  adaptation was needed:
  `if (decline !== RETRY_WINDOW_CLOSED_CODE) await messages.setRecipientActualTransport(ptr.conversationId, rootTsMsgId, ptr.memberKey, 'sms');`
  Result (`fixwave1b-claim-mutant.log`): EXIT=1, "Tests 1 failed | 53 passed
  (54)". The one failure is the team case, at the new assertion:
  ```
  FAIL test/relayRetryClaim.webhook.test.ts > relay 30003 retry claim (POST /webhooks/twilio/status) > retry-send-window D3: a TEAM send declined at the claim keeps its mirrored shape and its gate code
  AssertionError: expected { status: 'undelivered', ...(5) } to deeply equal { status: 'undelivered', ...(4) }
  +   "actualTransport": "sms",
  > test/relayRetryClaim.webhook.test.ts:1061:26
    1061|     expect(slotOf(root)).toEqual({
  ```
  The four legacy rung-1 gate cases still pass under the mutant, as the
  re-review said: `setRecipientActualTransport` is a no-op on a legacy row.
- Reverted with the Edit tool. `git diff -- app/src` then printed nothing.
  Re-run (`fixwave1b-claim.log`): EXIT=0, "Test Files 1 passed (1)", "Tests 54
  passed (54)".
- `npm run typecheck` (`fixwave1b-typecheck.log`): EXIT=0.
- `npx eslint app/test/relayRetryClaim.webhook.test.ts` (`fixwave1b-lint.log`):
  EXIT=0, no output.
- No `[dynamoAdmin]` line in any `fixwave1b-*.log` (count 0 in all six).

### F1 - the issue's spec-coverage claim

The paragraph that began "**Accepted for `feat/retry-send-window`, on
purpose.**" (old `:48-56`) is replaced by `:48-85`:

- `:48-52` - section 9's "A promise with nothing behind it" accepts only PART of
  the class; cites re-review F1 (`build-rereview.md`) and
  `build-rereview-adjudications.md`.
- `:54-62` - (a) accepted by section 9: the breaker at send time, a failed-read
  fail-open the job then refuses, the D4 window at send time (a late job), a
  provider send failure; plus a parenthesis naming section 9's two webhook-side
  cases (not job exits).
- `:63-77` - (b) newly found, not covered, not ruled: a refusal whose cause
  arose during the 60-240 s backoff after successful reads (STOP, the kill
  switch, manual mode on an automated original's thread, a soft-delete, a
  person's original losing its consent), plus the original-missing /
  not-outbound exits; Cameron's call; his spec-gate answer 3 bears on it, cited
  as the spec's summary (spec section 0) with his own words at `rulings.md`
  answer 3.
- `:79-85` - FILE is the build's recommendation for both groups, with the reason
  (new worker writes and emits after the execution marker, beyond the approved
  spec, at most about 3 minutes on rare exits); cites adjudication A2 in
  `build-review-adjudications.md` and its correction by row 4.2 of
  `build-rereview-adjudications.md`.

Evidence each claim was checked against:
- Spec section 9 (`docs/superpowers/specs/2026-09-24-retry-send-window-design.md:811-824`)
  lists six cases: the breaker at send time, a failed-read let-through the job
  refuses, the job's D4 decline, a provider send failure, an enqueue failure
  whose correction write also failed, and a crash or throw between the stamped
  write and the enqueue. None of group (b) is listed.
- D3a (`:238-239`): "The breaker is the one refusal the arm cannot preview" -
  quoted in (b) as true only at decision time.
- The five group-(b) causes are exactly the send path's previewed gates,
  `app/src/services/sendRefusalPreview.ts:51` (kill switch), `:58` (opt-out),
  `:64` (soft-deleted), `:66` (consent, a person's send only), `:69` (manual
  mode, an automated send only).
- Backoff 60, 120, 240 s: `app/src/jobs/retrySend.ts:53-56`; cap 3 at `:51`.
- Spec-gate answer 3: the spec's summary at `:43-44`; his words at
  `rulings.md:54-57`.

Every other sentence of the file was checked for the same overstatement (a claim
that the spec accepted or ruled something). None makes one: the title, the
Problem paragraphs and bullets (`:12-34`), the reproduction (`:36-46`), the
relay paragraph (`:87-91`, its D7 claim matches spec `:294-297`) and the
Suggested fix (`:93-103`, unchanged). Kept verbatim.

Observations, deliberately NOT changed (the brief said keep the rest of the
file and the Suggested fix):
- The Problem bullet at `:22-24` names four refusal causes and omits the
  soft-delete and lost-consent refusals; the new group (b) names them.
- The two group-(b) exits on the original run BEFORE the job's execution marker
  (`app/src/jobs/retrySend.ts:174-182`; the marker is at `:209-218`), so the
  kept Suggested fix ("On every no-send exit after the job's execution
  marker") does not literally reach them. Whoever builds the fix should decide
  whether they need it.

### N1 - dated note on `optional-call-outcome-breaks-already-loaded-bundles`

- Frontmatter: `updated: 2026-09-26` added after `created:` (`:9`); the branch
  spec appended to `refs:` (`:10`). `status: open` and `severity: med`
  unchanged.
- Note "**UPDATE 2026-09-26 (`feat/retry-send-window`).**" appended (`:50-91`):
  three already-loaded-bundle effects, then "A reload fixes all three, and
  nothing forces one", with the build-stamp check named as the class fix and
  the N1 adjudication's deploy-note line.

Base-code evidence (`git -C W:/tmp/retry-send-window show da04d0cb:<path>`):

1. Raw `retry_window_closed` on a window-declined relay leg.
   - `dashboard/src/routes/contact/relayRetryJoin.ts:410`
     `const closeCode = last?.leg.errorCode;` and `:413` spreads it onto the
     leg as `errorCode`. A closed rung counts as terminal:
     `isRetryRungTerminal` (`:175-179`) tests `TERMINAL_RUNG_STATUSES`
     (`:90-93`: delivered, undelivered, failed). The base file never mentions
     `retry_window_closed` (grep exit 1); the branch handles it at
     `relayRetryJoin.ts:104`, `:424`.
   - `dashboard/src/routes/contact/deliveryStatus.ts:913-935`
     `INTERNAL_CODE_REASONS` holds `contact_opted_out`, `transient_cap`,
     `enqueue_failed` and the four `retry_*` gate codes - no
     `retry_window_closed`.
   - `deliveryStatus.ts:1007` is the raw template, `Delivery failed (error
     ${errorCode})`.
   - Server side at HEAD: the claim writes the code at `twilio.ts:2880`; the
     job at `relayRetryLeg.ts:593`, `:681`, `:730`. The re-review's probe
     output (N1) matches this reading.
2. "will retry" on every 30003 outside a relay leg.
   - `deliveryStatus.ts:778`, the base map's 30003 entry, reads "Phone
     unreachable", an em dash, then "will retry". The relay map at `:860`
     reads plain "Phone unreachable".
   - `dashboard/src/routes/contact/Timeline.tsx:980`:
     `deliveryReason(msg.error_code, { media: isMms })`, with no retry
     condition.
3. Retry during a live promise; a press gets 409 and generic copy.
   - `Timeline.tsx:1341` `{delivery?.isFailure && onRetry ? (` - no promise
     condition.
   - `:2400-2405` routes a press's rejection into
     `setSendError(sendFailureMessage(err))`.
   - `sendFailureMessage` (`:86-131`) has no `retry_pending` case (grep exit
     1) and falls to the generic copy at `:130`.
   - The 409 is the branch's route guard, `app/src/routes/api.ts:1606`
     (`res.status(409).json({ error: 'retry_pending' })`).
   - Agrees with adversarial review F10.

Nothing forces a reload, at HEAD: a grep of `dashboard/src` (`.ts`, `.tsx`) for
`location.reload`, `buildStamp`, `build-stamp`, `BUILD_ID`, `__BUILD`,
`appVersion` and `version mismatch` finds nothing. `dashboard/public/sw.js`
registers only `install` (`:47`), `activate` (`:52`), `push` (`:57`) and
`notificationclick` (`:88`), with no `fetch` handler and no `caches` use (the
same at base), so a reload loads the new bundle.

Wording precision (not a contradiction):
- The brief said the old copy says "will retry" on EVERY 30003. The base relay
  map (`deliveryStatus.ts:860`) already dropped the promise on relay legs, so
  the note says "every 30003 outside a relay leg".
- The two base strings that contain an em dash (`:778` and `Timeline.tsx:130`)
  are described, not quoted, to keep the added lines ASCII.

## Issues index

`npm run issues` (`fixwave1b-issues.log`): EXIT=0. It printed "[issues] 298
open, 180 closed, 478 total -> docs/issues/INDEX.md" and "open by severity: 6
high, 129 med, 163 low", with no warning lines, so there is no schema
complaint. `INDEX.md` is gitignored (`.gitignore:62`) and was not committed.

## Discipline

- Bare `git status` before each commit, and no `MERGE_HEAD` in
  `.git/worktrees/retry-send-window/`. Explicit paths only. Each commit has a
  `Co-Authored-By: Claude Opus 5.5` trailer.
- ASCII check after each commit (`git show HEAD | grep '^+' | grep -v '^+++' |
  LC_ALL=C.UTF-8 grep -nP '[^\x00-\x7F]'`): nothing printed for `ac61485e` or
  `3b081fdb`. All three edited files were pure ASCII before and after.
- Not run, per the brief: the whole `npm test`, any e2e, `npm run smoke`, and
  repo-wide lint. No `:5174` or `:8080`, and no background command left
  running.
