# Planner review - spec conformance (feat/matching-blast-rules)

Reviewer: independent spec-conformance reviewer (read-only; no suites run).
Contract: `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md`,
APPROVED revision 6 (the `requested` label "Tour requested Oct 12, no date
yet", cue `tour requested oct 12, no date yet`).
Branch tip reviewed: b1bb9dc9 (last code commit 994be540), base main @a2b3d80d.
Method: every decision and requirement in spec sections 3-7 traced to the code
that implements it and the test that pins it, from
`git diff main...HEAD -- . ':(exclude)docs/superpowers'` plus the touched files
in full. Reviews and plans under `docs/superpowers/` were not read. Code is cited
by file:line only; no code is quoted here.

## Summary

| Verdict | Count |
|---|---|
| CONFORMS | 91 |
| PARTIAL | 2 |
| DEVIATES | 0 |
| MISSING | 0 |
| Total | 93 |

Every user-facing string the spec quotes was compared character by character
and matches, including the revision 6 `requested` label (with and without a
date) and every accessible-name form. The reach count equals the server's
default-checked rows (the same `buildReviewRows` serves preview and create, and
a test compares the two), tour-held tenants are listed unchecked with a label,
status-excluded tenants are not listed, hand picks start checked, caseworkers
never resolve from a filter, a selected authority leaves out tenants with none
(and the caption says so), the rules reads fail closed for filter drafts (503
and Try again) and degrade for seeds-only drafts, and the picker offers
Available properties only.

### Non-CONFORMS items

| # | Item | Verdict | Severity | Why |
|---|---|---|---|---|
| R27 | D3 "A failed state belongs to the property it was for and clears when that property loads or the property changes." | PARTIAL | low | Implemented structurally (the load is kept with its id and only counts for that id, `BroadcastComposer.tsx:185-186`; a re-pick of a failed property resets it, `:490`), but no test pins the CLEARING: the failed-load tests (`BroadcastComposer.test.tsx:962`, `:991`) never change or reload the property after a failure. |
| R55 | D7 "the row gets the same amber row class" | PARTIAL | low | Implemented (`RecipientPreview.tsx:571` adds the tour hold to the amber `rowAlready` condition), but no test asserts the row class for a held row (or for any row); a regression would pass every suite. |

### Observations on CONFORMS items (info, no action required by the spec)

- I1 (D2, R14). "Responses always send `housing_authorities` and never
  `housing_authority`": `wireAudienceFilter` (`app/src/lib/blastAudienceRules.ts:219-228`)
  sends the list only when it is non-empty and omits the key otherwise, pinned by
  `app/test/blastAudienceRules.test.ts:139`. The legacy key is never sent, the
  dashboard reads one shape (`housing_authorities ?? []`), and an empty list is
  "no housing authority filter" per D2, so this reads as conforming; noted
  because "always send" could be read literally.
- I2 (D3, R19). The not-limited line renders as one run-on sentence: "Not used
  (not on the organization list): Nowhere Board This blast is not limited by
  housing authority." (`AudienceFilters.tsx:42`, `:44`, `:211-217`; pinned
  verbatim at `AudienceFilters.test.tsx:278` and `BroadcastComposer.test.tsx:856`).
  It is spec-literal (the spec quotes the note without a closing period and
  says the second sentence "follows"), but there is no period between the
  names and "This". Copy polish for Cameron if wanted; a spec text amendment
  would be needed to change it.
- I3 (D7, R62). The server's `audience_too_large` TRUNCATION message dropped
  the "narrow ..." advice as specified (`broadcasts.ts:1320-1321`, pinned at
  `broadcastApi.test.ts:731`). The recipient-CAP message keeps "narrow the
  housing authority and/or bedroom-size filter" (`broadcasts.ts:1322`, pinned at
  `broadcastApi.test.ts:3831`). D7 names only the truncation message, and over
  the cap the filters do still narrow the final set, so this conforms; section 7
  lists "the `audience_too_large` messages" (plural), which the cap message
  satisfies by now counting the final set.
- I4 (D3b, R30). A 422 whose `text` matches no member the composer holds
  empties the whole list (`BroadcastComposer.tsx:256-268`). The spec presumes
  the named member is held; the fallback is defensive and the path looks
  unreachable from the UI (a resumed draft cannot Preview before a body
  recreates it). Already filed as
  `docs/issues/matching-composer-422-unmatched-member-clears-filter.md`.
- I5 (D3, R25). A failed organization-list read (and a failed property load)
  settles the prefill and leaves the blast unfiltered by housing authority -
  exactly what spec D3 prescribes, so CONFORMS. It is filed as a pre-merge
  decision in `docs/issues/matching-prefill-org-list-failure-fails-open.md`;
  any change there is a spec amendment, not a conformance fix.
- I6 (section 7, R86). The full-profile seed's list-shape draft
  (`app/src/lib/seed/matrix.ts:1260-1265`) holds `[dca, dekalb]`, while its new
  comment says "here the 2BR in DeKalb". Harmless comment drift.

## Per-requirement table

Paths: `app/...` and `dashboard/...` are under the worktree; `e2e/...` likewise.
Abbreviations: BR = `app/src/routes/broadcasts.ts`, BAR =
`app/src/lib/blastAudienceRules.ts`, AR = `app/src/services/audienceResolution.ts`,
BC = `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`, RP =
`dashboard/src/routes/broadcasts/RecipientPreview.tsx`, AF =
`dashboard/src/routes/broadcasts/AudienceFilters.tsx`; test files: BAT =
`app/test/broadcastApi.test.ts`, BART = `app/test/blastAudienceRules.test.ts`,
ART = `app/test/audienceResolution.test.ts`, BCT =
`BroadcastComposer.test.tsx`, RPT = `RecipientPreview.test.tsx`, AFT =
`AudienceFilters.test.tsx` (dashboard tests under `dashboard/src/routes/broadcasts/`),
E2E = `e2e/tests/dashboard-next/matching-blast-rules.spec.ts`.

