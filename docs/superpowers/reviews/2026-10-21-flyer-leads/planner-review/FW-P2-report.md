# FW-P2 report - feat/flyer-leads (Cameron's verdict decisions)

Scope: items 1-4 of the FW-P2 section of `adjudications.md` (same
directory), plus item 5's `npm run issues`. No main sync, no full suite run,
no review round. Base `5e06423f`.

## Commits

- `f53eacda` fix(dashboard): item 1 (the Staff only legend lines)
- `1ed6af53` fix(app): item 2 (the opted-out note on the sign-up pin)
- `337fb87e` docs(glossary,selectors,spec): item 3
- `3bae6272` docs(issues): item 4
- this report, last

## RED / GREEN evidence

Bare runs, output to `.superpowers/sdd/gates/fwp2-*.log`, then `EXIT:$?`.

| Item | Run | Result |
|---|---|---|
| 1 RED | `cd dashboard && npx vitest run src/routes/listing/FlyerTag.test.tsx src/routes/listing/ListingEditForm.test.tsx src/routes/listing/UnitCreateForm.test.tsx` | 3 files failed; 4 failed / 178 passed (182), EXIT:1. Reason: the old line rendered - FlyerTag received `Staff only - never leaves the dashboard.` for both audiences; the two form tests: "Unable to find an element with the text: Staff only - not on the public flyer." |
| 1 GREEN | same three files | 3 files, 182 passed, EXIT:0 |
| 2 RED | `cd app && npx vitest run test/publicSignupLeads.test.ts` | 5 failed / 58 passed (63), EXIT:1. Each new case fails on the pin-label assertion: the label has no note. The join-page case, whose diff vitest folded into the not-shareable one, was run alone (`-t`): 1 failed / 62 skipped, EXIT:1, same reason. The PIN case (both flags false) passes before and after. |
| 2 GREEN | `test/publicSignupLeads.test.ts test/publicIntake.test.ts` | 2 files, 123 passed (63 + 60), EXIT:0 |
| 2 neighbors | `test/settings.test.ts test/rateLimitClientKey.test.ts test/cloudfrontBehaviors.test.ts test/backfillJoinHousingAuthority.test.ts` | 4 files, 175 passed, EXIT:0 |
| e2e | C2 (no session pid, lane 12 ports 10201 / 10211 / 10221 / 10231 free), then `timeout 1500 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/property-requirements.spec.ts tests/dashboard-next/flyer-leads.spec.ts`, source at `1ed6af53` | 6 passed (2 + 4, 25.9s), EXIT:0. Afterwards `session.pid` held a DEAD pid (50064, the run's own launcher after the tree-kill teardown): cleared with `npm run e2e:stop` (EXIT:0, "nothing to stop"); no pid file, ports free. Docs (not source) were edited during the run; nothing was committed while it ran. |
| typecheck | `npm run typecheck` on the item 1 tree and on the item 2 tree | EXIT:0 each; items 3 and 4 are docs-only |
| eslint | `npx eslint` on the 7 touched .ts / .tsx | EXIT:0, no errors (none pre-existing in these files either) |
| issues | `npm run issues` | EXIT:0 (437 open, 213 closed, 650 total); `INDEX.md` is gitignored, not committed |
| ASCII, `\u` | added lines of the 11 modified files; the whole new issue file | 0 non-ASCII bytes, 0 `\u` hits |

## Where the live code differs from the list's wording

- Item 1: at the base, every hit of "never leaves the dashboard" outside
  `docs/superpowers/` was in the five files the list names
  (`FlyerTag.tsx:36`, `:41`; `FlyerTag.test.tsx` x2;
  `ListingEditForm.test.tsx:339`; `UnitCreateForm.test.tsx:1061`;
  `property-requirements.spec.ts:277`); none is left. None
  in `app/`, `documentation/`, `docs/issues/` or `e2e/support/`, and no doc
  quotes the legend as current text. 14 files under `docs/superpowers/`
  (records, older plans) still quote it as history and were not changed. The
  landlord Staff only line has no e2e pin (`contact-detail.spec.ts:161-166`
  pins only the On property flyers line); none was added. A three-line
  comment on `LEGEND` (`FlyerTag.tsx:35-37`) records why the lines speak of
  the flyer only.
- Item 2, where the judgment sits: `optedOut` is computed in step (3b),
  just before the pin (`app/src/routes/public.ts:692-697`), not right after
  the thread step (`:618-619`). The pin is its only consumer, its inputs are
  the same two objects (neither is reassigned in between), and the welcome
  region's lines stay put. The words: `SIGNUP_OPTED_OUT_NOTE`
  (`public.ts:161-168`) and the `optedOut` argument of `signupPinLabel`
  (`:179-192`); import at `:97`.
- Item 2, "the send path's rule": sendMessage's gate is
  `isOptedOut(conversation.sms_opt_out, phoneContact?.sms_opt_out) ||
  heldRecipient?.sms_opt_out === true` (`app/src/services/sendMessage.ts:512-514`).
  The handler's `contact` is the phone-matched contact (`findByPhone`, or the
  contact it just created), and the welcome names no recipient, so the two
  agree. One difference that comes with "no new read": the handler's thread
  is the `createOrGetByParticipantPhone` result (the eventually consistent
  GSI fast path, or the claim's `getById`), while sendMessage reads the
  thread by id itself. A STOP landing in the same instant could reach the
  welcome's gate and not the note.
- Item 2 tests (appended at the END of `publicSignupLeads.test.ts`, so the
  abuse issue's `publicSignupLeads.test.ts:750-761` citation stays right):
  contact flag in all three forms; thread flag, with the unread mark, the
  flyer entry, the exact audit payload (no new field) and the 24-hour repeat
  check unchanged; a NEW contact on an open `unknown_1to1` thread with no
  participants and the flag (welcome refused with `contact_opted_out`, the
  new contact carries no `sms_opt_out`); PIN both flags `false` -> no note.
  The cases also pin that neither flag is cleared or written.
- Item 2 pins elsewhere: no e2e spec or other app test pins a pin label for an
  opted-out number. The flyer-leads spec's labels (`flyer-leads.spec.ts:530`,
  `:644`, `:710`) are for numbers that never opted out, and
  `publicIntake.test.ts:210-230` seeds an opted-out contact but asserts no
  label. Nothing was updated.
- Item 4: the list puts the "Sent <sign-up date>" words "on the contact's
  Properties sent row (`Card.tsx`)". The live `SendRosterRow` (`Card.tsx:315`,
  words `:351`, rendered `:371`) is also the PROPERTY page's Sent to card
  (`ListingDetail.tsx:1345`) and the partner file's list
  (`PartnerFile.tsx:197`), so the issue names all three. On Follow up it
  reaches Replied rows only (`isWaiting`, `listingSendOutcome.ts:130`). The
  fix direction also notes that the existing wire `via` cannot carry the
  flyer: a row the flyer entry created reads `via: 'broadcast'`
  (`shareLedger.ts:271-274`).
