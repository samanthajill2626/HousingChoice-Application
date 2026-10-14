# Design review adjudications - last heard from / follow-up status

Spec: `docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md`
Reviewer reports: `spec-r1-reviewer-a.md` (18 findings), `spec-r1-reviewer-b.md`
(17 findings). Both reviewers read the spec at cb4a30e0 and the repo only.

Verdicts: ACCEPT (the spec changed), REJECT (with the reason), DEFER (filed).
Severity labels are the reviewers'; whether a DECISION changed is the planner's
call and is marked at the end of each round.

## Round 1 (2026-10-12) - spec cb4a30e0 -> revision 2

Findings are merged where both reviewers hit the same defect.

1. A1 + B3 - a stored decline beats a later tour from any other path. ACCEPT.
   The rationale was wrong: a not-a-fit tour already yields no signal, so the
   precedence only fired in the "changed their mind" case, where it should
   lose. New rule D11: a decline is superseded by whichever is later, a counted
   share or a qualifying tour (`effectiveDecline(row, tour)` compares
   `declined.at` with `tour.createdAt`; `deriveTourSignal` gains `createdAt`).
   A1's alternative (tour create clears the decline) is not taken: it would
   make `POST /api/tours` a `declined` writer and break I2.
2. A2 + B1 - the resolver carries no status or contact. ACCEPT. Verified
   (`audienceResolution.ts:31-49`). `ResolvedContact` and `resolveSeeds` gain
   `status?` (tenant rows only) and `lastHeardFromAt?`; the "resolver not
   touched" claim is replaced by "filters untouched, projection widened", and
   the plan greps every consumer that persists the shape.
3. A3 + B4 - added rows and the search have no decline source. ACCEPT. The
   preview returns `declinedContactIds` (the `priorRecipientContactIds`
   analog); `ContactSearchField` gains an optional `annotate` prop rendered
   outside the committed name, as a separate commit after the verbatim C6
   patch.
4. A4 + B10 - Tenants-tab status filter contradictions. ACCEPT. The facet is
   explicitly the inverse convention; no param = default set; the empty set is
   unrepresentable and not needed (Clear = default, turning off the last chip
   is a no-op, all seven on = everyone); only a non-default selection is
   written; status enters `buildFacets` and the probe prune; a hidden-match
   hint with "Show all statuses"; the Name comparator is defined (there was no
   existing order - B10 is right that section 1 said so).
5. A5 + B6 - skipping the touch on dedupe loses it; `provider_ts` is the
   server clock. ACCEPT. Verified (`twilio.ts:2501-2545`). The touch runs on
   both branches with the persisted row's `tsMsgId` prefix and is skipped when
   the persisted row is not inbound; the spec stops calling it a provider
   instant.
6. A6 + B7 + B15 - live and backfill attribute differently; the refused member
   call is missing; imported calls are unattributed. ACCEPT. One pure
   `attributeInbound(row, thread)` is the single rule; table row 6 covers every
   refusal reason and the soft-deleted-match case; a non-member open-relay text
   is resolved by phone on the live path too; imported 1:1 calls attribute by
   participant, imported group calls are reported as unattributed; the
   backfill skips (does not stop on) an unknown-author email.
7. A7 + B2 - `touchLastHeardFrom` can mint phantom contacts. ACCEPT. Verified
   (`apply.ts:663-686` documents the hazard; every other writer guards). The
   condition gains `attribute_exists(contactId)`; both failure reasons are
   swallowed; pointer rows are never targets.
8. A8 + B11 - property Activity reads the unit audit trail; "unknown types
   render nothing" was false. ACCEPT. Verified (`units.ts:183-213`,
   `types.ts:3109-3121`). Dual-write: activity event (contact timeline, with
   dashboard union + labels) AND unit audit append (with whitelist + label).
   The false sentence is gone.
9. A9 + B8 + B9 - the lean seed has inbound history; `history.ts` writes no
   messages; seed rows have `ts` not `provider_ts`. ACCEPT. Verified
   (`lean.ts:349-434` inbound rows; `history.ts` has no `direction` writes).
   New D13: a pure seed derivation stamps every seeded contact from the merged
   message items of the loading profile, reading the `tsMsgId` prefix; the
   lean contact items change deliberately; I4 restated as self-consistency.