### D1 Status

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R1 | Filter audience holds only searching and onboarding tenants | "A FILTER-resolved audience holds tenants whose `status` is `searching` or `onboarding`, nothing else." | CONFORMS | BAR:19; AR:155-180 | ART:147; BAT:251 (estimate, preview and no-body send) |
| R2 | Two byTypeStatus partitions, searching FIRST, one page bound and truncation flag | "reads exactly those two `byTypeStatus` partitions ... `searching` FIRST, then `onboarding`, under the existing page bound and truncation flag" | CONFORMS | AR:110, :152-170, :232-239 | ART:157, :183, :202, :215, :234, :250 (on `contactsPartitionFake`) |
| R3 | byHousingAuthority branch removed; authority filtered in memory | "The `byHousingAuthority` branch is removed from the resolver; the housing authority becomes an in-memory filter (D2)." | CONFORMS | AR:147, :190-198 | ART:157 (`haQueries` empty), :482 (log field gone) |
| R4 | Every other fence unchanged | "Every other fence (type tenant, opt-out, unreachable, phone, voucher size, soft-deleted contacts hidden by `listByType`) is unchanged." | CONFORMS | AR:176, :183-189 | ART:277, :355, :374, :386 |
| R5 | Status-excluded not listed; hand picks keep any status | "Status-excluded tenants are NOT listed in the recipient review ... Hand-picked recipients (seeds, Add a tenant) keep any status." | CONFORMS | BR:777-780 (filter rows from the resolver only); BR:605-643 (seeds: no status fence) | BAT:3240 (`c-placing` absent, partner seed checked); E2E:313-314, :325-329 |

### D2 Housing authority list

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R6 | `AudienceFilter.housing_authorities?: string[]` | "`AudienceFilter` gains `housing_authorities?: string[]`." | CONFORMS | `app/src/repos/broadcastsRepo.ts:88-98`; `dashboard/src/api/types.ts:3271-3281` | BART:74-102; type-checked by every BAT D2 case |
| R7 | Any-of on the trimmed value; empty = no filter; non-empty leaves out blank and non-member | "A tenant matches when its `housingAuthority` (trimmed) equals any member ... While the list is non-empty, a tenant with no housing authority ... does NOT match and is NOT listed" | CONFORMS | AR:131-135, :193-198 | ART:296, :304, :319, :325; BAT:2572 |
| R8 | List shape guard, at most 100, exact 400 text | "an array of strings, at most 100 members ... else 400 `audience_filter.housing_authorities must be an array of at most 100 strings`" | CONFORMS | BAR:22; BR:192-199 | BAT:2500, :2519, :2632 |
| R9 | `orgNames.checkList('audience_filter', list, undefined, undefined)`; trimmed, blanks dropped, de-duplicated, spelling stored as name; FIRST failing member is the 422 with `text` = member | "Members are checked with the existing list check ... the FIRST failing member answered as today's 422 `org_not_on_list` body with field `audience_filter` and `text` set to that member." | CONFORMS | BR:209, :911-919; `app/src/lib/orgNames.ts:302-325` | BAT:2267, :2451, :2532, :2547, :2557 |
| R10 | Stored draft carries the list, never the string | "The stored draft carries `housing_authorities` and never `housing_authority`." | CONFORMS | BR:218-224 | BAT:2451, :2471 |
| R11 | Legacy body accepted as a one-member list | "`audience_filter.housing_authority` (a string) is still accepted when `housing_authorities` is absent and is treated as a one-member list." | CONFORMS | BR:200-206 | BAT:2249, :2471; `e2e/tests/dashboard-next/a2p-compliance.spec.ts:524-541` |
| R12 | Both keys is a 400 with the exact text | "Both present is a 400 `audience_filter: use housing_authorities only`." | CONFORMS | BR:188-190 | BAT:2487 |
| R13 | ONE normalizer for stored filters, used by resolver, refusal, preview, send (c) and every response | "read through ONE server normalizer (`authoritiesOfFilter(filter): string[]`): the list when present, else the old string as a one-member list, else `[]`." | CONFORMS | BAR:186-204; uses AR:147, BR:661, :449, :478, :985 | BART:74-102; ART:311; BAT:3351, :2754, :2775; `app/test/seedOrgNames.test.ts:148-160` |
| R14 | Responses send the list, never the legacy key; no dashboard normalizer | "Responses always send `housing_authorities` and never `housing_authority`, so the dashboard reads ONE shape and has no normalizer of its own." | CONFORMS (I1) | BAR:219-228; BR:449, :478, :985; `dashboard/src/routes/broadcasts/broadcastFormat.ts:63-69` | BART:105-151; BAT:2754, :2775; a2p-compliance.spec.ts:537-538 |
| R15 | storedFilterRefusal checks every member in order; candidate = its entry for a spelling | "`storedFilterRefusal` checks EVERY member of the normalized list for an exact listed name, in order, and answers the 422 for the first that is not" | CONFORMS | BR:658-681, :1018-1025, :1277-1282 | BAT:2346, :2687, :2705, :2715, :2734 |

