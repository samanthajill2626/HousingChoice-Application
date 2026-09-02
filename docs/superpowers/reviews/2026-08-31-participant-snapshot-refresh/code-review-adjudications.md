# Code review round 1 - adjudications (2026-09-01)

Inputs: `code-review-conformance.md` (conformant-with-notes; spot-ran 6 suites
green) and `code-review-adversarial.md` (plan-blind; low risk on code, one
registry must-fix; empty hunts on security/PII, races, missed call sites).
Adjudicated by the build orchestrator. ONE fix wave follows; items marked
FIX-WAVE go into it.

## Must-fix

| id | finding | adjudication |
|---|---|---|
| C-F1 / A-4 | `pushSenderLabel` (twilio.ts:311) and `maskedPartyLabel` (voice.ts) use a soft-deleted contact's name as rung 1 - neither `getById` nor `findByPhone` filters `deleted_at`, and the binding constraint says a soft-deleted contact supplies NO name | CONFIRMED, FIX-WAVE item 1. Guard both labels with `isDeleted(contact)` so a deleted contact falls to the stored-name rung, matching `withLiveNames` (participantNames.ts:70) and `describeRoster` (rosterResolution.ts:541). RED tests first on both surfaces. |
| A-1 | `group-roster-name-snapshot-never-refreshed` is resolved while its unfixed outbound half (relayFanOut.ts:774 sender prefix) has no open tracker; `docs/issues/README.md:80`'s open+high triage query no longer surfaces it; `_CLUSTERS.md:82` still lists it as a high anchor - the registry contradicts itself | RULED BY THE HUMAN (relayed 2026-09-01, before this review): do NOT file a new issue; carry it in the handback under open questions for Cameron. The adjudication ADDS the reviewer's two facts to that handback item verbatim (triage-query invisibility; the _CLUSTERS.md:82 contradiction, which is a planning doc to update when M1 merges). The ruling stands; the finding is preserved, not lost. |

## Should-fix

| id | finding | adjudication |
|---|---|---|
| A-2 | `groupTitle.ts:110-113` docblock ("so the push title and the inbox row cannot drift") is now false - inbox hydrates its roster first, push titles do not | ACCEPTED, FIX-WAVE item 2, COMMENT-ONLY: rewrite the docblock to state the current contract (callers may hydrate the roster they pass; the push-title callers pass the stored snapshot by decision - spec "Out": push titles accepted stale). No code change. |
| A-3 | `filter=unread` pays one serial batch per multi-party candidate; one batch per wave is possible | REJECTED as a restructure: this exact cost was adjudicated in plan review (B6, "ACCEPTED AS A COST") and written into the spec's cost row - the loop point-reads each candidate for freshness, and a wave-level batch would read the STALE rosters' ids (a just-added member would be missed). Bounded by the page limit. Handback names it. |
| C-F2 | The spec mandates ONE `--audit-denorm` run at handback with recorded numbers; none recorded yet | NOT A CODE FIX: the run is the orchestrator's P5 item (deferred from T8 by design because it needs a full-profile session lane). The handback will carry the block; if it is missing there, THAT is a blocker. |
| C-F3 | `today-contact-hydration-fan-out` left open vs the spec's "close wontfix if small" | RULED BY THE HUMAN (relayed 2026-09-01): stays open with the harness N recorded. Closed. |
| A-5 | The e2e Today assertion cannot fail: PATCH /api/contacts/:id write-through refreshes the 1:1 `participant_display_name`, so rung 2 masks rung 1 | ACCEPTED AS A NOTE, no change: the write-through is an existing writer the spec keeps ("they only make the snapshot fresher"), so a UI-driven rename can never leave the 1:1 snapshot stale - the e2e leg is belt-and-braces, and rung 1 is pinned by the unit PINs that seed staleness directly (todayApi.test.ts). The group-card and facts-line legs remain the real e2e teeth. Recorded so nobody later "fixes" the spec by weakening the write-through. |
| A-6 | People card now disagrees with relayFanOut prefix / groupSend refusal strings until those catch up | The transition state the human chose: outbound is decision 6, staff-only strings are the filed `staff-only-roster-name-readers-stale`. No action; handback names the visible seam. |

## Notes (recorded, no action)

- C-N2 fourth export `resolveRosterNames` beyond the spec's three - the
  spec's section 4 listed the module surface loosely; the plan defined four.
- C-N4 two `as string` assertions in the close-nag loop are the plan's own
  text (values re-proven by the filter above them).
- C-N5 e2e uses getByText/regex on the facts line - it is a `div.facts`, not
  a role-addressable element; selectors doc satisfied elsewhere in the spec.
- C-N6 / seed synthetic names on real contact ids: expected `nameDrift` in
  the P5 audit numbers; carried to the handback interpretation.
- C-N8 audit re-chunks at 100 on top of the repo's own chunking - harmless.
- A-note `participants` absent -> [] on GET /calls/:callId - tolerated by the
  QuickReply consumer (optional-chained); wire note in the handback.
- A-note no in-product path to clear a WRONG stored roster name - true, and
  the chain makes it invisible while the contact is readable; remove-and-re-add
  remains the documented correction.

## Fix wave (one, complete)

1. `isDeleted` guard in `pushSenderLabel` + `maskedPartyLabel`, RED tests
   first (deleted-with-name contact: push body prefix falls to the roster
   name; voice label falls to the masked stored name), then green, then the
   affected suites + typecheck.
2. `groupTitle.ts:110-113` docblock rewrite (comment only).

Everything else above is closed by rationale or carried to the handback.
