# Code review round 1 - orchestrator adjudications

Date: 2026-10-13. Branch `feat/last-heard-from` @1f29204b (code = 1f298e64).
Inputs: `conformance-findings.md` (Reviewer A, spec-anchored: 0 BLOCKER / 0
MAJOR / 1 MINOR / 2 NIT) and `adversarial-findings.md` (Reviewer B, plan-blind:
0 / 0 / 2 / 5). Gates on 1f298e64 before review: typecheck 0, npm test 0,
smoke 0, e2e 0 (359 passed), eslint = one pre-existing error only.

Every ruling below is code-level; none changes an approved product rule. The one
finding that WOULD change an approved rule (ADV-1) is kept as specified and
raised for Cameron in the handback.

## FIX in the fix wave

- A-1 (MINOR) ACCEPTED. The contact header's "Last heard from" span must never be
  the part that is cut: the facts text is the only shrinking/ellipsizing child,
  the heard span keeps its width (`flex: 0 0 auto`, the Tenants-row F13 shape).
  Verified by measurement in self-QA at 360px (jsdom does no layout).
- A-3 (NIT) ACCEPTED. The outcome route answers 503 `saved: true` only when a
  write actually happened (setDeclined / clearDeclined / tour create); otherwise
  the plain 503 `outcome_unavailable`. Regression test: existing tour, no decline,
  re-read throws -> no `saved`.
- ADV-3 (NIT) ACCEPTED - reorders spec 5.4 steps (3) and (4), honoring their
  intent (both readings honor it; this one cannot lose another staff member's
  decline): the Interested route CREATES the tour (and records
  `listing_interested`) BEFORE it clears an effective decline (and records
  `listing_decline_cleared`). A create failure now leaves the decline and the
  timeline untouched; a clear failure after a create leaves a tour whose
  createdAt already supersedes the decline (outcome still reads Interested).
  Regression test: create throws -> stored `declined` intact, no
  `listing_decline_cleared` event.
- ADV-2 (MINOR) ACCEPTED. `buildFollowUps` reads the contacts with
  `getRecipientDisplaysByIds(ids, { requireComplete: true })` (the projection
  already carries every attribute it reads - verify each one) instead of whole
  items via `getManyByIds`. Same completeness contract (an incomplete batch is
  still the 503).
- A-2 (NIT) ACCEPTED as a COMMENT fix: `followUps.ts`'s `unitLabel` comment stops
  claiming it is the dashboard's shortAddress rule (the app formatter writes
  `City, ST ZIP`; the dashboard writes `City, ST, ZIP`; spec 5.6/14.3 mandate the
  server formatter). Formatter alignment is out of scope.
- ADV-1 (MINOR) - BEHAVIOR KEPT (it is the approved spec's literal rule: spec 5.4
  "a canceled, no-show or not-a-fit tour yields no signal and contributes no
  activity"; D11 confirmed by Cameron). Fix wave: correct the
  `listingSendsRepo.ts` header, which wrongly says a superseded decline stays
  ineffective - supersession is recomputed on every read, so a decline superseded
  only by a tour that is later canceled / marked no-show / not-a-fit is effective
  again; add a PIN test in `listingSendOutcome.test.ts` (decline T1, tour created
  T2 > T1 -> interested; same tour canceled -> not_interested) so the behavior is
  deliberate and visible. RAISED FOR CAMERON in the handback with the reviewer's
  narrow alternative (a non-qualifying tour supersedes through its createdAt only,
  never its lastMarkedAt - which keeps "staff canceled the tour BECAUSE of the
  decline" correct).
- ORCH-1 (NIT, orchestrator's own, from D11's report) ACCEPTED. A Follow up group
  heading's accessible name concatenates the address and the count with no
  separator ("...GA 303142 waiting"). Give it a separator so the name reads
  `<unitLabel> - <n> waiting` (the e2e matches a pattern starting with the
  unitLabel and containing `<n> waiting`; keep that true).

## NO CHANGE (recorded; named in the handback)

- ADV-4 (NIT): an automatic 30003 retry of a share sent before a decline, accepted
  inside the 15-minute retry window, moves sentAt past the decline. Spec 5.4
  supersedes by "a counted share (sentAt)"; the window is narrow. Known edge.
- ADV-5 (NIT): the performance world does not derive last_heard_from_at - spec D13
  excludes it on purpose ("a load fixture, not a demo world").
- ADV-6 (NIT): mount-time clocks on surfaces that stay mounted (a tab left open
  over midnight). Spec non-goal: the surfaces refresh on navigation.
- ADV-7 (NIT): `declinedThisProperty` per candidate has no dashboard reader; spec
  5.3 asks for both encodings (the mirror of alreadySent / priorRecipientContactIds).

## Re-review

MANUAL mode: both reviewers are CONTINUED (SendMessage) with the re-review charge
after the fix wave: (1) what the first pass missed across the changed state, (2)
the fix diff reviewed cold as new code, (3) challenge any ruling above with
file:line, (4) only then, whether the fixes are real.