### D3 Prefill from the property (D3a, D3b)

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R16 | The composer reads the organization list itself | "The composer reads the organization list itself (the list `AudienceFilters` reads today moves up to, or is shared with, the composer)." | CONFORMS | BC:155; AF:52-55, :197 | BCT:938 (a deferred list read gates the composer) |
| R17 | Prefill = the property's authorities mapped to entry names (exact or unique spelling), property order, de-duplicated | "each mapped to its entry name when it is the exact name, or a spelling of exactly one, housing authority entry ... in the property's order, de-duplicated" | CONFORMS | `dashboard/src/routes/broadcasts/authorityPrefill.ts:14-32`; BC:193-199 | `authorityPrefill.test.ts:30-77`; BCT:840; E2E:241-246 |
| R18 | Unmapped names noted | "the picker shows "Not used (not on the organization list): <names, comma separated>"" | CONFORMS | AF:42, :211-217 | AFT:267; BCT:840 |
| R19 | None mapped: the not-limited sentence | "When NONE of the property's authorities map, the same note is followed by "This blast is not limited by housing authority."" | CONFORMS (I2) | AF:44, :215; BC:745 | AFT:278, :287; BCT:856 |
| R20 | Multi picker "Housing authorities"; remove or add | "The picker becomes `OrgPicker multiple`, labeled "Housing authorities". Staff can remove any prefilled member or add others." | CONFORMS | AF:193-210 | AFT:147, :176; BCT:887; `matching-entry-points.spec.ts:291`, `:326` |
| R21 | Edit ownership while the property stays; value and ownership in one functional update | "While the property stays the same, a filter staff have edited is never overwritten (an edit is any pick, removal or clear by staff, and a member removed after a 422, D3b)." | CONFORMS | BC:204-220, :256-282 | BCT:868, :887, :716 |
| R22 | A different property empties both filters at once, then prefills fresh; no confirm; same property changes nothing | "both filters ... are RESET TO EMPTY at once and then prefilled fresh from the new property when it loads ... without a confirm (choosing the same property again changes nothing)" | CONFORMS | BC:484-491 (plus the id-keyed derivation at :185-186, :206) | BCT:887 (confirm spy never called) |
| R23 | Preview waits for the settle only with a property and the filters on | "ONLY while a property is attached and the filters are on, Preview stays disabled until the prefill has settled: the property has loaded or failed to load, and the organization list has loaded or failed." | CONFORMS | BC:228-229, :561-568; `useComposerDraft.ts:176`, `:285` (no draft while held) | BCT:938, :962, :976 |
| R24 | Failed property load settles, exact notice | "A failed property load counts as settled: nothing is prefilled from it and the filters show "Couldn't load the property, so its housing authorities and voucher size were not filled in."" | CONFORMS | BC:70-71, :231, :376 | BCT:962; AFT:295 |
| R25 | Failed list read settles, exact notice; the picker keeps its own error | "A failed list read counts as settled: nothing is prefilled and the filters show "Couldn't load the organization list, so housing authorities were not filled in from the property."" | CONFORMS (I5) | BC:73-74, :232; AF:207; `authorityPrefill.ts:18` | BCT:976; AFT:200 |
| R26 | An aborted load is neither loaded nor failed: the gate waits, no notice | "An ABORTED load ... is neither loaded nor failed: the gate keeps waiting and no notice shows." | CONFORMS | BC:369-378; `dashboard/src/routes/orgs/useOrgList.ts:91` | BCT:991 |
| R27 | A failed state belongs to its property and clears on load or property change | "A failed state belongs to the property it was for and clears when that property loads or the property changes." | PARTIAL (low) | BC:185-186, :490 | none pins the clearing (BCT:962, :991 never change or reload the property after a failure) |
| R28 | Resumed draft and seeds-only send never gated | "A resumed draft (`?draftId=`, no property on the client) and a seeds-only send (filters off) are never gated." | CONFORMS | BC:228 | BCT:1004, :1012 |
| R29 | D3a voucher size: first accepted size, owned by the property | "Voucher size keeps its current prefill value (the property's first accepted size) but gets the same belongs-to-the-property rule" | CONFORMS | BC:200, :208 | BCT:199, :212, :226, :432, :868, :887 |
| R30 | D3b remove THAT member only, exact notice, create and preview | "the composer removes THAT member only, keeps the others, and shows "<text> is no longer on the organization list, so it was removed from the filter."" | CONFORMS (I4) | BC:65-67, :256-268, :304, :533-538; `useComposerDraft.ts:254` | BCT:716, :750, :778 (late refusal after a property change) |

### D4 Tour holds

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R31 | The hold table, every row | "| `scheduled`, `scheduledAt` later than now | `upcoming` | ... | anything else ... | no hold |" | CONFORMS | BAR:91-114 | BART:153-274 (every row and boundary); BAT:3170 |
| R32 | One pure function of tour and now, shared by preview, create and send (c) | "The rule is a pure function of the tour and `now`, shared by preview, draft create and send path (c)" | CONFORMS | BAR:91-164; BR:694-703, :712-721 (called from :785 and :1288) | BAT:3170, :3503, :3687 |
| R33 | needs_placement covers a pending conversion claim | "`toured` with `convertible === true` (Move forward, placement not created or a conversion claim in flight)" | CONFORMS | BAR:101 | BART:276 |
| R34 | 14 days from createdAt; exactly 336 h holds no more | "`requested` created less than 14 days (336 hours) before now ... the 14 days are measured from the request's `createdAt`." | CONFORMS | BAR:16, :106-110 | BART:153-274 (1 ms short, exactly 336 h, 20 days) |
| R35 | One shown hold: kind order, earliest upcoming, latest others, ties by tourId | "ONE is shown, by kind order `needs_placement, upcoming, needs_outcome, not_marked, no_show, requested`; within `upcoming` the earliest `scheduledAt`, within the others the latest date; ties by `tourId`." | CONFORMS | BAR:34-41, :117-142 | BART:290-375; BAT:3324 |
| R36 | Keyed on the tour's tenantId, any contact type | "The hold is keyed on the tour's `tenantId` with no assumption about the contact's type" | CONFORMS | BAR:148-164 | BART:393; BAT:3240 (landlord and partner) |
| R37 | Held filter row LISTED unchecked, labeled; Select all skips; staff may check; send not blocked | "A held tenant matched by the filters is LISTED in the recipient review, UNCHECKED, with a reason label (D7). Select all skips them. Staff may check them; nothing stops the send." | CONFORMS | BR:800-822; RP:269-271; BR:1195-1246 (path a unfenced) | BAT:3170, :3838; RPT:1015; E2E:274-287, :316-323 |
| R38 | Hand pick never held: starts checked, keeps its label | "A hand-picked tenant ... is never held: the row starts checked and still shows the label." | CONFORMS | BAR:178-180; RP:325-362 | BAT:3240; RPT:1079, :1091, :1117 |
| R39 | A #27 Interested request holds other properties' blasts up to 14 days | "A tenant marked Interested on #27 whose click created a tour request is held from every other property's blasts for up to 14 days" | CONFORMS | follows from BAR:106-110 and the any-property read BR:694-703 (no special code) | BART:153-274; BAT:3170 (`c-req`, tour on another unit) |

