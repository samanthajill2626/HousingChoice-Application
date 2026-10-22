# R1 spec-conformance review - feat/flyer-leads

Reviewer: spec-conformance (round 1), read-only on source and tests.
Tree: W:\tmp\flyer-leads @3ee55f93 (the one main sync; diff base main
@0f6f29f9). Contract: spec rev 6 + section 7, plan sections 0-4 (AR1-AR16),
worklist OR-1..OR-26, work map S1-S6.

Gate state read from the logs (not re-run): typecheck-1 EXIT:0, npm-test-1
EXIT:0 (526 + 264 + 22 + 34 + 13 files, no `[dynamoAdmin]` line), smoke-1
EXIT:0, e2e-1 EXIT:0 (371 passed, 15.8m), lint head == lint base (the same 3
pre-existing react-hooks/set-state-in-effect errors: Timeline.tsx x1,
FlyerPage.tsx x2).

Empirical probe (run after battery-1.end existed, then deleted; tree clean
after): a throwaway app/test/zz-review-signup-concurrency.test.ts posted two
overlapping same-source sign-ups for one existing contact through the harness.
With the in-memory fake as is: 1 pin / 1 bump. With the repeat read modelled
as "evaluated, then one round trip of latency" (150 ms): /join 2 pins / 2
bumps, flyer 2 pins / 2 bumps. Basis of finding 1.

Verdict: no BLOCKER, no HIGH, no MEDIUM. 6 LOW, 4 INFO. Every work-map line,
decision bullet, plan 1.1 string, binding interface, section 5 test bullet,
section 7 amendment and code/test/doc OR ruling is accounted for below.

## Findings

