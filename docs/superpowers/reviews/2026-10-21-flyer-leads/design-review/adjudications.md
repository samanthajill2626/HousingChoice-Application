# Flyer-leads spec - design review adjudications

Spec: `docs/superpowers/specs/2026-10-21-flyer-leads-design.md`.

## Round 1 (2026-10-21) - two opus reviewers, independent

- Reports: `R1-reviewer-a.md` (15 findings) and `R1-reviewer-b.md` (15 findings),
  run against rev 1 @880c5973.
- They overlap heavily, so they are merged below (M-numbers) with both
  reviewers' ids.
- Load-bearing claims were checked in the code before ruling:
  - `listingSendsRepo.ts:14-16,318-326` - via is first-write furniture;
  - `shareLedger.ts:77-120` - mayReplace and the summarize key -> broadcastId
    mapping;
  - `listingSendOutcome.ts:42-131` - decline supersession, Replied needs
    heard > sentAt, and isWaiting;
  - `FlyerPage.tsx:57-59,302` - the h1 is the AREA, with "A home for you"
    only as its fallback;
  - `contactsRepo.ts:1287-1314,1342` - findByPhone returns the first GSI hit,
    and findAllByPhone exists;
  - `voiceMasking.ts:28-39` - conversationTypeFor;
  - `activityEventsRepo.ts:31-69,111-182` - only `listByContact` reads, with
    no lower bound.

Result: 18 merged findings - 17 ACCEPT, 1 ACCEPT in part, 0 REJECT, 0 DEFER.
**Decisions changed: YES**, so round 2 is required:
- D6 dedupe scope;
- D7 ledger shape and first-sight rule;
- a new send outcome;
- the deleted-contact path;
- the thread type;
- consent stamping;
- the phone-holder choice.

| # | Findings | Sev (reviewer) | Ruling | What changed in rev 2 |
|---|---|---|---|---|
| M1 | A2, B1 | HIGH | ACCEPT | The 24-hour rule is keyed on a source the milestone never stores, and junk unitIds defeat it. Rev 2: at most ONE sign-up pin and ONE unread bump per CONTACT per 24 hours, whatever the source, so nothing needs storing. Residual stated: an attacker who knows a phone can plant one pin a day carrying their typed name. The roster removal scan (`jobs/rosterActions.ts:231-245`, 250-event cap) stays bounded by the same cap. |
| M2 | A1, B2 | HIGH | ACCEPT | "Flyer row" does not fit the ledger: via and broadcastId are PAIR attributes. Rev 2: the flyer is an ENTRY. Share key `flyer`, attempt `<ISO>#flyer`, state `counted`, by `acceptance`. `via` is untouched, and `summarize` maps `flyer` like `individual` (no broadcastId). The entry is written only when the pair has NO counted entry yet (first sight), so it never moves an existing pair's sentAt. |
| M3 | A3, B10 | MEDIUM / LOW | ACCEPT | Decline supersession, the pin re-wording and the repair census. First-sight-only means a declined or replied pair (always counted) is never touched. Remaining residual, stated: an UNCOUNTED pair (a failed text) becomes counted, and its old "Property text failed" pin re-reads "Property sent"; the repair script's census sees the new entries. |
| M4 | A4, A15, B3 | MEDIUM | ACCEPT | Readers rendered a sign-up as an unanswered text. Rev 2 adds the outcome `signed_up`: the pair's latest counted entry is the flyer entry, and no decline, tour or reply supersedes it. It is never "waiting", so not on Follow up. The roster row reads "Signed up from the flyer <date>" with the chip "Signed up". A later reply makes it "Replied" as usual. Every outcome reader is listed in section 4. |
| M5 | A5, B7 | MEDIUM | ACCEPT | The heading baseline was wrong: today it is the area. Rev 2 corrects the baseline. The area is KEPT as a line under the address heading, and the GLOSSARY is updated. |
| M6 | A6, B8 | MEDIUM | ACCEPT | Deleted-match contradiction. Rev 2: a deleted-only match writes no conversation, no send, no pin, no unread and no row, but KEEPS the `housing_fair_signup` audit with `deletedContact: true` (the open issue relies on that trace). |
| M7 | A7 | MEDIUM | ACCEPT | findByPhone returns an arbitrary holder. Rev 2 uses `findAllByPhone` and ignores deleted holders when a live one exists. The contact recorded on is the live holder ranked tenant > unknown > partner > landlord > other (ties: the first returned). All holders deleted means the deleted path; no holder means create. |
| M8 | A8, B4 (part) | MEDIUM | ACCEPT | Unspecified failure modes. Rev 2: every step after the contact is resolved (dedupe read, pin, touch / unread, ledger write, consent stamp) is best-effort and logged with the marker. The dedupe read fails OPEN (records). The response is always `{ ok: true }` once the contact exists or is created. |
| M9 | A13, B4 | LOW / MEDIUM | ACCEPT | No repo method for the window. Rev 2 names `activityEventsRepo.hasEventSince(contactId, type, sinceIso)`: a key-range query on `tsEventId > sinceIso`, filtered by type and paginated to the end of the window. It needs the harness fake and the fake-vs-real conformance coverage. |
| M10 | A9, B5 | MEDIUM | ACCEPT (flagged for Cameron) | Consent given on the form was discarded, so staff's manual reply hits the consent gate. Rev 2: the ONE write to an existing contact is the web-form consent stamp (`consent_method` / `consent_at` / `consent_version`), and only when the contact has NO `consent_method`. Opt-out state is never touched. A narrow exception to the #14 "never changed" rule, shown at the gate. |
| M11 | A10, B6 | LOW / MEDIUM | ACCEPT | Mistyped thread. Rev 2 resolves an existing contact's thread with `conversationTypeFor(contact)`; new contacts keep `tenant_1to1`. The "as for any other non-message bump" wording is dropped. |
| M12 | A11, B9 | LOW | ACCEPT | Wrong stale-page consequence: an old page crashes rather than printing "$undefined". Rev 2 corrects it and keeps the acceptance (the window needs a reload, and a reload loads the new bundle). The `unitFields.ts` "only ADDS keys" comment is rewritten to record this deliberate removal. |
| M13 | A12, B11 | LOW | ACCEPT | Goal 4 vs D7, and `unknown` excluded for good. Rev 2: the row goes to `tenant` AND `unknown` contacts, and the goal text matches the rule. |
| M14 | B12 | LOW | ACCEPT | Unread before touch could leave an invisible unread thread. Rev 2: touch first, then incrementUnread, then emit `conversation.updated` once, carrying the new count. |
| M15 | B13 | LOW | ACCEPT | Heading gaps. Rev 2: a zip-only address uses the city-line fallback; the sr-only " - open in Google Maps" suffix stays inside the heading link; `addressLines` is deleted. |
| M16 | A14, B14 | LOW | ACCEPT | Section 4 omissions, all added: the dev listing-send fixture (`dev.ts:1433-1484`, unchanged signature), the dashboard `ListingSendRow` types, the harness fakes and their conformance test, the repair script, `unitFields.test.ts`, `requirements.test.ts`, and the property Activity card (unchanged - a sign-up is not a property audit). |
| M17 | B15 | LOW | ACCEPT | GLOSSARY drift. Rev 2 lists `documentation/GLOSSARY.md`: lease terms / pets / deposit are staff only; area is the line under the address; the `signed_up` milestone and the `flyer` share entry are new terms. |
| M18 | A2 side effect | LOW | ACCEPT in part | Junk milestones crowding the roster removal scan. Covered by M1's per-contact cap; no separate change. |