### D5 Where the rules run

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R40 | ONE server function builds the review rows with the flags and the formula | "`checkedByDefault = hasConsent && (seeded || (!alreadySent && !declined && !tourHold))`" | CONFORMS | BR:746-833; BAR:178-180 | BART:405-439 (all 32 combinations); BAT:3240 |
| R41 | Preview returns the rows; create counts them | "Preview returns those rows; POST create counts them (D8)." | CONFORMS | BR:936-946, :1037-1091 | BAT:3503 (create and preview agree) |
| R42 | Dashboard reads the server flag for the initial state and Select all; ONE client case for a hand pick made on the review step | "The dashboard uses the server's `checkedByDefault` for the initial state and for Select all and no longer computes the rule itself, with ONE client-side case" | CONFORMS | RP:123-145, :269-271, :329, :358 | RPT:1001, :1015, :325 (the `:315-360` pin kept), :1091, :1117, :1161 |
| R43 | Already-sent stays a never-throwing soft hint | "This change keeps that: a throttled already-sent read can leave an already-sent tenant checked. Only the tours and decline reads fail closed." | CONFORMS | BR:796-799 | BAT:1539 |
| R44 | The send ships exactly the reviewed list | "The send ships exactly the list staff reviewed (path (a)), so preview and send cannot disagree." | CONFORMS | RP send (unchanged); BR:1195-1246 | RPT:475; E2E:331-346 |
| R45 | One open-tours read: three partitions to the end, `requested` bounded by createdAt >= now - 14 days, grouped by tenant | "the `byStatus` partitions `scheduled`, `toured` and `no_show` to the end ... plus `requested` with the key condition `createdAt >= now - 14 days`" | CONFORMS | BR:694-703; `app/src/repos/toursRepo.ts:225`, `:442-460` | BAT:3303; `app/test/toursRepoListByStatusRange.test.ts:43-112`; `app/test/toursRepo.integration.test.ts:446` |
| R46 | Filter drafts fail CLOSED: 503 `audience_rules_unavailable`, no list; the decline degrade removed | "preview answers 503 `{ error: 'audience_rules_unavailable' }` and serves no list ... The #27 `declineLabelsUnavailable` degrade is REMOVED for those drafts." | CONFORMS | BR:788-795, :1046-1051 | BAT:3073, :3078, :3083, :3378, :3389, :3170 (no `declineLabelsUnavailable`) |
| R47 | Seeds-only degrade: rows without labels, flag set, notice copy, never blocked | "a failed read there serves the rows WITHOUT tour or decline labels and sets `audienceRulesUnavailable: true`; the review shows "Tour and Not interested labels couldn't be loaded."" | CONFORMS | BR:788-795, :1123; RP:534-538 | BAT:3399, :3432; RPT:1140, :1148 |

### D6 Send paths

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R48 | (a) unchanged | "(a) Explicit list (the dashboard): UNCHANGED. No status, tour or decline fence" | CONFORMS | BR:1195-1246 | BAT:3838, :996, :1018 |
| R49 | (b) unchanged | "(b) `seeds_only` with no body: UNCHANGED (hand-picks skip the rules)." | CONFORMS | BR:1247-1259 | BAT:3852, :2006 |
| R50 | (c) resolved minus held minus declines; already-sent and no-consent kept; seeds out | "the recipients are the D1/D2 resolved audience MINUS held tenants ... MINUS effective #27 declines. Already-sent tenants and tenants without recorded consent are NOT subtracted" | CONFORMS | BR:1260-1334 | BAT:3687; a2p-compliance.spec.ts:495-541 (`skipped_no_consent`) |
| R51 | (c) thrown rules read is 503, draft stays a draft | "A thrown rules read answers 503 `audience_rules_unavailable` and leaves the draft a draft." | CONFORMS | BR:1284-1293 | BAT:3711, :3727, :3741, :3761 |
| R52 | (c) truncation refused; cap compares the final count; empty final set is 400 | "A truncated resolution is refused as today; the recipient cap compares the final recipient count (after the exclusions); an empty final set is today's 400 `empty_audience`." | CONFORMS | BR:1297-1327 | BAT:694, :3781, :3795, :3819 |

### D7 Recipient review

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R53 | Preview fields: per-candidate `tourHold`, `checkedByDefault`; top-level `tourHolds` (every held contact), `audienceRulesUnavailable` (seeds-only); `declineLabelsUnavailable` removed | "Top level: `tourHolds: Array<{ contactId, kind, tourId, at? }>` for EVERY held contact ... `declineLabelsUnavailable` is removed." | CONFORMS | BR:1087-1090, :1120-1123; `dashboard/src/api/types.ts:3494-3551` | BAT:3170, :3240 (holds outside the rows), :3399 |
| R54 | Tour tag after Not interested, amber style | "Tour label (a tag after Not interested, same amber style" | CONFORMS | RP:624-630 | RPT:1040 (all three tags on one row), :1015 |
| R55 | Held row gets the amber row class | "the row gets the same amber row class" | PARTIAL (low) | RP:571 | none asserts the row class |
| R56 | Label copy per kind, browser-local `shortDate`, no-date form; revision 6 `requested` label | "`requested`: "Tour requested Oct 12, no date yet" (revision 6; with no date: "Tour requested, no date yet" ...)" | CONFORMS | `dashboard/src/routes/broadcasts/tourHoldLabel.ts:8-28` | `tourHoldLabel.test.ts:8-32`; E2E:278-281 |
| R57 | Accessible name: literal format, cue order, lower-case tour label; no-consent unchanged; old two-cue strings unchanged | "`<name>` followed, when any cue applies, by ` - ` and the cues joined with `, ` in this order: `already sent`, `not interested`, then the tour label in lower case" | CONFORMS | RP:112-119 | RPT:1040 (`Ana Diaz - already sent, not interested, tour oct 20`), :1091 (`... tour requested oct 12, no date yet`), :904, :921; E2E:282-283 |
| R58 | Add a tenant note: every cue, ordered Not interested, Already sent, tour label | "the applicable cues in the order `Not interested`, `Already sent`, then the tour label, joined with `, `" | CONFORMS | RP:473-480 | RPT:975, :1091 |
| R59 | Added row starts checked and carries its labels | "The added row starts checked and carries its labels." | CONFORMS | RP:336-362 | RPT:1091, :306 |
| R60 | The existing note stays | "The existing note "Flagged recipients you picked stay checked; "Select all" skips the others." stays as is." | CONFORMS | RP:497 | RPT:264 |
| R61 | 503 keeps compose, exact copy, Try again re-runs the preview | "keeps staff on the compose step with "Couldn't check tours and Not interested replies, so the recipient list can't be shown yet." and a "Try again" button that re-runs the preview." | CONFORMS | BC:76-77, :539-543, :591-597, :786-797 | BCT:1022, :1080 |
| R62 | Truncation copy: review alert, reach suffix, server truncation message without the advice | "the review's alert reads "Too many tenants to read - some matches may be missing from this list." and the reach suffix reads " - the list is incomplete"." | CONFORMS (I3) | RP:702; AF:46, :258; BR:1320-1321 | RPT:1153; AFT:359; BCT:245; BAT:731 |