10. A10 + B12 - best-effort joins produce wrong outcomes; the Interested check
    ignores toured tours. ACCEPT. New D12: on outcome-serving endpoints the
    joins are required (503 `outcome_unavailable`); the route's existence
    check uses `deriveTourSignal`'s full qualifying set.
11. A11 + B13 - the waiting list keeps deleted, opted-out and unreachable
    recipients; option C's card ignores D1. ACCEPT. A shared RECIPIENT RULE
    (not deleted / opted out / unreachable; not inactive / placed) governs
    both the list and the card's waiting group; the card gains a NOT ELIGIBLE
    group with no Text action.
12. A12 - the partner "Request a tour" link has no host with an empty tenant
    picker. ACCEPT. Verified (`ContactDetail.tsx:1306-1313` locks tenantId).
    The link navigates to the property page with `?tour=new`, opening its
    Schedule tour host with the unit pre-committed; `POST /api/tours` refuses
    a non-tenant `tenantId` (400 `tenant_required`).
13. A13 - partner rows can carry tours in data. ACCEPT. `deriveSendOutcome`
    takes `recipientType` and ignores the tour signal for non-tenants.
14. A14 + B14 (provenance) - the one-click create leaves no trace; `created_via`
    has nowhere to go. ACCEPT. A `listing_interested` event on both audit
    surfaces; the `created_via` sentence is gone. B14 (the guessed tour type
    should be surfaced for review): REJECT. D6 is Cameron's: the button picks
    the type itself. It is the same guess the Schedule tour form pre-fills,
    and the tour is editable afterwards like any requested tour. The spec now
    says the guess is accepted by design.
15. A14 + B5 - "Interested clears the decline" vs "the record stays as
    history"; the early-return branch and write order unspecified. ACCEPT.
    Under D11 a later tour supersedes a decline without any clear, so the
    normal path needs none; the route still clears an effective decline
    (REMOVE; history is the `listing_decline_cleared` event) in a stated order
    with a stated partial-failure result. The both-ways contradiction is gone.
16. A15 + B16 - the contact endpoint already does the tour join;
    `RECIPIENT_PROJECTION` is units-only; ten callers not twelve; no mobile
    pins in `broadcasts.spec.ts`; `lastSeenAt` is stamped on materialization,
    not reset per edit; section 9 called 5.5 independent while asking Sam
    about rows. ACCEPT, all corrected in place.
17. A16 - the legacy no-body filter-resolve send path still sends to declined
    tenants. ACCEPT as a stated non-goal (the dashboard never uses it; Work
    Package 3 must not).
18. A17 - dev fixture seams and `/__dev/reseed` are unlisted writers. ACCEPT.
    The fixture routes call the touch; reseed re-Puts the derived items, so
    it no longer moves the value backward.
19. A18 (smaller) - ACCEPT each: `formatHeardFrom` is a wrapper adding
    "Today"; the glossary's "waiting" definition now includes Replied; the
    demoted-share note is in 5.4; the added row scrolls into view; the backfill
    normalizes instants through `Date.parse` (the importer's raw `createdAt`
    format is UNVERIFIED, so normalization is unconditional).
20. B17 - `declinedThisProperty` adds no exclusion beyond already-sent; the
    both-tags accessible name is unspecified. ACCEPT as a clarification: the
    flag is the LABEL D4 asks for, and every declined row is already sent, so
    the unchecked default was already true; the accessible name is `<name> -
    already sent, not interested`, and the e2e selectors that use `already
    sent` are updated knowingly.

Round 1 result: decisions CHANGED (D11, D12, D13 added; the precedence rule,
the attribution rule, the preview payload, the audit surfaces and the seed
posture all moved). Round 2 proceeds with reviewer A continued (18 findings,
more accepted), carrying reviewer B's report.

## Round 2 (2026-10-12) - spec d8bd07e3 (revision 2) -> revision 3

Reviewer A continued (`spec-r2-reviewer-a.md`, 11 findings + one contested
adjudication).

1. R2-1 - D11 compares against the chip winner's `createdAt`, which is the
   most PROGRESSED tour, and revived tours keep their `createdAt`. ACCEPT.
   Verified (`listingSendTour.ts:41-45`; `toursModel.ts:214-218` has
   `lastMarkedAt`). `deriveTourSignal` now also returns `latestActivityAt` =
   max over every qualifying tour of `max(createdAt, lastMarkedAt ??
   updatedAt)`, and `effectiveDecline` compares against that. D11 reworded.