Planner notes: no rejections this round. Both reviewers independently found
M1/M2 (HIGH) and M4/M5/M6/M8/M10. M7 (shared phone holders) was reviewer A only;
M14 and M17 were reviewer B only. Reviewer B landed more accepted findings
(15 vs 14 merged), so B is continued for round 2.

## Round 2 (2026-10-21) - reviewer B continued, re-review charge

- Report: `R2-reviewer-b.md` (12 findings), run against rev 2 @bd73315c.
- Claims checked in the code:
  - `contactsRepo.ts:746-755,1279`: findAllByPhone EXCLUDES deleted holders;
  - `Card.tsx:348`: the roster action gate is `no_reply` or `replied` only;
  - `listingFormat.ts:338-354`: every other outcome files under Waiting;
  - `sendMessage.ts:541-557` plus `dashboard/src/routes/contact/ConsentCaptureModal.tsx`:
    the JIT gate has a dashboard capture prompt, so it is friction, not a dead end.

Result: 12 findings, 12 ACCEPT, 0 REJECT. **Decisions changed: YES**, so round 3
is required:
- reverted rev 2's M7 (holder ranking) and M10 (consent stamp);
- replaced first-sight with always-write;
- added the roster actions and the Interested grouping for `signed_up`.

| # | Sev (reviewer) | Ruling | What changed in rev 3 |
|---|---|---|---|
| R2-1 | HIGH | ACCEPT | findAllByPhone cannot see deleted holders, so the deleted path was unreachable. Rev 3 keeps `findByPhone`, which sees deleted holders, as the one lookup: live means existing, deleted means the deleted path (audit on that contact). M7's ranking is REVERSED. |
| R2-2 | MEDIUM | ACCEPT | A ranked holder disagreed with the inbox, unread feed and send gates (all `findByPhone`). With `findByPhone` everywhere, they all judge one contact. Residual: on a shared phone the first index hit decides, the app-wide accepted risk at `contactsRepo.ts:1288`. |
| R2-3 | MEDIUM | ACCEPT | A `signed_up` row lost its actions and filed under Waiting. Rev 3: it offers Interested / Request a tour / Not interested (the Card gate adds `signed_up`), and the property card files it under Interested. `listingFormat.ts` is added to section 4. |
| R2-4 | MEDIUM | ACCEPT | A consent stamp without the welcome conflicts with the A2P design (stamp + welcome). M10 is REVERSED: no write to an existing contact. Staff's first manual text uses the existing `ConsentCaptureModal`. The audit keeps `consentVersion` as evidence. |
| R2-5 | MEDIUM | ACCEPT | First-sight left already-sent pairs at "No reply yet" on Follow up. Rev 3 always writes the flyer entry (the newest counted entry wins): no reply / replied become `signed_up`, an older decline is superseded (newer interest; stated with the attacker residual), and a tour stays Interested. |
| R2-6 | MEDIUM | ACCEPT (moot) | First-sight was unenforceable inside the token write. Removed with R2-5. |
| R2-7 | LOW | ACCEPT | An `unknown` contact's entry is invisible on its own page; stated in Goal 4 and D7. |
| R2-8 | LOW | ACCEPT (moot) | The guard for the consent stamp. The stamp was removed with R2-4. |
| R2-9 | LOW | ACCEPT | The cap vs the second flyer, and attacker pre-emption. Both stated as residuals; the flyer entry is still written. |
| R2-10 | LOW | ACCEPT | One `latestCountedShareKey` helper beside `summarize`; `deriveListingSendOutcome` takes `shares`. |
| R2-11 | LOW | ACCEPT | The event is the touched image with the incremented count spliced in; a failed increment still emits the touched image. |
| R2-12 | LOW | ACCEPT | Text gaps: the city line is not repeated, the deleted-path audit entity is named, and the first-sight read is gone. |