### D8 Caption and reach

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R63 | Caption copy; second sentence only while the list is non-empty; under the filters while they are on | ""Only tenants in Onboarding or Searching are included. While a housing authority is selected, tenants whose housing authority is missing or not on the organization list are left out. Add any other tenant by hand when you review recipients."" | CONFORMS | AF:37-40, :241-245 | AFT:320, :326; BCT:840; E2E:249 |
| R64 | "Reaches N recipients" = the default-checked count, stored as `estimatedAudience` / `stats.audience` | "POST create runs the D5 function and answers `estimatedCount` = the count of `checkedByDefault` rows (stored as `estimatedAudience`, i.e. the draft's `stats.audience`)." | CONFORMS | BR:933-950, :961, :980; AF:251-254 | BAT:3503; AFT:353; BCT:237; E2E:265-266, :310 |
| R65 | Seeds-only create: no rules reads, counts seeds with consent | "A `seeds_only` draft runs NO rules reads at create: every row is a seed, so its count is the seeds with recorded consent." | CONFORMS | BR:753-776 | BAT:3535 |
| R66 | Filter create runs the three reads; the ALONE comments updated | "the "ALONE" comments at `broadcasts.ts:111-114` and `:757-760` are updated to say create reads it too." | CONFORMS | BR:130-135, :740-744, :1419-1423 | BAT:3598, :1694 |
| R67 | A thrown rules read at create: draft created, estimate omitted, "Reach estimate unavailable", `stats.audience` 0 | "the draft is still created, `estimatedCount` is omitted, the line shows today's "Reach estimate unavailable", and the stored `stats.audience` is 0" | CONFORMS | BR:947-950, :961, :980; `dashboard/src/api/endpoints.ts:1997-2001`; AF:256 | BAT:3553, :3571, :3582; BCT:1069 |
| R68 | Readers of `stats.audience` unchanged | "Every reader of a draft's `stats.audience` now shows the default-checked count" (section 7: "no code change expected") | CONFORMS | `BroadcastsList.tsx:47`, `:221`; `BroadcastResults.tsx:208`; `StatChips.tsx:40` (untouched) | existing reader tests untouched; nothing new to pin |
| R69 | Preview lists at most 1000 rows; create counts all | "A preview lists at most 1000 rows ... while create counts them all" | CONFORMS | BR:1054 | BAT:3616 |

### D9 Available-only picker

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R70 | List and search offer only Available, on the bare and `?contactId=` entries | "The composer's property list and its search offer only properties with status `available`, on EVERY entry that shows the picker" | CONFORMS | BC:340-363 (filter at :345), :608-613 | BCT:1417, :1430; E2E:222-239 |
| R71 | Empty-state copy | "With none, the empty state reads "No Available properties. A property must be Available to send."" | CONFORMS | BC:677 | BCT:1438 |
| R72 | `?unitId=` keeps any status, with the banner and Make Available | "A property preselected by `?unitId=` ... is kept whatever its status, with today's banner and Make Available dialog." | CONFORMS | BC:341 (no read), :511-519 | BCT:1448 |
| R73 | Picker loading, failed and aborted states (work map S3) | (work map) "Available-only property picker with loading/failed/aborted states" | CONFORMS | BC:340-363, :672-678 | BCT:1470, :1481, :1489 |

### D10 Caseworkers

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R74 | Partners never in a filter audience, pinned; join only as a seed or a checked row | "Caseworkers (contact type `partner`) are never part of a filter-resolved audience, whatever their status or housing authority - today's behavior (the resolver's type fence), kept and pinned with tests." | CONFORMS | AR:155-176 (tenant partitions plus the type belt); BR:414-416 | ART:339, :355; BAT:2936, :2848, :2904 |
| R75 | Add a tenant finding caseworkers deferred and filed | "Letting Add a tenant find caseworkers is deferred (`docs/issues/matching-add-recipient-search-caseworkers.md`)." | CONFORMS | `docs/issues/matching-add-recipient-search-caseworkers.md` (new) | n/a |

### Section 4 Consequences

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R76 | Truncation issue resolved with the note | "Resolve `broadcast-audience-truncation-drops-searching-tenants` with that note (the bound and the truncation refusal remain; within the wanted set the read order is searching first)." | CONFORMS | `docs/issues/broadcast-audience-truncation-drops-searching-tenants.md:6-9` and its Resolution block | ART:183 |
| R77 | GSI, `listByHousingAuthority`, tests and fakes kept; no removal issue; only comments corrected | "the GSI, `contactsRepo.listByHousingAuthority`, its tests and its fakes are left in place, and no issue proposes removing them." | CONFORMS | `app/src/repos/contactsRepo.ts:770-777`, `:1401-1402` (comments only); no new issue names the GSI | ART fake keeps `listByHousingAuthority` (ART:61-64) |
| R78 | Changing the property replaces edited filters, no confirm | "Changing the property in the composer replaces edited filters with the new property's prefill (no confirm)." | CONFORMS | BC:484-491 | BCT:887 |
| R79 | A failed tours or decline read blocks a filter preview (Try again); a direct send shows a notice | "A failed tours or decline read blocks a filter blast's preview (with Try again) instead of showing a list without Not interested labels; a direct send shows a notice instead." | CONFORMS | see R46, R47, R61 | see R46, R47, R61 |
| R80 | A direct send to a tenant with a tour shows the label, row checked | "A direct send from a tenant's page to a tenant with a tour shows the tour label but the row stays checked." | CONFORMS | BAR:178-180; RP:624-630 | BAT:3399; RPT:1079 |
| R81 | Remaining consequences (status, no-authority leads, smaller reach, Available-only on contact pages, accepted exposures, throttled already-sent) | section 4 bullets 1-4, 10, 12 | CONFORMS | follow from R1, R7, R64, R70, R31, R43 | as cited there |

### Section 5 Out of scope

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R82 | Nothing out of scope built | "Voucher size as a list ... Removing the `byHousingAuthority` GSI ... Server-side closing of a Not a fit tour ... Restoring a stored filter ... Any change to what the property page, Sent to list or Follow up tab show." | CONFORMS | diff file list: no change to voucher-size shape, `tours.ts`, the property page, Sent to, Follow up, or draft resume | n/a |

### Section 6 Testing

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R83 | Unit (app): hold rule, review rows, resolver, create, preview, send (c), open-tours read | "Unit (app): - The hold rule: every row of the D4 table, the boundaries ..." | CONFORMS | n/a | BART (whole file); ART:146-490; BAT:2437-2810, :3091-3860; `toursRepoListByStatusRange.test.ts` |
| R84 | Unit (dashboard) list | "Unit (dashboard): rows use `checkedByDefault`; Select all; ... `audienceSummary` for a list (names joined with ", ")." | CONFORMS | n/a | RPT:996-1200; AFT:146-365; BCT:695-1100, :1401-1500; `tourHoldLabel.test.ts`; `authorityPrefill.test.ts`; `broadcastFormat.test.ts:35` |
| R85 | e2e new spec: two run-unique authorities; seven tenants with explicit status, authority and consent; the listed assertions; no backdating seam | "e2e (new spec): one property accepting two run-unique listed authorities ... Assert: both authorities prefilled; the caption; the reach line equals the checked count; ..." | CONFORMS | n/a | E2E:167-347 (authorities :176-180; tenants :191-198; prefill :241-246; caption :249; reach :265-266, :310; absent :313-314; holds :277-287; Select all :316-323; picker :222-239; Add a tenant :325-329; outbox :331-346) |