- Item 4, consent issue: I was editing it anyway, so its other current-tree
  `public.ts` citations were re-pointed to the item 2 tree and the file stays
  on one numbering. Frontmatter and body: `:217` -> `:230`, `:551` -> `:564`,
  `:562-593` -> `:575-606`, `:605-606` -> `:618-619`, `:629` -> `:642`,
  `:744-757` -> `:763-776`; added `:168`, `:697`. The main-tree citations
  (`0f6f29f9`'s `:324-329`, `:329`, `:384`, `:399`) are unchanged.
- Item 3: the GLOSSARY entry, the selectors row and the consent issue each
  keep the suffix string on one line, so it stays greppable. Spec: the two
  bullets are appended verbatim after the last section 7 bullet, at 75
  columns or less, with the quoted legend lines and the suffix unbroken.
  Nothing else in the spec changed.

## Not done (outside items 1-4)

- Item 2 shifted lines in `app/src/routes/public.ts`. Four OTHER issue files
  that P2-F1 had re-pointed to the pre-FW-P2 tree were NOT edited. Map from
  the pre-FW-P2 tree (`5e06423f`) to now: lines 1-96 unchanged; 97-159 +1;
  160-166 +10; 167-173 +11; 174-175 +12; 176-678 +13 (176-178 rewritten);
  679 and up +19. Each mapping below was checked against the same code line:
  - `deleted-contact-web-signup-silent.md`: `:437` -> `:450`, `:501` -> `:514`,
    `:501-546` -> `:514-559`, `:511` -> `:524`, `:590-592` -> `:603-605`,
    `:620-624` -> `:633-637`, `:630-640` -> `:643-653`;
  - `flyer-signup-decline-click-race.md`: `:658` -> `:671`, `:658-724` ->
    `:671-743`, `:664` -> `:677`, `:682-693` -> `:701-712`, `:717` -> `:736`;
  - `public-signup-abuse-hardening.md`: `:168-179` -> `:179-192`, `:209` ->
    `:222`, `:221-228` -> `:234-241`, `:376-411` -> `:389-424`, `:394-397` ->
    `:407-410`, `:509-546` -> `:522-559`, `:562` -> `:575`, `:605` -> `:618`,
    `:658-673` -> `:671-686`, `:658-694` -> `:671-713`, `:662` -> `:675`,
    `:675-694` -> `:688-713`, `:679-694` -> `:698-713`, `:707-724` ->
    `:726-743`, `:717` -> `:736`;
  - `public-welcome-text-global-cap.md`: `:614-624` -> `:627-637`.
  Three older files cite pre-flyer-leads trees and were already off before
  this wave (`one-to-one-sender-not-pinned-to-ported-number.md` `:161`,
  `:175`; `provider-error-text-logged-twice-unmasked.md` `:314`;
  `public-rate-limit-key-spoofable-xff.md` `:480`).
  `a2p-compliance-hardening.md` `:50` is unaffected.
- Item 5's five-gate battery is the orchestrator's.