2. R2-2 - the non-member refused call has no `relay_sender_key`; a
   key-presence discriminator would credit roster member #1. ACCEPT. Verified
   (`voice.ts:1048-1054`). The rule discriminates by thread type; keyless
   relay rows resolve by the external-caller fields; a roster member is never
   the fallback; other keyless group rows are unattributed and counted.
3. R2-3 - "pure" functions that do lookups. ACCEPT. `attributeInbound` takes
   an injected `lookup`; the seed derivation passes a synchronous lookup over
   the seed's own contact items; "pure" is gone from both.
4. R2-4 - the preview computes `declinedContactIds` with no tour join or
   types, so it cannot apply D11. ACCEPT. The preview joins tours and the
   declined rows' contact types (requireComplete) and runs
   `deriveSendOutcome`. D12's 503 is NOT extended to the preview (it serves
   labels, not outcomes with buttons): on a failed read it serves candidates
   with no decline labels and a visible `declineLabelsUnavailable` line.
5. R2-5 - card rows fall into no group; the projection lacks opt-out /
   unreachable. ACCEPT. The card uses the eligibility half only (a shared
   `isEligibleRecipient`); four groups cover every row; the units projection
   gains `deleted_at`, `sms_opt_out`, `sms_unreachable`; the row carries
   `eligible`. NOT ELIGIBLE rows keep their outcome's actions.
6. R2-6 - `getRecipientDisplaysByIds` drops keys silently; the contact cards
   render a 503 as "Arrives with the backend."; Today's failure mode is
   undefined. ACCEPT. Verified (`contactsRepo.ts:943-951`, `:986-998`;
   `useContactFile.ts:51-61`). `requireComplete` on the outcome joins; a
   genuinely missing contact is served as `recipientMissing` with no
   actions; the contact cards get a distinct error rendering; the Today
   section degrades on its own.
7. R2-7 - the status facet's no-op last chip breaks the deselection
   contract; Clear is a dead control at the default; invalid-only URLs are
   undefined. ACCEPT. `?status=none` is the explicit empty selection; Clear
   returns to the default and shows only when the selection differs from it
   (`ChipGroup` gains a `baseline`); invalid-only prunes to the default.
8. R2-8 - "every declined row is already sent" is not guaranteed. ACCEPT.
   Verified (`shareRecipientState.ts:249-268` is best-effort;
   `listingSendsRepo.ts:51` legacy / individual entries). The declined-only
   accessible name is allowed; the unchecked rule stands on its own.
9. R2-9 - `listing_interested` written without a create and on retry; the
   post-write 503 claims nothing changed; audit best-effort unstated.
   ACCEPT. Written only on create; 503 carries `saved: true` and the row
   says "Saved - reload to see the change"; audit writes are best-effort via
   the tours writer.
10. R2-10 - normalize at the single writer, not in the backfill. ACCEPT.
    `touchLastHeardFrom` normalizes; the backfill's own normalization is for
    its cross-thread max only.