Concession received: reviewer B withdrew its R1 #6 claim that only caseworker
conversion re-types a thread (`contacts.ts:537-543,1658` also does). The
`conversationTypeFor` fix stands.

## Round 3 (2026-10-21) - reviewer B continued, re-review charge

- Report: `R3-reviewer-b.md` (7 findings), run against rev 3 @845d427a.
- The reviewer conceded R2-1 and R2-2, contested R2-4 (finding 2), and confirmed:
  - a newer `<ISO>#flyer` attempt always replaces the old one (`shareLedger.ts:78-90`);
  - `summarize` drops `broadcastId` for the flyer key;
  - all five outcome callers hold full rows with `shares`;
  - the event splice matches `toConversationUpdatedEvent`.

Result: 7 findings, 7 ACCEPT, 0 REJECT. **Decisions changed: YES (one)**: a
sign-up never clears a decline. So round 4 runs. It is the CAP: if it still
changes a decision, the open findings go to Cameron as decisions.

| # | Sev (reviewer) | Ruling | What changed in rev 4 |
|---|---|---|---|
| R3-1 | MEDIUM | ACCEPT | Uncapped repeat flyer writes undid every later staff decline, and "harmless" was false; the sign-up copy ("this home and others") is not proof of interest in a declined home. Rev 4: NO flyer entry while the pair holds a current decline (decline at or after `sentAt`), refused inside the conditional write beside `mayReplace`. The pin and unread mark still tell staff. Rev 3's supersession is REVERSED. Test: decline after a sign-up, then a second sign-up, and the decline holds. |
| R3-2 | LOW | ACCEPT (residual) | The consent prompt has no web-form method. Rev 4 states it: staff record the basis they hold, and the audit keeps the form evidence. Cameron's 2026-10-21 rule (no welcome for contacts "already part of it") rules out the stamp-plus-welcome alternative; it is mentioned at the gate. |
| R3-3 | LOW | ACCEPT | A dangling first pointer means `findByPhone` returns nothing, so create and welcome, as today. Added to D4's residual. |
| R3-4 | LOW | ACCEPT | A lost flyer write is never repaired (the repair walks broadcast slots). Rev 4 states it; the flyer path's log does not claim repair; `sentRecorded` is false. |
| R3-5 | LOW | ACCEPT | A failed touch means no increment and no event. Stated. |
| R3-6 | LOW | ACCEPT | Whole-second vs millisecond ordering within about 1 s is arbitrary. Stated as cosmetic. |
| R3-7 | LOW | ACCEPT | "Request a tour" is partner-only, so it never shows on these rows; eligibility decides between Interested and Not eligible. D8 and the tests corrected. |
