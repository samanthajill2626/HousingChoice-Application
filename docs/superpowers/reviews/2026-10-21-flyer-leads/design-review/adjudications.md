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