11. R2-11 - email dedupe returns early by design; the performance world is
    outside D13; NOT ELIGIBLE actions unspecified. ACCEPT all three (email is
    covered by the winner; the performance world is excluded explicitly;
    NOT ELIGIBLE rows keep their outcome's actions).
12. Contest of round-1 rejection B14 (the guessed tour type). The contest
    WINS: `tourType` is not in the PATCH allowlist (`tours.ts:157`) so the
    guess is permanent, and it routes reminders (`tourReminders.ts:1062-1068`).
    The round-1 rejection rested on "editable afterwards", which was false.
    New D14: the button commits a type only from the structured
    `unit.tour_type`; with none, it opens the Schedule tour form prefilled
    (tenant, property, no time) so the guess is seen; the route refuses
    `tour_type_required` as a guard; `deriveTourType` stays in the form.
    This is a Cameron-level amendment to D6 and is flagged for the spec gate.

Round 2 result: decisions CHANGED (D11's comparison input, D14 added, the
preview's degraded state, the card grouping rule). Round 3 proceeds with the
same reviewer under the re-review charge.

## Round 3 (2026-10-12) - spec 37bd970b (revision 3) -> revision 4

Reviewer A continued (`spec-r3-reviewer-a.md`, 6 findings, no BLOCKING or
HIGH, no contested adjudications).

1. R3-1 - the `lastMarkedAt ?? updatedAt` fallback lets an automated tour
   write (relay group open, conversion claim) undo a decline. ACCEPT.
   Verified (`toursRepo.ts:559` stamps `updatedAt` on every write). The
   input is `max(createdAt, lastMarkedAt)`; a fresh tour is carried by
   `createdAt`.
2. R3-2 - D14's form path needs host changes the spec did not list. ACCEPT.
   The contact host gains a per-click `initialUnitId`; the property host
   gains a per-click `tenantId` and the `?tour=new&tenantId=` entry; the
   waiting list navigates there; every row carries `interestedMode`; the
   hosts' navigation to the new tour page is accepted as is.
3. R3-3 - `recipientMissing` rows cannot be "interested by the tour alone"
   and had no card group. ACCEPT. Decline-by-share or `no_reply`, NOT
   ELIGIBLE group.
4. R3-4 - `isEligibleRecipient` omitted the phone check. ACCEPT.
5. R3-5 - in the degraded preview a declined, not-already-sent tenant starts
   checked and the warning did not say so. ACCEPT; the line says it.
6. R3-6 - `?status=none` nearly spells the module's `NONE_KEY`; the
   sentinel-plus-values case was undefined. ACCEPT. Sentinel `_empty`;
   values win over the sentinel.

Round 3 result: NO decision changed - every accepted item is a precision
edit to a mechanism already decided. Per the stop rule this is the terminal
round; the design review is CLOSED at round 3 of a 4-round cap. Rejections
across all rounds: one (B14), later reversed on contest; see round 2.

# Plan review

Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md` (v1 @0779fbe0).
Reviewer reports: `plan-r1-reviewer-a.md` (10), `plan-r1-reviewer-b.md` (11).

## Round 1 (2026-10-13) - plan v1 -> v2

Merged where both reviewers hit the same seam. The plan was written by four
slice writers against a shared contracts head, and the three HIGH findings
are all cross-writer seams; each fix is routed to the slice that owns it.

1. A1 + B3 - form-mode Interested on the property page opens the form from
   local state while the markup contract (R4) and e2e 8.4 require the URL
   `?tour=new&tenantId=`. ACCEPT. Task 5.3 navigates with `setSearchParams`
   and the param-driven host opens the form; no local-state path. (S5)
2. A2 + B2 - no task delivers R1 (roster rows as `<li>` in a `<ul>`). ACCEPT.
   5.1 renders an `<li>` root; 5.3 and 5.4 wrap each group in a `<ul>`; a
   unit test pins `listitem` counts. (S5)
3. A3 + B1 - `setListingSendOutcome` returns `{ row }` in 3.4/S7 and a bare
   row in 3.8/S5. ACCEPT. The contract is `{ row }` everywhere; 3.8 and S5's
   call sites and tests are rewritten. (S3, S5)
4. B4 - the Follow up tab keeps an actioned row on screen while e2e 8.6
   expects it gone without a reload. ACCEPT, ruling: an actioned row shows
   its new state in place for the session (Undo on a decline, the tour chip
   on Interested) and leaves the list on the next load; 8.6 reloads before
   asserting the group is gone. (S7 states it; S8 reloads)
5. B5 + B6 - S6.5 renders a visually hidden "Last heard from " prefix span in
   every narrow-layout row, so 8.3's "not inside the list" check fails and
   the `getByText` regex may not match. ACCEPT. The narrow-layout prefix is
   CSS `::before` content (no DOM text); the cell's text is the bare label.
   (S6; S8 unchanged)
6. B7 - gate 4 uses `timeout 1500` in S10 and 3000 in 8.5 against an ~18 min
   baseline plus five new specs; a kill orphans the stack. ACCEPT. Both say
   `timeout 2400`, and 8.5/S10 add the AGENTS.md post-abort check that no
   listener survives on the lane's ports. (S8, S10)
7. A4 - a non-member calling a CLOSED relay group gets a row with neither a
   sender key nor the external-caller fields (`closed_thread` wins the
   reason), so it is never attributed. ACCEPT. Path 6 computes the
   external-caller fields whenever `caller === undefined`, whatever the
   refusal reason; a unit case covers it. Spec amended (14.6). (S1)
8. A5 - the placement conversion and the outcome-only exit are person-made
   tour writes that do not stamp `lastMarkedAt`, so they never supersede a
   decline. ACCEPT as a documented acceptance (watch items + spec 14.6): a
   converted tour already reads Toured/Interested through `deriveTourSignal`,
   and an outcome-only close yields no signal by design.
9. A6 - ruling 3.4 #2 (a clear of a never-declined row writes no event)
   deviates from spec 5.4's unconditional "then the audit writes". ACCEPT:
   the spec is amended (14.6) rather than the ruling reverted - an event on a
   timeline where nothing was declined is the dishonest option.
10. A7 - an email row flagged `email_new_address` is never re-attributed
    after staff link the address. ACCEPT as a known limit (spec 14.6): the
    contact's NEXT inbound counts; history is not rewritten.
11. A8 - the dev seam overwrites the shares map and can move `sentAt`
    backward on an existing pair. ACCEPT. The seam answers 409
    `send_exists` when the pair already has a row. (S7)
12. A9 + B9 - FollowUpView redefines the outcome-error copy;
    `followUps.ts` has its own `nameOf`. ACCEPT. Import
    `lib/listingOutcomeErrors.ts`; reuse `displayNameOfContact`. (S7)
13. A10 + B11 - the "not persisted" proof is a grep in a commit body. ACCEPT.
    6.1 adds a unit test that the recipients map `markSending` writes carries
    neither `status` nor `lastHeardFromAt`. (S6)
14. B8 - "Request a tour" keys on `!interestedSupported`, so landlord rows
    get it. ACCEPT. The link renders only when the row's recipient type is
    `partner` (units route: the row's `type`; contact page: the page's
    contact type). (S5)
15. B10 - 1.13B says to re-run the I1 writer audit at the final gate; S10
    has no step. ACCEPT. S10.2 gains it. (S10)

Round 1 result: decisions CHANGED on the plan (the URL-driven form path,
the `{ row }` shape, the row/list markup, the clear-no-event spec amendment,
the voice path 6 fix). Round 2 proceeds with reviewer B continued (11
findings, more accepted), carrying reviewer A's report.

## Round 2 (2026-10-13) - plan v2 @3cffb801 -> v3

Reviewer B continued (`plan-r2-reviewer-b.md`, 6 findings, 4 contested
round-1 adjudications). "Nothing blocks the build."

1. R2-1 - the partner-only `Request a tour` rule (round-1 #14) reached the
   cards but not the Follow up rows. ACCEPT (contest of #14 upheld: half
   applied). `FollowUpRow` keys on `type === 'partner'`; a landlord-row
   negative test. (S7)
2. R2-2 - the voice path 6 change edits an unreachable state (the router
   sends a non-member whose groups are all closed to founder triage,
   `relayInboundResolution.ts:89-96`), and its getter-seam test is fragile.
   ACCEPT (contest of #7 upheld). The path-6 code change is REVERTED; path 5
   pins the reachable case; spec 14.6 restated. (S1)
3. R2-3 - `displayNameOfContact` exported from a ROUTE module into a service
   drags sharp/pdfium into the pure builder test. ACCEPT (contest of #12
   upheld as to the fix). The helper moves to `app/src/lib/contactDisplay.ts`;
   both import it. (S7)
4. R2-4 - the final I1 re-audit wrote to gitignored run state and was
   numbered as a gate. ACCEPT (contest of #15 upheld). It runs after gate 5
   and its output is COMMITTED as `i1-audit-final.md` in the records. (S10)
5. R2-5 - the tour form opens with a push and closes with a replace (two
   identical history entries). ACCEPT. Both use `{ replace: true }`. (S5)
6. R2-6 - the dev-seam row in the plan head and selectors.md promise an
   unconditional 201. ACCEPT. Both state 201 on a fresh pair / 409
   `send_exists` otherwise. (head, S7)

Round 2 result: NO decision changed - precision edits only. Per the stop
rule this is the terminal round; the plan review is CLOSED at round 2.