1. LOW - PARTIAL (D6.1), CONFIRMED by probe, undeclared. The 24-hour cap is
   check-then-act: `hasEventSince` (app/src/routes/public.ts:618-623) and the
   pin write (public.ts:636-642) are separate, unconditional steps, so two
   same-source sign-ups whose requests overlap (both reads land before either
   pin) each pin and each bump. AR12 (ConsistentRead,
   app/src/repos/activityEventsRepo.ts:223) covers sign-ups "seconds apart",
   not overlapping ones. Consequence: spec D6.1's accepted residual ("someone
   who knows a phone number can plant at most one pin a day per shareable
   property, plus one 'no property' pin") and the GLOSSARY "signed up" entry's
   "at most one pin and one bump ... per 24 hours"
   (documentation/GLOSSARY.md:672-674) hold only for non-overlapping requests;
   a burst is bounded by the per-IP limiter (5/min/IP) instead. The flyer UI
   disables submit while pending, so this needs an API caller or two devices.
   No S4a/S4b report names it. Fix: record the residual (spec D6.1 residuals +
   the GLOSSARY sentence: "bounded per request, not under concurrent requests;
   the per-IP limit bounds a burst"), or, if exactness matters, make the pin a
   conditional put on a deterministic per-contact/source/window key (not a
   one-liner with a sliding window). Recommend: document and accept.

2. LOW - PARTIAL (D7 "a public request can never undo a staff decision";
   OR-13 residual (i)), open adjudication. The outcome route stamps the
   decline instant before writing it (app/src/routes/units.ts:1596 `at`,
   setDeclined at :1690). A flyer write whose signedUpAt is later than `at`
   that lands in between moves sentAt past `at`
   (app/src/services/shareLedger.ts:258-277), so the new decline is born
   superseded (app/src/lib/listingSendOutcome.ts effectiveDecline: declinedMs
   < sentMs -> false) and the route's re-projection answers `signed_up`. O1
   closes only the opposite order. OR-13 ruled "the orchestrator adjudicates it
   at review (fix or file an issue)"; at R1 there is neither a fix nor a
   docs/issues entry (git diff main...HEAD -- docs/issues touches only the two
   files below). Narrow window, visible to staff, a second click sticks. Fix:
   file docs/issues/<slug>.md before handback, or fix in the route (e.g.
   condition setDeclined on the shares_op token read in the same request and
   re-project on loss, or stamp max(now, read sentAt)).

3. LOW - comment drift, undeclared. The share-ledger module header still says
   every lost write is "logged at ERROR (the repair heals it)"
   (app/src/services/shareLedger.ts:6-7). Since D7 the flyer write is
   explicitly NOT repaired and logs its own line (:269); the new flyer
   paragraph (:17-20) does not qualify the earlier sentence. Fix: "broadcast
   entries: the repair heals it; the flyer entry is not repaired (its own
   ERROR line)".

4. LOW - doc precision (e2e/support/selectors.md:52, the sign-up pin row).
   It gives the pin's `<address>` as the app formatAddress
   `<line1>, <City>, <ST> <zip>`, but formatAddress joins line1 and line2 with
   a SPACE (app/src/lib/address.ts:103 formatStreet, :113-125), so a property
   with a line2 pins `<line1> <line2>, <City>, <ST> <zip>` - while the flyer
   heading shows `<line1>, <line2>` (dashboard/src/routes/public/FlyerPage.tsx:113-116).
   Behavior is as specified (D6.2 formatAddress, D3 ", "); only the selector
   note is incomplete. Fix: add the line2 form to the row.

5. LOW - doc precision in the two touched issue files.
   - docs/issues/deleted-contact-web-signup-silent.md update paragraph says
     "Point 3 and the last line of the 'Net' paragraph no longer hold". The
     sentence that no longer holds is the Net paragraph's middle one ("The only
     trace is the audit entry (public.ts:322) and a warn log."); its last line
     ("the gate itself is correct, the public flow's handling of it is not")
     still stands. Fix: name the sentence.
   - Stale line refs, PRE-EXISTING on main (main's public.ts:245 is a logger
     line, :288 a comment): the frontmatter `refs:` app/src/routes/public.ts:245-318
     of the deleted-contact issue (the deleted path is now public.ts:477-509)
     and `app/src/routes/public.ts:288` in public-welcome-text-global-cap.md
     (frontmatter and body; the welcome send is now public.ts:575-590). The
     first file was re-stamped `updated: 2026-10-21` without refreshing them.
     Fix: refresh the refs (optional; not introduced by this branch).

6. LOW - stale comment and test title, declared by S1/S2 but left: the
   textOrNull doc "the edit form PATCHes untrimmed values"
   (dashboard/src/routes/public/FlyerPage.tsx:164-166) and the test title
   "... (edit form saves untrimmed)"
   (dashboard/src/routes/public/FlyerPage.test.tsx:257) are false since AR16
   (app/src/app.ts:146 trimJsonBody). Fix: reword both ("a legacy or imported
   value may be blank or padded").

7. INFO - Cameron's open calls (worklist "non-blocking; built per spec"):
   OR-26, the property legend "Staff only - never leaves the dashboard."
   (dashboard/src/routes/listing/FlyerTag.tsx:36) now sits on Rent min / max
   while `[Rent]` is in DEFAULT_SEND_TEMPLATE
   (dashboard/src/routes/broadcasts/resolveTemplate.ts:30-31; documented at
   GLOSSARY.md:202-205); OR-26b, the row words key on the outcome only
   (dashboard/src/routes/contact/Card.tsx:351), so a flyer-latest pair that a
   decline, tour or reply outranks reads "Sent <sign-up date>". Both need his
   answer before the merge, per the worklist.

8. INFO - spec 5 "all five callers": four callers carry a real `signed_up`
   wire pin (app/test/listingSendsApi.test.ts:591 for routes/contacts.ts:1324
   and routes/units.ts:259/:279; app/test/listingSendOutcomeApi.test.ts:711
   for the outcome route's re-projection; app/test/followUps.test.ts:335 for
   services/followUps.ts:168). routes/broadcasts.ts:612-619 reads only
   `=== 'not_interested'`, so app/test/broadcastApi.test.ts:3510 is a PIN that
   cannot tell signed_up from no_reply (recorded per OR-13). All five pass the
   full stored row (base-table listByUnit, and the byContact GSI projects ALL:
   app/src/lib/dynamoAdmin.ts:56-57).

9. INFO - the e2e existing-tenant case posts the flyer form's body with the
   bare `request` fixture (e2e/tests/dashboard-next/flyer-leads.spec.ts:461-465)
   rather than the visitor UI (declared, OR-24); the flyer form UI submit is
   exercised for a new contact (:596-605) and in public-pages.spec.ts.

10. INFO - OR-14's deliberate relay-thread skip is reported through the
    failure line (`housing-fair signup step failed`, step `touch`, reason
    `group_thread`, WARN; app/src/routes/public.ts:369-372), as OR-14 dictated;
    a log query on step failures will count these skips too.

Scope creep: none at file level - every changed path is named by the plan or
the worklist. Additions beyond the spec text are all worklist/AR-sanctioned
and declared: the OR-14 1:1 guard, AR13's phone label, the extra selectors.md
rows (S6), the GLOSSARY Today / blank-preview lines (OR-18, OR-23), and the
`.title` overflow-wrap that also reaches /join (OR-10).

## Conformance table

Status: C = CONFORMS, P = PARTIAL (severity), M = MISSING. "Fails w/o" = the
named test would fail on the pre-branch code (Y), or is a PIN by design.

### A. Work map

| # | Item | St | Evidence |
|---|---|---|---|
| A1 | S1: ten keys off the projection, tags Staff only, subzone match | C | app/src/lib/unitFields.ts:403-430, :480-508; app/src/lib/requirements.ts:88-98, :540-548; app/src/lib/similarUnits.ts:58-74 |
| A2 | S2: mirror, note gate, form props, PublicFlyer, FlyerPage, sign-up copy | C | dashboard requirements.ts:100-112, :264-282; TaggedField.tsx:51; ListingEditForm.tsx:545, :558; UnitCreateForm.tsx:680, :693; publicApi.ts:31-55; FlyerPage.tsx:97-143, :301-443 |
| A3 | S3: keys leaf, applyFlyerShareEntry + refusal, O1, signed_up x5 callers, AR13 | C | shareLedgerKeys.ts:14-47; shareLedger.ts:125-131, :195-277; listingSendsRepo.ts:388, :401, :423, :435; listingSendOutcome.ts:22, :88; units.ts:207-213, :287 |
| A4 | S4: signed_up type + hasEventSince, deps + harness, handler, audit | C | activityEventsRepo.ts:77, :145-150, :210-240; public.ts:290-311, :341-389, :463-728; harness :3597, :5568, :5814-5817 (F1 is a D6.1 precision gap) |
| A5 | S5: green pin, row words / chip / gate, groupSendRows, switches | C | api/types.ts:2935, :3155; Timeline.tsx:465; Card.tsx:274-276, :351, :357, :371, :392, :402; listingFormat.ts:352 |
| A6 | S6: e2e repairs + flyer-leads spec (mutation RED), selectors, GLOSSARY, issue note, main sync, gates | C | 4 repaired specs + flyer-leads.spec.ts:264/:398/:525/:576; S6-mutation-check.md (RED at :469, :553); merge 3ee55f93; gate logs above |

### B. Spec decisions

| # | Bullet | St | Evidence |
|---|---|---|---|
| B1 | D1 ten keys removed, absent not null | C | unitFields.ts:403-430 (type), :490-507 (projection) |
| B2 | D1 PublicFlyer drops the same keys | C | dashboard/src/routes/public/publicApi.ts:31-55 (16 keys = UnitFlyer + contact_number) |
| B3 | D1 application_fee and the other public keys stay | C | unitFields.ts:487-506 |
| B4 | D1 "only ADDS keys" comment rewritten with the safety argument | C | unitFields.ts:385-401 |
| B5 | D1 old bundle crash accepted, no compat code | C | FlyerPage.tsx reads only projected keys (flyer.* reads: accepted_authorities, address, application_fee, area, baths, beds, contact_number, listing_link, media, same_day_rta, utilities, video_url, voucher_sizes, washer_dryer) |
| B6 | D2 re-tag rent min/max, accessibility, lease terms, all Pets, deposit one-month/fixed/flexible (app + mirror) | C | app requirements.ts:88-98, :540-548; dashboard requirements.ts:100-112, :264-282 |
| B7 | D2 application fee pair stays On flyer | C | app requirements.ts:103; mirror; parity table rows |
| B8 | D2 parity walk / pinned shapes change only for those rows | C | propertyFormFlyerParity.test.ts:175-214 (35 rows); requirements.test.ts:85-91 |
| B9 | D2 landlord form: Staff only for Pets/Deposit, tag only on fee pair, legend unchanged | C | ContactEditForm unchanged (derives via RequirementsFields); ContactEditForm.test.tsx:1459 |
| B10 | D2 note only when on_flyer; stays only under Tenant-paid utilities; hand props removed | C | TaggedField.tsx:51-63; ListingEditForm.tsx:545, :558; UnitCreateForm.tsx:680, :693 |
| B11 | D3.1 photos unchanged | C | FlyerPage.tsx:306-312 |
| B12 | D3.2 address heading link (_blank, mapsHref), h1 street line, smaller city line, sr-only suffix, Address row + addressLines gone | C | FlyerPage.tsx:107-143, :318-327; module.css:49-61; grep: no addressLines |
| B13 | D3.2 fallbacks: city line; area plain; "Home for rent"; "A home for you" gone | C | FlyerPage.tsx:140-142 |
| B14 | D3.3 area line under an address heading | C | FlyerPage.tsx:328 |
| B15 | D3.4 "Same-day tours available" on every flyer, static | C | FlyerPage.tsx:334; module.css:110-118 |
| B16 | D3.5 facts beds/baths/voucher, no rent fact | C | FlyerPage.tsx:336-352 |
| B17 | D3.6 authority line bold, larger, full contrast, wording unchanged | C | FlyerPage.tsx:357-359; module.css:102-106 (--fs-lg, --fw-bold, --c-text) |
| B18 | D3.7 detail rows order/membership; removed rows; petsLabel/depositLabel/rentRange/addressLines deleted; flyerMoney kept | C | FlyerPage.tsx:361-406, :175-183 |
| B19 | D3.8 sign-up box (form variant only) + thank-you | C | FlyerPage.tsx:423-443 |
| B20 | D3 unchanged: ?cta=text, unavailable, prefill, CTA position | C | FlyerPage.tsx:409-422, :262-292, :146-153 |
| B21 | D3 320px wrap, whole heading block is the tap target | C | module.css:20-25, :43-47; flyer-leads.spec.ts:376-393 |
| B22 | D4 findByPhone the ONE lookup | C | public.ts:471 (findAllByPhone never called: publicSignupLeads.test.ts:124) |
| B23 | D4 live -> existing; deleted -> deleted path; none -> create | C | public.ts:477, :512-558 |
| B24 | D4 existing contact never changed (no consent stamp) | C | public.ts:512-515, :575 (no contacts.* write on the existing branch) |
| B25 | D4 deleted path: no conversation/send/pin/mark/ledger; audit on contacts#<id>, deletedContact true; ok | C | public.ts:477-510 |
| B26 | D5 welcome only when created; flag after success | C | public.ts:574-602 |
| B27 | D6.1 one pin + bump per contact per source per 24h; hasEventSince; fails open; new skips read | P (LOW, F1) | public.ts:612-627; activityEventsRepo.ts:210-240 |
| B28 | D6.2 three labels, refs, typed trimmed name, formatAddress \|\| unitId | C | public.ts:143-154, :636-642, :196-197 |
| B29 | D6.3 touch -> increment -> ONE event from touched image + returned count; failed increment emits; failed touch nothing; conversationTypeFor; events default appEvents | C | public.ts:368-389, :566, :342 |
| B30 | D6.4 best-effort, marker-only logs, { ok: true } | C | public.ts:624-626, :644-646, :674-677; events bus isolates listener throws (lib/events.ts:351-363) |
| B31 | D6 new contacts: pin + mark AFTER welcome; refused welcome still pins | C | public.ts:612-648 |
| B32 | D6 audit fields (existingContact, deletedContact, recorded, sentRecorded, sentSkipped, consentVersion) | C | public.ts:693-706, :478-492 |
| B33 | D7 flyer share ENTRY via the ledger path (key flyer, `<ISO>#flyer`, counted by acceptance, countedAt from key) | C | shareLedger.ts:258-277; shareLedgerKeys.ts:17-27; ledgerEntryFor :54-70; public.ts:663-678 |
| B34 | D7 summarize maps flyer like individual; via untouched | C | shareLedger.ts:125-131; putShareMemory unchanged |
| B35 | D7 never clears a current decline; effectiveDecline(row, undefined) inside the RMW; flyer-only | C | shareLedger.ts:195-216, :267 |
| B36 | D7 "a public request can never undo a staff decision" | P (LOW, F2) | units.ts:1596 vs :1690 (OR-13 residual i) |
| B37 | D7 O1: decline writers stamp shares_op; harness fake; NO-RESET comment | C | listingSendsRepo.ts:14-32, :388, :401, :423, :435; harness :3667, :3678 |
| B38 | D7 residuals: repeat moves sentAt; lost write not repaired (own line); sentSkipped reasons; INFO decline line | C | shareLedger.ts:269, :274; public.ts:663-678 |
| B39 | D7 no "Property sent" milestone; tenant/unknown only; others pin + mark | C | public.ts:663-669 |
| B40 | D8 order decline > tour > replied > signed_up/no_reply; ONE helper; no stored field | C | listingSendOutcome.ts:73-89 (helper in lib leaf, AR1) |
| B41 | D8 never waiting | C | listingSendOutcome.ts:129-130 |
| B42 | D8 renderers: words, chip, action gate (+ Request a tour partner-only), Sent to grouping, blast checked | C | Card.tsx:274-276, :351, :357, :371, :392, :402; listingFormat.ts:352; blastAudienceRules.ts unchanged |
| B43 | D9 subzone normalized (strip all whitespace, uppercase); empty never; no fuzzy; area unchanged | C | similarUnits.ts:58-74 |
| B44 | D10 no new untrimmed stored input | C | parser trims names public.ts:196-197; app.ts:146 trimJsonBody; display trims FlyerPage.tsx:59-63, :107-109 (display-only untrimmed reads noted by S2: :97-101, :149) |

### C. Plan 1.1 exact copy (verbatim in code and tests)

| # | String | St | Code | Tests |
|---|---|---|---|---|
| C1 | " - open in Google Maps" (old row's text) | C | FlyerPage.tsx:323 (old: same span) | FlyerPage.test.tsx:509; flyer-leads.spec.ts:298 |
| C2 | "Home for rent" | C | FlyerPage.tsx:142 | FlyerPage.test.tsx:581, :637 |
| C3 | "Same-day tours available" | C | FlyerPage.tsx:334 | FlyerPage.test.tsx:637; flyer-leads.spec.ts:314 |
| C4 | "Sign up for home alerts" | C | FlyerPage.tsx:436 | FlyerPage.test.tsx:677; flyer-leads.spec.ts:367 |
| C5 | sign-up text (two sentences) | C | FlyerPage.tsx:438-439 | FlyerPage.test.tsx:677; flyer-leads.spec.ts:368-373 |
| C6 | button "Sign up" | C | FlyerPage.tsx:441 (IntakeForm submitLabel) | FlyerPage.test.tsx:159; flyer-leads.spec.ts:374, :598 |
| C7 | "Thanks - you're all set!" unchanged | C | FlyerPage.tsx:426 | FlyerPage.test.tsx:184 |
| C8 | thank-you text | C | FlyerPage.tsx:429 | FlyerPage.test.tsx:186-187; flyer-leads.spec.ts:602-604 |
| C9 | detail labels, order | C | FlyerPage.tsx:364-398 | FlyerPage.test.tsx:602, :281; flyer-leads.spec.ts:322-329 |
| C10 | three pin labels | C | public.ts:151-153 | publicSignupLeads.test.ts:83-85; flyer-leads.spec.ts:479, :547 |
| C11 | "Signed up from the flyer <date>", chip "Signed up" | C | Card.tsx:351, :371, :275 | SendRosterRow.test.tsx:166, :176 |
| C12 | log lines (lost ERROR, decline INFO, step failed) | C | shareLedger.ts:269, :274; public.ts:118 | shareLedgerFlyer.test.ts:28-31, :76, :179; publicSignupLeads.test.ts:77-78 |

### D. Binding interfaces (plan section 2)

| # | Interface | St | Evidence |
|---|---|---|---|
| D1 | 2.1 shareLedgerKeys: INDIVIDUAL_SHARE_KEY, FLYER_SHARE_KEY, flyerAttemptKey, latestCountedShareKey (strict >, never sorted); import-free; summarize uses it | C | shareLedgerKeys.ts:14-47; shareLedger.ts:24, :125-131 |
| D2 | 2.2 FlyerShareResult + applyFlyerShareEntry(deps, {unitId, contactId, signedUpAt}); shared private loop (veto/lostLine/lostIds per AR7); applyShareLedgerEntry signature, results, ERROR fields unchanged | C | shareLedger.ts:195-277 (ERROR at :209 spreads lostIds between contactId and attempt; :230-231 keep {unitId, contactId, broadcastId, attempt, state}) |
| D3 | 2.3 setDeclined/clearDeclined add `#op = :op` (randomUUID); conditions/returns unchanged | C | listingSendsRepo.ts:388, :401, :423, :435 |
| D4 | 2.4 union + row type with shares; order; isWaiting unchanged; wire field `outcome` | C | listingSendOutcome.ts:22, :73-89, :122-130 |
| D5 | 2.5 'signed_up' type; hasEventSince(contactId, type, sinceIso, refId): Promise<boolean>; key range, filter, ConsistentRead, queryAll, throws; fake + conformance | C | activityEventsRepo.ts:77, :145-150, :210-240; harness :3597; conformance AE_CASES |
| D6 | 2.6 deps (Pick types) + defaults; handler order 1-10; audit payload | C | public.ts:290-311, :341-345 (`() => Date.now()` == Date.now), :450-728 |
| D7 | 2.7 dashboard unions, PublicFlyer, mirror, TaggedField gate, Card gate/words, groupSendRows, green MilestonePin, host switches | C | types.ts:2935, :3155; publicApi.ts:31-55; TaggedField.tsx:51; Card.tsx:351-402; listingFormat.ts:352; Timeline.tsx:465; hosts have no outcome switch (ContactDetail/ListingDetail render SendRosterRow; FollowUpView AR9 #1) |

### E. Spec section 5 tests

| # | Bullet | St | Test (file:line) | Fails w/o |
|---|---|---|---|---|
| E1 | flyer JSON of a full property has no D1 key | C | app/test/publicIntake.test.ts:364 (+ :419 loop); unitFields.test.ts:682 | Y |
| E2 | parity walk green with new tags | C | propertyFormFlyerParity.test.ts:258 | Y (tags vs projection) |
| E3 | a wrong tag still fails the walk | C | propertyFormFlyerParity.test.ts:262, :273 | Y (:273) |
| E4 | heading links to Maps + sr-only suffix | C | FlyerPage.test.tsx:509 | Y |
| E5 | every fallback (zip-only; no address with/without area) | C | FlyerPage.test.tsx:548, :571, :581 | Y |
| E6 | area line under an address heading | C | FlyerPage.test.tsx:531 | Y |
| E7 | "A home for you" never appears | C | FlyerPage.test.tsx:592 | Y |
| E8 | "Same-day tours available" on a bare property | C | FlyerPage.test.tsx:637 | Y |
| E9 | no rent/deposit/pets/fee/accessibility/lease/address row from a stale payload | C | FlyerPage.test.tsx:281 (exact dt list, OR-9) | Y |
| E10 | new sign-up copy, thank-you text, bolder authority line | C | FlyerPage.test.tsx:677, :159; FlyerPage.styles.test.ts:31 | Y |
| E11 | Staff only on both property forms | C | ListingEditForm.test.tsx:667; UnitCreateForm.test.tsx:1070 | Y |
| E12 | landlord "On property flyers" only on the fee pair | C | ContactEditForm.test.tsx:1459 | Y |
| E13 | public note never on a Staff only field | C | TaggedField.test.tsx:35; RequirementsFields.test.tsx:99; ListingEditForm.test.tsx:648; UnitCreateForm.test.tsx:1057 | Y |
| E14 | existing tenant on flyer: no text, one pin (label, unit ref), touched/unread/emitted once with count, counted flyer entry | C | publicSignupLeads.test.ts:199, :561, :572 | Y |
| E15 | already sent, no reply / replied -> signed_up | C | publicSignupLeads.test.ts:595 | Y |
| E16 | current decline: no entry, not_interested, pin + mark kept | C | publicSignupLeads.test.ts:610 | Y |
| E17 | tour: stays interested | C | publicSignupLeads.test.ts:649 (also asserts the entry is written) | Y |
| E18 | decline after a sign-up, then a second: holds; audit declined | C | publicSignupLeads.test.ts:630, :928; shareLedgerFlyer.test.ts:135 | Y |
| E19 | O1: decline between read and write holds; token lost, re-read | C | shareLedgerFlyer.test.ts:145; listingSendsRepo.integration.test.ts:242 (real repo); conformance :1110 | Y (without O1 the put wins) |
| E20 | broadcast to a declined pair still supersedes (flyer-only) | C | shareLedgerFlyer.test.ts:113 | PIN (fails a non-flyer-only veto) |
| E21 | /join: join label, no ledger write | C | publicSignupLeads.test.ts:270, :725 | Y (:270) |
| E22 | existing landlord, no thread: landlord_1to1, pin, unread, no welcome/ledger | C | publicSignupLeads.test.ts:297, :712, :154 | Y |
| E23 | soft-deleted holder: no conversation/send/pin; audit on it, deletedContact | C | publicSignupLeads.test.ts:176, :814 | Y |
| E24 | no write of any field to an existing contact, consent included | C | publicSignupLeads.test.ts:124 | Y (old code set the welcome flag) |
| E25 | new contact: welcome, then pin, mark, entry; refused welcome still pin + unread | C | publicSignupLeads.test.ts:350, :381, :750 | Y |
| E26 | same property within 24h: none; after 24h: again | C | publicSignupLeads.test.ts:411 | Y |
| E27 | different property within 24h: own pin, unread, entry | C | publicSignupLeads.test.ts:436, :685 | Y |
| E28 | /join twice: one pin; /join then unavailable flyer: one pin | C | publicSignupLeads.test.ts:454, :467 | Y |
| E29 | made-up unitIds: "from a flyer" label, no ledger, one shared source | C | publicSignupLeads.test.ts:281, :481, :725 | Y |
| E30 | step failures still ok, flags honest, failed increment emits once | C | publicSignupLeads.test.ts:506, :519, :533, :547, :763, :915, :944; publicIntake.test.ts:125 (PII) | Y |
| E31 | old pins expecting an existing contact's welcome changed | C | publicIntake.test.ts:1236, :208 | Y |
| E32 | flyer entry yields no broadcastId | C | shareLedger.test.ts:102; shareLedgerFlyer.test.ts:47 | Y |
| E33 | outcome order vs replied, declined, tour | C | listingSendOutcome.test.ts:261, :267, :273 | Y |
| E34 | isWaiting false for signed_up | C | followUps.test.ts:335 (listingSendOutcome.test.ts:292 is the PIN) | Y (:335) |
| E35 | a later broadcast share returns to normal outcomes | C | listingSendOutcome.test.ts:280; listingSendsApi.test.ts:616 | discriminating (fails a presence rule) |
| E36 | all five callers through the one helper | C (INFO F8) | listingSendsApi.test.ts:591; listingSendOutcomeApi.test.ts:711; followUps.test.ts:335; broadcastApi.test.ts:3510 (PIN) | Y x4, PIN x1 |
| E37 | row and chip read "Signed up from the flyer <date>" / "Signed up" | C | SendRosterRow.test.tsx:166, :176; ContactDetail.test.tsx:1146 | Y |
| E38 | row offers Interested / Not interested | C | SendRosterRow.test.tsx:181, :196; ListingDetail.test.tsx:3118 | Y |
| E39 | Sent to card: Interested when eligible, Not eligible when not | C | listingFormat.test.ts:430; ListingDetail.test.tsx:3118 | Y |
| E40 | subzone: case, outer and inner spaces match; SE1 vs SE11 differ; blank never | C | similarUnits.test.ts:254, :270, :277, :294 (PIN) | Y (:254, :277) |
| E41 | e2e: new layout, none of the removed rows | C | flyer-leads.spec.ts:264 | Y |
| E42 | e2e: existing tenant from flyer: no text, unread row, pin, Signed up row | C (INFO F9) | flyer-leads.spec.ts:398 (live inbox, OR-24) | Y (mutation RED :469) |
| E43 | e2e: existing contact on /join: pin, unread, no text | C | flyer-leads.spec.ts:525 | Y (mutation RED :553) |
| E44 | specs follow selectors.md | C | getByRole/getByLabel throughout flyer-leads.spec.ts |  |

### F. Spec section 7 amendments

| # | Amendment | St | Evidence |
|---|---|---|---|
| F1 | AR1 helper in lib/shareLedgerKeys.ts, used by summarize and the derivation | C | shareLedgerKeys.ts:37; shareLedger.ts:125-131; listingSendOutcome.ts:14, :88 |
| F2 | AR2/AR11 sentSkipped 'refused' and 'deleted' | C | public.ts:127-133, :490, :672-673; publicSignupLeads.test.ts:915 (refused), :814 (deleted) |
| F3 | AR12 ConsistentRead on hasEventSince + a test | C | activityEventsRepo.ts:223; activityEventsRepoConsistentRead.test.ts:38 |
| F4 | AR13 nameless resolved recipient labelled by formatted phone; missing keeps today's label | C | units.ts:207-213, :287; listingSendsApi.test.ts:633, :664; ListingDetail.test.tsx:3143; wire comments listingSendsRepo.ts:137-144, types.ts:3159-3165 |
| F5 | consentVersion = server CONSENT_VERSION | C | public.ts:491, :705; smsCompliance.ts:91 |

### G. Worklist rulings that require code / tests / docs

| # | Ruling | St | Evidence |
|---|---|---|---|
| G1 | OR-5 address.ts comment | C | app/src/lib/address.ts:110-111 |
| G2 | OR-6 dashboard requirements.test.ts copy | C | dashboard/src/routes/listing/requirements.test.ts:369-375, :383, :608-632 |
| G3 | OR-7 types.ts "Staff only (flyer-leads D2)." | C | dashboard/src/api/types.ts:2571, :2607-2613 |
| G4 | OR-8 mapsHref doc | C | FlyerPage.tsx:86-96 |
| G5 | OR-9 exact dt list; smaller city line pinned | C | FlyerPage.test.tsx:281; FlyerPage.styles.test.ts:47 |
| G6 | OR-10 /join shares .title (no scoping) | C | module.css:20-25; HousingFairIntake tests green (S2) |
| G7 | OR-11 ledgerEntryCounts doc; harness putShareMemory comment | C | shareLedger.ts:97-102; harness :3629 |
| G8 | OR-12 Follow up PIN (unknown contact, replied) | C | followUps.test.ts:356 |
| G9 | OR-13 recorded in S3; residual (i) fix-or-file at review | P (LOW, F2) | S3-report "Risks"; no fix, no issue file |
| G10 | OR-14 1:1-only mark + test | C | public.ts:368-372; publicSignupLeads.test.ts:316 |
| G11 | OR-15 refused-welcome case is a flyer case; entry asserted for both welcome outcomes | C | publicSignupLeads.test.ts:381, :750 |
| G12 | OR-16 one clock reading, after the welcome | C | publicSignupLeads.test.ts:234, :371-378 |
| G13 | OR-17 four default expressions vs plan 2.6; e2e boundary pin | C | public.ts:341-345; flyer-leads.spec.ts:433-476 |
| G14 | OR-18 Today / blank preview documented | C | GLOSSARY.md:680-686; S4b report (today.ts:784-836, inbox.ts:678-681) |
| G15 | OR-19 cap keyed on the pin recorded | C | S4b report "Risks" |
| G16 | OR-20 two `**signed up**` hits | C | GLOSSARY.md:628, :663 |
| G17 | OR-21 [Rent] sentence | C | GLOSSARY.md:202-205 |
| G18 | OR-22 "Sign up" in the global-cap issue; GLOSSARY residual wording | C | public-welcome-text-global-cap.md:13; GLOSSARY has no uncounted-pair text |
| G19 | OR-23 later inbound -> Replied, Follow up; Today placement | C | GLOSSARY.md:676-683 |
| G20 | OR-24 live inbox with window marker | C | flyer-leads.spec.ts:438-476 |
| G21 | OR-25 main sync + gates by the orchestrator | C | merge 3ee55f93; gate logs above |
| G22 | OR-26 / OR-26b built per spec, for Cameron | C (INFO F7) | FlyerTag.tsx:36; Card.tsx:351 |

### H. Docs against the code as built

| # | Doc | St | Notes |
|---|---|---|---|
| H1 | documentation/GLOSSARY.md (:197-211, :227-232, :626-686) | C | staff-only fields, address heading, signed_up pin/outcome, flyer share entry, Today and blank preview all match the code; the "at most one ... per 24 hours" sentence inherits F1 |
| H2 | e2e/support/selectors.md (:21, :44-45, :52, :136, :139, :156) | P (LOW, F4) | accurate (debounce 300 ms useInbox.ts:140; read route inbox.ts:2821; DEFAULT_SEND_TEMPLATE) except the pin-address form |
| H3 | docs/issues/deleted-contact-web-signup-silent.md | P (LOW, F5) | the update matches public.ts:477-509; "last line of Net" imprecise; refs stale (pre-existing) |
| H4 | docs/issues/public-welcome-text-global-cap.md | C | OR-22 edit correct; "every first capture sends the welcome" still true after D5; stale :288 ref pre-existing (F5) |

Totals: 144 rows (A 6, B 44, C 12, D 7, E 44, F 5, G 22, H 4) - 139
CONFORMS, 5 PARTIAL (all LOW: B27, B36, G9, H2, H3), 0 MISSING. Findings: 6
LOW (F1-F6), 4 INFO (F7-F10); no BLOCKER, HIGH or MEDIUM.