### Section 7 Inventory

| # | Requirement | Spec quote | Verdict | Code | Test |
|---|---|---|---|---|---|
| R86 | Seeds: one legacy-shape broadcast kept, one moved to the list | "keep ONE legacy-shape broadcast so the full world exercises the normalizer, move the other to the list shape." | CONFORMS (I6) | `app/src/lib/seed/matrix.ts:1224-1232`, `:1260-1265` | `app/test/seedOrgNames.test.ts:148-160` |
| R87 | Server inventory: type, parse, create, review rows, refusal, preview, send (c), projections, router header, `audience_too_large` messages, ALONE comments | "`app/src/repos/broadcastsRepo.ts:84-90` (type), `broadcasts.ts` `parseAudienceFilter`, POST create ..., the router header comment (`:6-28`), the `audience_too_large` messages ..." | CONFORMS | BR:6-39, :130-135, :175-225, :449, :478, :746-833, :838-991, :1006-1125, :1260-1334, :1419-1423; `broadcastsRepo.ts:76-98` | see D2, D5, D6, D8 rows |
| R88 | `audienceResolution.ts`: whole read, header, truncation TODO, log field | "`audienceResolution.ts` (whole read; header comment; the truncation TODO; the `byHousingAuthority` log field)." | CONFORMS | AR:1-38, :145-257 (TODO gone, log at :241-249) | ART:482 |
| R89 | `toursRepo.ts` open-tours read | "`toursRepo.ts`: the open-tours read (the `requested` range condition)." | CONFORMS | `toursRepo.ts:218-225`, `:442-460` | `toursRepoListByStatusRange.test.ts:83-112` |
| R90 | Harness fake models the `requested` range condition | "The harness fake `toursRepo` ... must model the `requested` range condition." | CONFORMS | `app/test/helpers/twilioWebhookHarness.ts:3964-3975` | `toursRepoListByStatusRange.test.ts:114` |
| R91 | Comments naming `byHousingAuthority` as the broadcast key corrected; GSI untouched | "`contacts.ts:650`, `dev.ts:1263`, `lib/import/apply.ts:1208`, `lib/seed/lean.ts:109`, `contactsRepo.ts:770-775`" | CONFORMS | `app/src/routes/contacts.ts:650-653`; `app/src/routes/dev.ts:1263-1265`; `app/src/lib/import/apply.ts:1208-1211`; `app/src/lib/seed/lean.ts:109`; `contactsRepo.ts:770-777`; also `dashboard/src/api/types.ts:2273-2275` | n/a (comments) |
| R92 | Dashboard inventory: types, endpoints, hook, AudienceFilters, composer, RecipientPreview, `audienceSummary` | "`api/types.ts` ..., `endpoints.ts` `createBroadcast`, `useComposerDraft.ts` (draft key, create body, 422 handling, the reach count), `AudienceFilters.tsx` ..., `BroadcastComposer.tsx` ..., `RecipientPreview.tsx` ..., `broadcastFormat.ts` `audienceSummary`." | CONFORMS | `types.ts:3271-3281`, `:3494-3551`; `endpoints.ts:1981-2011`; `useComposerDraft.ts:45-58`, `:106`, `:176`, `:254`, `:285`; AF:1-262; BC (above); RP (above); `broadcastFormat.ts:63-69` | see D3, D7, D8 rows; `broadcastFormat.test.ts:35` |
| R93 | Tests pinning today's shape updated; e2e tenants explicit status, consent and run-unique authority; no-consent exception kept; selectors and docs updated | "e2e tenants get an explicit status, recorded consent, and a RUN-UNIQUE on-list authority ... EXCEPTION: a tenant whose PURPOSE is to have no recorded consent keeps none" | CONFORMS | `broadcasts.spec.ts`, `review-recipients-heard-from.spec.ts`, `a2p-compliance.spec.ts:352-369`, `:495-541`, `org-lists.spec.ts`, `matching-entry-points.spec.ts:289-291`, `:326`; `e2e/support/selectors.md:132-134`, `:147-148`; `documentation/GLOSSARY.md:125-142`, `:341-344`; `RUNBOOK.md:1456-1459`; truncation issue resolved; `BroadcastComposer.prefill.test.tsx` already mocks `getOrgList` (`:13`, `:59`) | the specs themselves; RPT:325 keeps the `:315-360` promoted-row pin |


## Round 2

Re-review at dc073cc7 against spec REVISION 7 (D3 Timing rewritten: a failed
read HOLDS with "Try again"; the "Not used" note ends with a period; build
clarification 8f651ecf: a failed list read is not tied to a property). Fix
diff reviewed cold: `git diff b1bb9dc9..dc073cc7 -- . ':(exclude)docs/superpowers'`
(22 files). Read-only; no suites run. Only the planner's `adjudications.md`
was read under `docs/superpowers/reviews/`.

### Counts

| Set | CONFORMS | PARTIAL | DEVIATES | MISSING |
|---|---|---|---|---|
| Revision 7 D3 and round-1 closures (R2-1..R2-18) | 17 | 1 | 0 | 0 |
| Fix-diff findings (not spec rows) | - | - | - | - |

Fix-diff findings: 1 low (F1), 6 info (N1-N6). Adjudications: 0 contested,
all conceded (one with a caveat, C1).

Round-1 table status after this pass: R27 and R55 now CONFORMS (pinned);
R23, R24 and R25 are superseded by R2-1..R2-9 (revision 7); R26's list half
is R2-11 (PARTIAL, a round-1 miss of mine). Net over the round-1 rows plus
R2-11: 0 DEVIATES, 0 MISSING, 1 PARTIAL.

### Non-CONFORMS and findings, by severity

