# Phase 4 spec-conformance review: relay inbound caller identity

Reviewed `70705b1c...1065acce` against the approved design, plan, and live
worklist. This was read-only: no product files, index, or commits changed.

## Result

No functional spec-conformance defect found. S1-S5 and E1 conform. E2 is
partial because its completion criteria deliberately extend beyond the current
review phase and the recorded final gate attempts are not all green.

## Work-map disposition

| Item | Status | Evidence |
| --- | --- | --- |
| S1 - durable write contract | CONFORMS | `app/src/repos/messagesRepo.ts:721-726,825-843,1900-1962` declares/maps the exact three optional facts and rejects every forbidden shape before the document client is called. The strict fake mirrors the mapping at `app/test/helpers/twilioWebhookHarness.ts:1108-1116`; production guard/mapping coverage is at `app/test/repos.test.ts:226-295`. Reverting the guard or mapping makes the invalid-shape/no-write or snake-case assertions fail. |
| S2 - existing voice refusal branch | CONFORMS | Only the existing refusal arm enriches exact `reason === 'non_member'` at `app/src/routes/webhooks/voice.ts:893-943`. It normalizes then does a best-effort, deletion-fenced lookup (`906-920`), retains `author: unknown`/no sender key (`929,935,939-943`), and preserves the existing `maskedSayHangup` return (`953-963`) before the untouched bridge branch starts at `966`. Tests at `app/test/voiceWebhook.test.ts:422-599` prove matched, unmatched, deleted, anonymous, lookup-failure, redelivery, other-refusal, no-Dial/no-phone-output, no-contact-create, and no-roster-write cases. Removing the conditional enrichment or changing the refusal response breaks these assertions. |
| S3 - authenticated read enrichment | CONFORMS | The contact display projection carries the deletion fence at `app/src/repos/contactsRepo.ts:296-302,855-865`. The authenticated page deduplicates IDs from only the page, skips zero IDs, calls `getDisplaysByIds` once, derives copied response rows only, ignores deleted/missing displays, and catches failure to return HTTP 200 at `app/src/routes/api.ts:2127-2164`. API tests prove dedupe, zero-ID, deleted/restore, failure fallback, and non-mutation at `app/test/conversationHubApi.test.ts:317-405`. A reintroduced phone lookup, N+1 query, mutation, or missing catch would fail the corresponding tests. |
| S4 - dashboard mapping and pure presentation | CONFORMS | Wire and timeline types are extended at `dashboard/src/api/types.ts:2151-2157,2359-2362`; the relay-only mapper preserves the content-stripping policy while forwarding safe string metadata at `dashboard/src/routes/conversation/useRelayThread.ts:66-99`. The pure presenter is gated on exact `non_member`, uses stored-ID-plus-current-name precedence, then phone, then the approved unknown copy at `dashboard/src/routes/contact/presentRelayExternalCaller.ts:12-41`; it has no roster or lookup dependency. `Not connected` is exact-reason-first at `dashboard/src/routes/contact/presentCallState.ts:115-123`, and detailed timestamp formatting is local, seconds-precise, and has the required visible fallback at `dashboard/src/routes/contact/format.ts:57-68`. Tests at `dashboard/src/routes/contact/presentRelayExternalCaller.test.ts:16-75` and `dashboard/src/routes/conversation/useRelayThread.test.tsx:56-125` would fail on a reason-gate, precedence, or metadata-boundary regression. |
| S5 - call-card UI | CONFORMS | The card chooses the external presentation before relay roster inference, retains minute time on the face, and keeps a unique seconds-or-ID accessible card name at `dashboard/src/routes/contact/Timeline.tsx:1252-1279`. Exact per-card `Details`, `aria-expanded`, staff-only facts/link fallback, and full visible timestamp are at `1304-1336`; collapsed/revealed CSS is `dashboard/src/routes/contact/Timeline.module.css:496-505`. UI coverage confirms face text, `Not connected`, no face link, all detail states, stale-ID fallback, roster collision, and same-minute control uniqueness at `dashboard/src/routes/contact/Timeline.test.tsx:2163-2318`. Reverting the presenter-first order, details condition, or name precision breaks these tests. |
| E1 - real flow proof | CONFORMS | The committed hermetic spec `e2e/tests/dashboard-next/relay-inbound-caller-identity.spec.ts:51-112` creates an open relay, places a real non-member fake call, proves zero Dial legs, persisted reason/phone and absent contact ID, no contact creation, and exact staff card/details. Its slice report records `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/relay-inbound-caller-identity.spec.ts` exit 0, 1 passed in 15.4s; `e2e/.artifacts/results.json` records `expected: 1`, `unexpected: 0`. Removing the refusal metadata, no-Dial guarantee, or card details makes this test fail. |
| E2 - completion proof | PARTIAL (expected at Phase 4) | This item requires final bare gates, lint ratchet, independent review, and live hermetic QA. The ledger remains `STATUS: RUNNING phase4-review-children`; self-QA has not started. Moreover, recorded gate logs are not fully green: `.superpowers/sdd/gate-typecheck.log` reports the e2e TS6142 errors, and `.superpowers/sdd/gate-eslint.log` reports two lint errors. This is a delivery-gate blocker, not a functional implementation finding; it must be adjudicated and re-run in the orchestrator's later phases. |

## Hard constraints attacked

- **Routing/refusal/TwiML:** the non-member facts are computed only after the
  existing reason decision and before the existing append; the no-bridge return
  remains `Say` plus `Hangup` (`voice.ts:893-963`). The focused webhook and E2E
  probes assert no `<Dial>`/zero legs and no number in the TwiML.
- **No contact creation/backfill or roster mutation:** the only new lookup is
  `findByPhone`; production code has no create/update call in this path
  (`voice.ts:906-920`). The webhook/E2E tests assert unchanged roster and zero
  created contacts (`voiceWebhook.test.ts:447-448,471`; E2E `92-94`).
- **Non-member-only durable state:** the write guard requires inbound masked
  call, exact reason, unknown author, no sender key, E.164 phone, and
  contact-ID-with-phone (`messagesRepo.ts:825-843`); other refusal tests prove
  no feature fields (`voiceWebhook.test.ts:564-598`).
- **Current-name-only hydration with deletion fence:** the route reads only
  stored contact IDs, projects `deleted_at`, filters it, never matches stored
  phone, and restores the name only after contact restore (`api.ts:2131-2164`;
  `conversationHubApi.test.ts:366-405`).
- **Participant-facing non-leak and masked metadata-only policy:** no new
  participant-facing formatter or bridge path consumes the fields; the relay
  mapper continues excluding media/provider/recording/transcript and the E2E
  probe proves no participant leg (`useRelayThread.ts:66-99`; E2E `66-77`).
- **Exact staff behavior:** plain-text identity, `Not connected`, collapsed
  card-specific Details, link/no-link state, and full local time are directly
  implemented and tested at the S5 anchors above.

## Empirical-review note

I found no code defect requiring a throwaway reproduction. The existing
correction-sensitive tests above are the empirical probes: each names behavior
that would fail if the corresponding implementation were reverted. `git diff
--check 70705b1c...1065acce` completed cleanly. The only finding is the E2
completion-state fact, reproduced from the current ledger and saved gate logs.

## Findings

1. **E2 / completion proof is PARTIAL, not a product-code defect.** Required
   final typecheck and lint evidence is red, and independent review/live QA are
   still pending. Do not hand back as merge-ready until the orchestrator resolves
   or baseline-adjudicates those gate outputs, completes QA, syncs main once, and
   re-runs required gates on the final synced commit.

No must-fix functional spec-conformance findings.
