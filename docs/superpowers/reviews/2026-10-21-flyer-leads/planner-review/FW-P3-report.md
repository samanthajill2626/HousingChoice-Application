# FW-P3 report - feat/flyer-leads (the opted-out note by cause)

Scope: items 1-3 of the FW-P3 section of `adjudications.md` (same
directory), plus item 4's `npm run issues`. No main sync, no full suite run,
no e2e run, no review round. Base `a49e250f`.

## Commits

- `7aed3383` fix(app): item 1 (the note by cause, its tests, the exported
  thread rule)
- `fbdc5f4d` docs(glossary,selectors,spec,issues): item 2
- `7cc3f24f` docs(issues): item 3 (citations, digits only)
- this report, last

## RED / GREEN evidence

Bare runs, output to `.superpowers/sdd/gates/fwp3-*.log`, then `EXIT:$?`.

| Run | Command | Result |
|---|---|---|
| item 1 RED | `cd app && npx vitest run test/publicSignupLeads.test.ts` | 1 file failed; 15 failed / 59 passed (74), EXIT:1. Reasons: the pin carried FW-P2's suffix where the new START or Do-Not-Contact words were expected (the 6 updated FW-P2 cases and 7 new ones); the number read was never called (`expected [] to deeply equal [ [ '+15550102000' ] ]`, the older-thread and read-count cases); no `opt_out_check` step line (both throw cases). The two PINs (FW-P2 "not opted out", FW-P3 "neither") passed before and after. |
| item 1 GREEN | `test/publicSignupLeads.test.ts test/publicIntake.test.ts test/numberSuppression.test.ts` | 3 files, 153 passed (74 + 60 + 19), EXIT:0 |
| readNumberSuppression's other callers | `test/groupReceipts.test.ts test/groupSend.test.ts test/groupSendRoute.test.ts test/conversationHubApi.test.ts test/relayAnnouncements.test.ts test/groupTextWebhook.test.ts` | 6 files, 210 passed, EXIT:0 |
| typecheck | `npm run typecheck` on the item 1 tree | EXIT:0 (items 2 and 3 are docs only) |
| eslint | `npx eslint` on `public.ts`, `numberSuppression.ts`, `relayAnnouncements.ts`, `publicSignupLeads.test.ts` | EXIT:0, no findings |
| issues | `npm run issues` | EXIT:0 (437 open, 213 closed, 650 total); `INDEX.md` is gitignored, not committed |
| ASCII, `\u` | added lines of every changed file | 0 non-ASCII bytes, 0 `\u` hits |
| item 3 digits-only | each changed line of the item 3 diff paired with its old line, digits removed | 0 differences (72 lines, 93 tokens) |

## Where the live code differs from the list

- **The 1:1 21610 arm writes no thread flag.** The P3-F1 ruling's reason
  says "A STOP or a 21610 always writes the NUMBER's thread flag
  (`applyNumberSuppression`)". True for an inbound STOP (the keyword path)
  and for a group leg's 21610 (`groupReceipts.ts`). Not true for the 1:1
  receipt arm (`app/src/routes/webhooks/twilio.ts:3953-4001`). It does not
  call `applyNumberSuppression`. On a PRIMARY number it sets only the
  contact flag (`:3984`); on a secondary number it sets nothing. An imported
  legacy STOP also sets only the contact flag
  (`app/src/lib/import/apply.ts:1232-1236`).
  - So a contact that Twilio blocks after a 1:1 21610, or that was imported
    opted out, gets the Do-Not-Contact note. If staff then choose Allow SMS,
    the next send is refused again by Twilio (21610) and the arm re-flags
    the contact. No text reaches the person; only the note's remedy is
    wrong.
  - The code comment on the notes says this (`public.ts:176-178`). The spec,
    GLOSSARY and consent issue keep the list's two-case words.
  - A decision for you: accept it as a residual, or have the 1:1 arm write
    the number's thread flag (through `applyNumberSuppression`). That would
    turn these contacts into the START note.
