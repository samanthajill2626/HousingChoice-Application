# Planner independent review - adjudications

Branch `feat/last-heard-from` @8bec5de1 (build handback). Reviewers: spec
conformance (`conformance.md`) and plan-blind adversarial (`adversarial.md`),
both read-only while the planner's gate battery ran. Planner gates on 8bec5de1:
`.superpowers/sdd/planner-gates/` (run state); quoted in `verdict.md`.

## Conformance (`conformance.md`): verdict "matches the spec"; 0 BLOCKING / 0 HIGH

- C1 [MEDIUM] Spec 14.7 (durable tour supersession) rewrites the approved D11
  formula and 5.4's "a canceled/no-show/not-a-fit tour contributes no
  activity". CAMERON'S CALL - brought to him with the verdict. The planner's
  view: it matches D11's stated intent ("a tour created by a person after a
  decline means the tenant changed their mind, from any tour-creating path"),
  only person-driven paths create tours (`routes/tours.ts:367`,
  `routes/units.ts:1339`), and the alternative made the same history read
  differently depending on which button created the tour. Recommend approve.
- C2 [LOW] 14.7's Interested write order (create, then compare-and-clear;
  `saved` only after a write). Strictly safer than 5.4's order. Folded into
  the same approval as C1.
- C3 [LOW] e2e (2) never shows the placed tenant coming back after "Show all
  statuses" - it asserts the URL only (`contacts-list-facets.spec.ts:214-223`).
  ACCEPT - fixed in the planner fix wave: the spec clicks the Placed chip and
  asserts the placed tenant's row is visible.
- C4 [LOW] The Review recipients header row is `aria-hidden`
  (`RecipientPreview.tsx:508`): P1's visible-text rule holds, but at >= 768px
  the bare authority / last-heard cells carry no accessible column label.
  DEFER - filed as `docs/issues/review-recipients-columns-no-accessible-labels.md`
  (low): the checkbox's accessible name carries the row's identity and tags,
  which is what screen-reader and e2e selection key on today.
- C5 [LOW] The Interested route reads tours by unit filtered to the tenant,
  where 5.4 says byTenant filtered to the unit. Same set; recorded as build
  adjudication F6. NOTE - no change.
- C6 [LOW] "Loading..." ASCII copy edit in `BroadcastsList.tsx`. Harmless.
  NOTE - no change.
- Handback deviations D1-D3: the reviewer AGREES with each (masked voice paths
  log the error name only because a privacy test forbids lookup error text;
  soft-deleted contacts keep their actions per 5.5's NOT ELIGIBLE rule while a
  deleted PROPERTY is read-only per 14.3 B10; the builder reused the existing
  `lib/contactName.ts` rule instead of a new module). The planner agrees.

## Adversarial (`adversarial.md`): 0 BLOCKING / 0 HIGH / 2 MEDIUM / 4 LOW

- A1 [MEDIUM] The follow-ups builder reads every listed send of up to 100
  available units, their tours, and one `requireComplete` contacts batch over
  ALL of them, and only then applies the 14-day lookback
  (`app/src/services/followUps.ts:128-145`); one unprocessed key 503s the
  Follow up tab and silently drops the Properties pill, and the work grows
  with every send ever made. VERIFIED in code. ACCEPT - fixed in the planner
  fix wave: rows outside `FOLLOW_UP_LOOKBACK_MS` are dropped right after
  `listByUnit` (they can never be waiting - `isWaiting` requires the lookback),
  a unit with no recent rows costs no tours read, and the contacts batch covers
  recent recipients only. Regression test: a unit whose only rows are older
  than the lookback triggers no tours read and no contacts read.
- A2 [MEDIUM] An email auto-reply (out-of-office) moves `last_heard_from_at`:
  the inbound email path has no auto-reply detection
  (`app/src/services/inboundEmail.ts:815-843`), so a false "Replied" and a
  reset quiet window follow. VERIFIED (no `Auto-Submitted` / auto-reply
  handling anywhere in the inbound email path). DEFER - filed as
  `docs/issues/email-auto-reply-moves-last-heard-from.md` (med): reachable only
  when staff email a tenant whose mailbox auto-replies (Sam's tenants are
  reached by text), and the fix needs the raw `Auto-Submitted` / `Precedence`
  headers, which the ingest stores only partially (`capStoredHeaders`). The
  field's comment ("automated traffic never moves it") refers to OUR automated
  sends; the issue says so.
- A3 [LOW] Each outcome click appends a unit audit row; the property Activity
  card shows the latest 50 unpaged. NOTE - the dual write is spec 14.3; a
  property with heavy outcome traffic was already near the cap with tours and
  shares. No change.
- A4 [LOW] 1:1 attribution takes the first participant with a contactId,
  where `contactCapture` warns about phone moves. The reviewer could not prove
  a live writer reaches the misattributing state. NOTE - this is the spec's
  one rule (5.1 / 14.2); no change.
- A5 [LOW] Stale-card Undo/Interested acts on the server-read decline. NOTE -
  already filed by the build (`outcome-actions-act-on-server-read-decline`).
- A6 [LOW] The outcome join is assembled four times (units, contacts,
  broadcasts preview, follow-ups) with three copies of the group-by-tenant
  loop; `GROUP_THREAD_TYPES` and `TEAM_SENDER_KEY` are re-declared. DEFER -
  filed as `docs/issues/listing-outcome-join-duplication.md` (low).
