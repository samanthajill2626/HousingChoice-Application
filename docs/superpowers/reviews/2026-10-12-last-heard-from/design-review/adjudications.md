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
