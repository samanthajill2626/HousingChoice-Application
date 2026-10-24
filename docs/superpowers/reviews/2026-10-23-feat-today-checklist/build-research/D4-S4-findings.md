D4 (delta reader, S4 Today server): checked plan sections 0-4 and S4.1-S4.8 (plan lines 9049-14352) against the live tree at main @970a29b9 (worktree W:\tmp\today-checklist): every quoted anchor in app/src/services/followUps.ts, app/src/routes/today.ts, app/src/routes/api.ts, app/scripts/seed-smoke.mjs, app/test/followUps.test.ts, app/test/followUpsApi.test.ts, app/test/todayApi.test.ts and app/test/todayUnmatchedNonRegression.test.ts (all found verbatim, modulo the [U+xxxx] notation); names/signatures (FollowUpsDeps, RecipientDisplay, ToursRepo.listByStatus, UnitsRepo.getById/listByStatus, formatAddress, TERMINAL_STAGES/PLACEMENT_STAGES, IncompleteBatchReadError, the harness world.units/listingSends/unitsRepo/listingSendsRepo/toursRepo and S1's recipientDisplayCalls shape); per-commit tsc and lint (no import left unused, isOneToOneBucket removal safe, 'unreplied' literal comparisons gone before the union drops it); every RED/GREEN claim re-derived; every existing todayApi case that reads an unreplied row or an unknown_1to1 row with a non-unknown owner (PR40/PR59 list is complete - no missed case); the WI7 spy counts; the WARN-capture path; the S5 wire mirror.

## D4-1 - BLOCKER (verification step; two-line comment fix)

Plan location: S4.5 Step 3g (plan line 12556) and Step 3k (plan line 12808), against S4.5 Step 4 (plan lines 12906-12910) and S4.8 Step 1 (plan lines 14212-14220).

What the plan says: S4.5 Step 4 runs `git grep -n -i "unreplied\|isOneToOneBucket" -- app/src/routes/today.ts` and says "Expect NO output (exit 1)". S4.8 Step 1 runs `git grep -n -i "unreplied" -- app/src app/scripts` and says "Expect exactly ONE hit" (the seed-smoke comment), treating any other app/src hit as a missed reader to remove and commit.

What the tree will hold: S4.5's own replacement text puts the token back into today.ts. Step 3g's new comment line 2 reads "// PR26). Unreplied is gone: a known contact's unread thread feeds only", and Step 3k's new comment reads "// AI-suggestions (spec 2026-10-23 2: Unreplied is gone).". The case-insensitive sweep at S4.5 Step 4 therefore prints two lines. S4.6 Step 3f (plan lines 13428-13447) replaces the 3k comment, but the 3g comment survives, so S4.8 Step 1 finds two hits (today.ts collect-loop comment + app/scripts/seed-smoke.mjs:298 rewrite), not one. Both steps cannot go green as written. S4.8 would push the builder into an unplanned "missed reader" commit.

Correction: in S4.5 Step 3g replace new-text line 2 with "// PR26). The known-contact unread section is gone: a known contact's unread thread feeds only" (keep the rest of the comment), and in S4.5 Step 3k replace the second new-text line with "// AI-suggestions (spec 2026-10-23 2).". No other S4.4-S4.7 replacement text contains the token (verified), so both sweeps then hold exactly as written.

## D4-2 - MINOR

Plan location: S4.7 Step 1f (plan lines 13907-13916), with PR57 (plan lines 601-603) and Contradiction C1 (plan lines 9079-9091); world built by S4.6 Step 1f (plan lines 13229-13237).

What the plan says: the non-regression test asserts quietShares is { status: 'ok', ... } before the flood, with the comment "'ok' (not 'unavailable') proves the core's reads hit THIS prefix's tables"; PR57/C1 say this makes a mis-wired repo go red.

What the tree holds: the non-regression world seeds no unit item (S4.6's requested tour uses unitId 'unit-nonregression' with no unit row). collectWaitingFollowUps therefore stops after the empty units byStatus walk: the per-unit listing-sends and tours reads run only over kept units (app/src/services/followUps.ts:141-155) and the contacts batch only when ids exist (:160-161). The injected listingSendsRepo is never called, so a mis-wired listing-sends injection still answers 'ok'; only the units walk is proven to hit the suite prefix. The pin is weaker than its comment claims.

Correction: in the S4.7 Step 1f beforeAll edit, also create one available unit on the suite prefix so the core reads listing_sends there, e.g. `await createUnitsRepo(repoDeps).create({ unitId: 'unit-nonregression-avail', landlordId: 'c-ll', status: 'available' });` (a separate id, so S4.6's "its unit has no item" tour label comment stays true; quietShares stays { status: 'ok', properties: [], truncated: false } because the unit has no sends). Alternatively, reword the comment to "proves the units walk hit THIS prefix's table" and drop the listing-sends claim from PR57's record in the S4 report.

## D4-3 - MINOR

Plan location: S4.4 Step 1b (plan lines 10530-10539) re-points the D5 helper newUnknownRefIds to the identify group; S4.4/S4.5 retitle only the cases at ~1037, ~1058, ~1077, ~1123, ~1170.

What the tree holds: three D5 titles keep naming the old group while their assertions now read identify: app/test/todayApi.test.ts:1020 ("... is NOT in needs_you_now (nor anywhere on Today)"), :1029 ("PIN: ... NEEDS REVIEW unknown contact is in needs_you_now, once"), :1050 ("RED: ... INACTIVE team member is NOT in needs_you_now"). They pass, but a "PIN ... is in needs_you_now" that asserts identify misleads the reviewer and the S4 report's per-title inventory.

Correction: in S4.4 Step 1 add three title edits (ASCII): :1020 "... is NOT an identify row (nor anywhere on Today)", :1029 "PIN: an unread thread from a NEEDS REVIEW unknown contact is in identify, once", :1050 "RED: an unread unknown_1to1 thread from an INACTIVE team member is NOT an identify row".