- **"Allow SMS".** The staff menu item reads "Allow SMS (clear opt-out)"
  (`dashboard/src/routes/contact/ContactActionsMenu.tsx:207`). The note's
  "Allow SMS" is its leading words, as intended. The note's "Do-Not-Contact"
  follows the same menu's "Mark Do-Not-Contact". The contact header badge
  (`ContactDetail.tsx:1031`) and the milestone (`contacts.ts:2294`) say "Do
  Not Contact", unhyphenated.
- **The exported thread rule.** It is `isNumberThreadOptedOut(c)`
  (`app/src/services/numberSuppression.ts:141-143`). The clause is unchanged
  and `readNumberSuppression` now calls it (`:123`); its 19 tests are green.
  - It is placed after `readNumberSuppression`, which stays at `:108`, so
    `relay-member-suppression-diverges-from-number-seam.md`'s `:108` ref
    still holds.
  - The clause moved from `:129` to `:142`. So the relay twin's comment
    "services/numberSuppression.ts:129 carries the same clause"
    (`app/src/services/relayAnnouncements.ts:87`) was re-pointed to `:142`.
    That is a digits-only change outside the list, in the item 1 commit.
- **The moved rationale was corrected.** `readNumberSuppression`'s comment
  said neither group type "carries participant_phone". A relay group does:
  its synthetic POOL number (`conversationsRepo.ts` createRelayGroup and
  assignPoolNumberAndOpen). That is exactly what a pool-number sign-up
  (OR-14) reads. The helper's doc says so.
  - The same old claim stays in `relayAnnouncements.ts:81-82`. In that
    comment only the `:129` citation's digits were touched.
- **The read is not short-circuited.** When the thread step's own flag
  already decides the note, the number read still runs, on every sign-up
  that writes a pin (never on a repeat). So the public answer's timing never
  turns on the opt-out. P3-adversarial V3 had recorded "the note adds no
  read, so there is no timing signal". A test pins this (one read per
  pinned sign-up, none on a repeat).
- **P3-F4 is narrowed, not closed.** The number's threads come from the
  same eventually consistent `byParticipantPhone` index the thread step
  used. The code comment claims no more than that.
- **The harness fake.** `findByParticipantPhone`
  (`app/test/helpers/twilioWebhookHarness.ts:776-778`) mirrors the real query
  (`conversationsRepo.ts:1336-1346`, GSI projection ALL) for what the code
  relies on: every thread with that `participant_phone`, any status and
  type, with its `sms_opt_out`. The one difference is that the fake is
  immediately consistent.
  - The fake's `createOrGetByParticipantPhone` makes a NEW thread when none
    is open. The real one adopts the claimed, possibly closed, thread. So the
    older-thread test uses a CLOSED older thread beside an OPEN current one,
    a shape both produce.
  - No new-contact older-thread case was added: in the fake the new thread
    would be clean and the welcome would go out, a shape only the fake has.
    FW-P2's new-contact case (now the START note) covers new contacts.
- **Shape changes in public.ts.** `signupPinLabel` takes `optOut:
  SignupOptOut` ('number' | 'contact' | 'none') instead of `optedOut`. The
  words are `SIGNUP_OPT_OUT_NOTE` (`public.ts:181-186`), which replaces
  `SIGNUP_OPTED_OUT_NOTE`. The read and the choice are at `:726-733`.
  `isOptedOut` is no longer imported.
- **Tests.**
  - 11 new cases are appended: the thread step's flag in all three forms;
    an older thread; contact-only (a staff DNC, and the contact's other
    number - a primary STOP with the sign-up from a pointed second number);
    both; neither; read count and no read on a repeat; and the throw with
    two fallbacks (the thread step's flag gives the START note; an older
    flag goes unseen, so no note).
  - FW-P2's six cases now pin the new words: contact-only gets the DNC note
    in all three forms; thread and new contact get the START note.
  - The shared constants sit above FW-P2's describe block, and the line 9
    import changed in place. No line at or above 761 moved, so
    `public-signup-abuse-hardening.md`'s `publicSignupLeads.test.ts:750-761`
    still holds.