| # | Item | Severity | Why |
|---|---|---|---|
| F1 | PA-5 fix covers an ABSENT stored filter but not a NULL one | low | `wireAudienceFilter` returns early only for `undefined` (`app/src/lib/blastAudienceRules.ts:225`); a stored `audience_filter: null` (a DynamoDB NULL attribute - as likely from a hand repair as an absent one) reaches `authoritiesOfFilter`, which also checks only `=== undefined` (`:189`) and then reads `filter.housing_authorities` (`:190`): a TypeError, so one such row still 500s the whole Matching list (`app/src/routes/broadcasts.ts:450`, `:480`) - the exact failure PA-5 was fixed to remove. The dashboard twin has the same gap (`dashboard/src/routes/broadcasts/broadcastFormat.ts:67`). The new test seeds only a deleted key (`app/test/broadcastApi.test.ts:2811`). Fix: `== null` in both guards and one null row in that test. |
| R2-11 | D3 "An ABORTED load ... is neither loaded nor failed: the gate keeps waiting and no notice shows." - for the ORGANIZATION LIST read | low (PARTIAL) | Implemented (`dashboard/src/routes/orgs/useOrgList.ts:91` returns without touching `loading` or `error`, so `orgListHold` stays false and the gate waits), but unpinned: the only aborted-read test is the property's (`BroadcastComposer.test.tsx:1054`), and `useOrgList`'s tests cover abort only for the poll path. Under revision 7 a mis-handled list abort would now raise a HOLD notice (StrictMode's first mount in dev, a double Try again), not just settle. I missed this in round 1 (R26 cited the property test alone). |
| N1 | The reach line says "Estimating reach..." for as long as a failure hold stands | info | `reachPending` is true whenever `hold` is (`useComposerDraft.ts:287`), and the reach line renders it as an in-progress `role="status"` (`AudienceFilters.tsx:274`). During a FAILURE hold nothing is estimating - FW2-1 removed the hint and spinner beside Preview for exactly this reason (`BroadcastComposer.tsx:839`, `:848`), but the reach line keeps the same misleading-progress signal. Deliberate (the code comment cites AR44; `expectHeld` pins it, `BroadcastComposer.test.tsx:843-851`), so a note, not a defect. Suggest the reach line read nothing (or "Reach estimate unavailable") while `heldOnFailedRead`. |
| N2 | "Try again" gives no feedback | info | No busy state while the retry runs, and a repeat failure leaves the identical alert in place (`AudienceFilters.tsx:239-245`; same key, same text), so neither sighted users nor assistive tech can tell a failed retry from a click that did nothing. Spec-conformant ("on another failure the notice stays"). |
| N3 | A permanent property failure holds forever | info | A 404 for a mistyped or removed `?unitId=` now shows "can't be filled in yet" with a Try again that can never succeed (`BroadcastComposer.tsx:71-72`, `:248-249`); revision 6 let staff compose without the prefill. No send is lost (a send of a missing property is refused `unit_not_available` anyway, `broadcasts.ts:1163-1169`); copy only. |
| N4 | Spec text left behind by revision 7 | info | Section 6 still lists "a failed property load and a failed list read each settling with their notice" (spec :645-647), and D3's first Timing sentence (spec :290) requires the list to "have loaded" while the no-authority bullet lets a failed list read settle. The code follows the bullets. |
| N5 | The e2e hold proves "no draft" with a fixed sleep | info | `page.waitForTimeout(1_500)` to outlast the 600 ms debounce (`e2e/tests/dashboard-next/matching-blast-rules.spec.ts:419`). Acceptable: the hold is also unit-pinned (`BroadcastComposer.test.tsx:1013`, `:1109`). |
| N6 | A filter draft stored without a filter still 500s its own preview and no-body send | info | The resolver reads `filter.excludeOptedOut` (`app/src/services/audienceResolution.ts:183`). Per-row, not page-wide, and main crashed there too; PA-5's scope was the list. |

### Revision 7 D3, re-checked with fresh eyes

Abbreviations as in round 1 (BC = `BroadcastComposer.tsx`, AF =
`AudienceFilters.tsx`, BCT / AFT their tests, E2E the new spec).

| # | Requirement | Spec quote (revision 7) | Verdict | Code | Test |
|---|---|---|---|---|---|
| R2-1 | Gate: Preview waits until the property LOADED and the list LOADED, only with a property and the filters on | "Preview stays disabled until the prefill has settled: the property has loaded, and the organization list has loaded." | CONFORMS (N4) | BC:228, :243-246 (`unit === null` now covers loading AND failed) | BCT:938 (list still loading: hint and spinner shown), :994, :1013 |
| R2-2 | Failed property load holds: no draft, Preview disabled, exact notice, Try again loads the property again | "the filters show "Couldn't load the property, so its housing authorities and voucher size can't be filled in yet." with a "Try again" button that loads the property again." | CONFORMS | BC:71-72 (copy matches character for character), :139, :243, :248-249, :386-404 (`unitRetry` dependency); AF:52-56, :239-245 | BCT:994, :1070; AFT:324, :343 |
| R2-3 | Failed list read holds when the property accepts an authority: exact notice, Try again re-reads the list, the picker keeps its own error | "the filters show "Couldn't load the organization list, so housing authorities can't be filled in from the property yet." with a "Try again" button that reads the list again (the picker shows its own error as today)." | CONFORMS | BC:75-76 (copy exact), :244-246, :251 (`orgList.reload`); AF:216 (picker disabled), picker error `orgCopy.ts:150-152` | BCT:1013 (two alerts: the picker's "Couldn't load housing authorities" and the hold), :1109; AFT:324; E2E:377-441 (routed 500) |
| R2-4 | No-authority exception: a failed list read does not hold a property accepting none | "When the property accepts NO housing authority there is nothing to fill in, so a failed list read does not hold." | CONFORMS | BC:244-245 (blank names do not count; reads `authoritiesOf`, the prefill's own reader, so a legacy `jurisdiction` counts as accepted) | BCT:1145 |
| R2-5 | Try again re-runs ONLY the failed read | ""Try again" re-runs only the failed read." | CONFORMS | BC:249 (bumps `unitRetry`, a dependency of the load effect alone), :251 | BCT:1070 (`getOrgList` stays at 1 call), :1109 (`getUnit` stays at 1); AFT:343 |
| R2-6 | While it runs, the notice and the hold stay | "While it runs, the notice and the hold stay" | CONFORMS | property: the failed result stays in `unitLoad` until the retry's own result lands (BC:388-404); list: `reload` never resets `error`, which stays true until a read succeeds (`useOrgList.ts:77-99`) | BCT:1070, :1109 (deferred retry; `expectHeld` while pending) |
| R2-7 | On success the prefill settles and the notice goes | "on success the prefill settles as usual and the notice goes" | CONFORMS | as R2-6 | BCT:1070, :1109 (exactly one draft, with the prefill); E2E:427-441 |
| R2-8 | On another failure the notice stays | "on another failure the notice stays." | CONFORMS (N2) | as R2-6 | BCT:1095, :1134 |
| R2-9 | The voucher size still fills in while a failed list read holds | "The voucher size still fills in from a loaded property while a failed list read holds." | CONFORMS | BC:205 (derived from the loaded `unit`, independent of the list) | BCT:1013 (2-BR pressed during the hold), :1109 (`bedroomSize: 2` in the draft after the retry) |
| R2-10 | An aborted PROPERTY load is neither: gate waits, no notice, no Try again | "An ABORTED load ... is neither loaded nor failed: the gate keeps waiting and no notice shows." | CONFORMS | BC:394-401 | BCT:1054 |
| R2-11 | An aborted ORGANIZATION LIST read is neither | (same sentence) | PARTIAL (low) | `useOrgList.ts:91` | none (see the findings table) |
| R2-12 | A failed property load belongs to its property: clears when it loads or the property changes | "A failed PROPERTY LOAD belongs to the property it was for and clears when that property loads or the property changes." | CONFORMS (round-1 R27 closed) | BC:185-186 (id-keyed), :515 (a re-pick of the same failed property resets it) | BCT:1070 (clears on load), :1175 (clears at once on a change, before the new property loads) |
| R2-13 | A failed list read is not tied to a property: it holds every property that accepts an authority until a read succeeds | "A failed organization-list read is not tied to a property: it holds every property that accepts a housing authority until a list read succeeds" | CONFORMS | BC:245 (no property in the condition) | BCT:1145 (no hold on 12 Oak St, then a hold on 77 Peachtree St from the same failed read, no draft for it) |
| R2-14 | Resumed draft and seeds-only send never gated | "A resumed draft ... and a seeds-only send (filters off) are never gated." | CONFORMS | BC:228 (`prefillGated` is in every hold and every notice condition, BC:246, :248, :251) | BCT:1210, :1218 |
| R2-15 | A stale list (read before an authority was added) is not a failure: the name shows in "Not used" | "An organization list read before an authority was added to the list ... is NOT a failure: that authority shows in the "Not used" note as above" | CONFORMS | `authorityPrefill.ts:14-32` (loaded list, unmatched name -> unused) | `authorityPrefill.test.ts:44`; BCT:840 |
| R2-16 | "Not used" note ends with ONE period; the not-limited sentence follows | ""Not used (not on the organization list): <names, comma separated>." (revision 7: the note ends with a period)" | CONFORMS (round-1 I2 closed) | AF:155-157 (no second period after a name already ending in one), :231-233 | AFT:267, :278, :287, :301, :313; BCT:840, :856 |
| R2-17 | The held row gets the amber row class | "the row gets the same amber row class" | CONFORMS (round-1 R55 closed) | RP:571 | RPT:1042 (held row has it, a plain row does not) |
| R2-18 | Seed comment names both authorities of the list-shape draft | (section 7 seeds) | CONFORMS (round-1 I6 closed) | `app/src/lib/seed/matrix.ts:1260-1263` | n/a (comment) |

### The fix diff, reviewed cold

- Hold condition (BC:243-251): traced every interleaving I could construct -
  property loading / failed / loaded x list loading / failed / loaded x
  property accepts or not; a property and a list failure together (mutually
  exclusive notices: the list hold needs a loaded property, so the property
  notice shows first and the list notice follows its successful retry -
  sequential, conforming); a retry racing a property change (the effect
  cleanup aborts it; the abort is ignored); a double Try again (the second
  aborts the first, both reads); a create in flight when a hold begins (the
  hook's generation bump deletes it on landing). No defect found. At most one
  hold notice can show, so at most one "Try again" sits under the picker, and
  the 503 refusal's "Try again" cannot coexist with a hold (a hold makes no
  draft, so no current refusal).
- `heldOnFailedRead` (BC:256, :839, :848) implies `prefillPending` (each
  notice is pushed only under a condition `prefillPending` includes), so
  hiding the hint and spinner never hides them while Preview could run.
- The draft hook's `hold` (`useComposerDraft.ts:177`) returns before the
  no-message exit, so a hold neither creates nor deletes a draft; an older
  draft left in place cannot be previewed because `canPreview` also requires
  `!prefillPending` (BC:586-593). Sound.
- Rewritten tests versus the ones they replaced: the two old "settles" tests
  pinned the notice copy, Preview enabling after a message, and the exact
  draft filter (none, or `bedroomSize: 2`). Revision 7 reverses the second;
  the copy is re-pinned verbatim, and the draft filter is now pinned AFTER a
  successful retry (`BroadcastComposer.test.tsx:1070`, `:1109`), including
  the voucher size. The aborted-load test kept its assertions and gained the
  spinner and no-Try-again checks. The AudienceFilters notice test went from
  plain text to alert role plus a per-notice retry spy (AFT:324, :343).
  Nothing the old tests pinned was dropped except the revision 6 behavior.
  Mutations I checked by reading: dropping `unitAcceptsAuthority` fails
  BCT:1145; dropping `orgListHold` from the gate fails BCT:1013 / :1109;
  reverting to `loaded === null` fails BCT:994; dropping `heldOnFailedRead`
  fails `expectNoPreviewHint`; a retry that also re-read the other source
  fails the call-count asserts in BCT:1070 / :1109.
- The R55 test reads the CSS-module class (`styles.rowAlready!`) under the
  dashboard's `css: false` vitest config (`dashboard/vite.config.ts:139`); the
  same pattern already pins classes elsewhere (`AppFrame.test.tsx:115-116`),
  so I accept it as a real pin.
- PA-5 (`wireAudienceFilter` overloads, BAR:222-225; dashboard types made
  optional, `dashboard/src/api/types.ts` BroadcastSummary / BroadcastResults;
  `audienceSummary(undefined)`): correct for an absent field; see F1 for null.

### Adjudications (contest or concede)

- R27, R55, I2, I6 (FIX): verified closed above. Agree.
- I1, I3 (NOTE): concede.
- I4 (NOTE, already filed): concede.
- I5 -> Cameron's decision: implemented as revision 7 says (R2-1..R2-13).
- C1, the planner's "PA-9 needs nothing further: a stalled read ends in an
  error": concede, with a caveat for the record - the dashboard client sets
  no request timeout (`dashboard/src/api/client.ts:117-127`), so a stalled
  read ends only when something upstream gives up (in deployed environments
  CloudFront or the load balancer answers 504; locally possibly never).
  Until then the composer shows the loading hint and spinner with no Try
  again. Fine to leave.

Nothing contested.