- **publicIntake.test.ts** (`:125-162`, "every failed step" never logs
  PII) still lists the six earlier steps. `opt_out_check`'s no-PII check is
  in the new publicSignupLeads throw case instead; publicIntake was not
  edited.

## Item 3: citations re-pointed (file: old -> new)

Every target was read at HEAD: the cited line, and both ends of a range.
Where a line was already off when filed, the target is the code the text
describes. For the flyer-leads files these maps agree with the FW-P2
report's map composed with the FW-P3 shift.

- `docs/issues/auto-routing-changes-not-named.md` (4 tokens): `:1845 -> :2629`, `:1363-1369 -> :1875-1881`, `:2001-2007 -> :2545-2551`
- `docs/issues/consent-capture-ignores-signup-web-form.md` (12 tokens): `:230 -> :249`, `:763-776 -> :797-810`, `:564 -> :583`, `:575-606 -> :594-625`, `:618-619 -> :637-638`, `:642 -> :661` (refs and body; the item 2 paragraph's new `:182-186`, `:726-733` and `numberSuppression.ts:141-143` were written against the final code)
- `docs/issues/consolidate-contact-display-name-helpers.md` (2 tokens): `:125 -> :192`
- `docs/issues/contact-list-rule-duplication-and-fake-drift.md` (6 tokens): `:1220 -> :1869`, `:1226 -> :1875`, `:1196 -> :1846`, `:1226-1227 -> :1875-1876`
- `docs/issues/contact-type-refusal-copy-edge-cases.md` (11 tokens): `:1773 -> :2547`, `:1784 -> :2558`, `:1804 -> :2578`, `:1892 -> :2706`, `:1727-1737 -> :2496-2511`, `:1784-1791 -> :2558-2565`, `:1773-1775 -> :2547-2549`, `:1872-1879 -> :2674-2681`, `:244 -> :376`
- `docs/issues/deleted-contact-web-signup-silent.md` (7 tokens): `:501-546 -> :533-578`, `:437 -> :469`, `:501 -> :533`, `:590-592 -> :622-624`, `:620-624 -> :652-656`, `:630-640 -> :662-672`, `:511 -> :543`
- `docs/issues/flyer-signup-decline-click-race.md` (5 tokens): `:658-724 -> :690-777`, `:658 -> :690`, `:664 -> :696`, `:717 -> :770`, `:682-693 -> :735-746` (its 12 `units.ts` citations were checked and are current)
- `docs/issues/property-card-409-settle-dead-code.md` (2 tokens): `:1030 -> :1899`
- `docs/issues/provider-error-text-logged-twice-unmasked.md` (2 tokens): `:314 -> :670`
- `docs/issues/public-signup-abuse-hardening.md` (22 tokens): `:658-694 -> :690-747`, `:168-179 -> :198-211`, `:221-228 -> :253-260`, `:707-724 -> :760-777`, `:509-546 -> :541-578`, `:605 -> :637`, `:658-673 -> :690-705`, `:679-694 -> :724-747`, `:394-397 -> :426-429`, `:675-694 -> :707-747`, `:562 -> :594`, `:662 -> :694`, `:717 -> :770`, `:209 -> :241` (its 2 `units.ts:1495-1520` citations are current)
- `docs/issues/public-welcome-text-global-cap.md` (2 tokens): `:614-624 -> :646-656`
- `docs/issues/roster-liveness-read-eventual-consistency.md` (13 tokens): `:1747 -> :1920`, `:1858 -> :2031`, `:653 -> :704`, `:708 -> :759`, `:2434 -> :2639`, `:1408 -> :1920`, `:597 -> :759`, `:546 -> :704`
- `docs/issues/unit-media-dangling-reference-race.md` (4 tokens): `:702 -> :1435`, `:1127 -> :2441`
- `docs/issues/unit-photo-presign-empty-filetype.md` (1 token): `:460 -> :1068`

Already off when filed, so pointed at the code the text names:
- `unit-media-dangling-reference-race.md`: at its filing commit (`00ed514a`),
  `:702` was the transcode cap and `:1127` the placements 404. The new
  lines are the two `deleteRemovedUnitMedia` calls it describes: DELETE
  /photos and the PATCH diff.
- `provider-error-text-logged-twice-unmasked.md`: `:314` was the comment
  line above the welcome's `log.error` (`4478c3ff`). The new line is that
  `log.error`.

## Item 3: citations NOT re-pointed

- **Anchored to main `0f6f29f9` in the text** (each checked correct
  there):
  - `public-signup-abuse-hardening.md:21`, `public.ts:376-411`. The FW-P2
    report's map listed it (`:376-411 -> :389-424`); that would have been
    wrong.
  - `consent-capture-ignores-signup-web-form.md:17-18`, `public.ts:324-329`
    and `:399`.
  - `consent-capture-ignores-signup-web-form.md:123`, `public.ts:329` and
    `:384`.
- **Resolved issues** (status `resolved`; their lines record the code as
  filed or fixed):
  - `a2p-compliance-hardening.md`: `public.ts:50` x2
  - `contact-list-checks-outside-roster-write-loop.md`: `units.ts:1207` x2,
    `:1210`, `:1107` and its continuations. It also says outright: "Line
    references in this paragraph are at the end of fix wave 2 (534f971d);
    the ones below are as filed".
  - `contacts-batchget-amplified-reads.md`: 8 `units.ts` citations, "line
    numbers re-verified 2026-08-21"
  - `one-to-one-sender-not-pinned-to-ported-number.md`: `public.ts:161`,
    `:175`
  - `public-rate-limit-key-spoofable-xff.md`: `public.ts:31` x2, `:480`
  - `restore-without-landlord-can-leave-nobody-reachable.md`:
    `units.ts:445`, `:445-446`, `:445-447`
  - `unit-create-and-mms-media-ui.md`: `units.ts:270` x2
  - `unit-primary-contact-unchecked.md`: `units.ts:1072`, `:1072-1075`

  Say if you want these re-pointed too.
- **Open issues whose cited route code was refactored on main before this
  branch.** Digits cannot repair these:
  - `contact-list-rule-duplication-and-fake-drift.md`: refs `units.ts:467`
    and `:148`; body `:23` (`soleLandlordToPromote`, `units.ts:467-468`) and
    `:27` (`autoRoutingEligible`, `units.ts:148-149`).
    - Neither function exists in the route now. The rule is
      `landlordWasPrimary(...)` inside `clearedLandlordHeir`
      (`units.ts:755`), and the eligibility test is `isAutoRoutingEligible`,
      imported from `lib/propertyContact`.
  - `landlord-of-record-no-reassign-ui.md`: refs `units.ts:1615` and
    `:1669`; body `:53` (`:1615-1642`) and `:55` (`:1669`).
    - property-requirements D5 moved the landlord check into
      `writeFencedPatch`. The comment and the `fenced` choice are now at
      `units.ts:2356-2366`.
    - A body naming a `landlordId` no longer takes the plain `units.update`
      (`:2425`), so the issue's "the write is still the plain units.update"
      needs a content check, not new digits.
- **Content that may be stale behind a re-pointed line** (digits fixed,
  words not mine to change): `property-card-409-settle-dead-code.md` says
  `addContact` "has no 409 branch". The call (`units.ts:1899`) now sits in a
  try/catch that maps errors to 409s; whether the landlord-of-record
  collision is still silent was not checked.

## Not done

- The five-gate battery and any e2e run are the orchestrator's (none run
  here; no e2e session was started, and `e2e/.artifacts/session.pid` was
  absent throughout).
