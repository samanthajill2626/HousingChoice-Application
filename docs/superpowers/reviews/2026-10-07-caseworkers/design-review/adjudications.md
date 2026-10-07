# Caseworkers (branch B) - design review adjudications

Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`.
Branch: `feat/caseworkers`. Planner: the feature-mission planner session.

## Round 1 (2026-10-07) - revision 9 -> revision 10

Two independent opus reviewers, B delta only: `R1-reviewer-a.md` (15 findings:
2 HIGH, 4 MEDIUM, 9 LOW) and `R1-reviewer-b.md` (13: 4 HIGH, 4 MEDIUM, 5 LOW).
Load-bearing claims re-checked in code by the planner before ruling:
`contacts.ts:1876-1884` (the PATCH flips only `unknown_1to1`),
`tourReminders.ts:1092-1093` (finds the tenant thread by type),
`import/apply.ts:1208` (imported 1:1 threads are `unknown_1to1`),
`conversationsRepo.ts:1252-1264` (create-or-get returns any open thread),
`today.ts:784-806` (Today keys "New unknown contact" on the THREAD type),
`extraction/prompt.ts:93-94` (the AI's caseworker line vs a mentioned caseworker).

Decisions CHANGED this round, so a round 2 follows.

| Finding | Ruling | What changed in revision 10 |
|---|---|---|
| A-F1 / B-F2 three paths, three records | ACCEPT | One caseworker conversion (D19), one server function; the contacts PATCH runs it whenever the result would be partner + `Caseworker` on a contact that is not already that; the Caseworker choice, Mark as Caseworker and Make caseworker leave the same record. |
| A-F3 refusals: no server rule, scope, two-step bypass | ACCEPT (a-c); DEFER (d) | Refusals live in the conversion, checked whatever the stored type, answered 409 on the PATCH too; the Partner-then-Caseworker path hits them at the second save. (d) tours/placements created or reopened later check no contact type: stated as accepted, filed (section 12) - extending those routes is outside B. |
| A-F2 / B-F3 D21 re-types on the unguarded path | ACCEPT | The generic type change keeps TODAY's thread rule (flip `unknown_1to1` only). The old-type re-type belongs to the conversion alone, whose refusals make it safe. |
| B-F4 partner -> caseworker threads never re-typed | ACCEPT (conversion); REJECT the send-time re-type | The conversion re-types old-type and `unknown_1to1` threads whether or not the type changed. Re-typing at send time for every un-converted partner is rejected: imported tenants have the same `unknown_1to1` threads today, so it is a pre-existing class, stated in D20 and filed, not fixed by B. I2 narrowed to what it guarantees. |
| A-F4 "other identity" decided by type only | ACCEPT, refined | A thread is the contact's only when its participant `contactId` is the contact, or it has none and the phone's/address's owner lookup is the contact (participant contactIds can be blank: `import-blanks-conversation-participant-contactid`). |
| A-F5 / B-F5 only the housing-authority suggestion superseded | ACCEPT (conversion only) | The conversion supersedes ALL pending suggestions. The generic type change stays as today; `stale-suggestions-survive-contact-retype` remains open for it. |
| A-F6 / B-F7 write path stated two ways; side effects unenumerated | ACCEPT | One function called by both the PATCH and the route; write order (contact write = commit point, then suggestions, threads, then audit / milestone / events / vocabulary); partial failure repaired by an idempotent re-run. |
| B-F1 notes word-match lists real tenants | ACCEPT, partly | Match only the AI's own "Identified as a caseworker" line in the AI `notes` field, not the bare words; staff notes not read. Make caseworker on a tenant/landlord row asks first (a confirm naming what is removed). The conversion's audit carries the removed values. REJECT making tenant rows admin-only: the confirm plus the recoverable audit cover it, and who-can is Cameron's ruling 4. |
| A-F8 / B-F6 off-list values destroyed; "exactly a list name" ambiguous | ACCEPT | Agency then housing authority are resolved against BOTH lists; when neither resolves, the text is carried into `organization` as a not-on-the-list value (a stated D5 exception, the importer's precedent) and appears in Settings' "Not on the list" for staff to settle. |
| A-F7 route input domain | ACCEPT | 404 deleted/missing; 400 team_member; `make` on a caseworker idempotent 200; `dismiss` on a caseworker 400; `make` on unknown allowed. Check-then-write race stated as accepted. |
| A-F9 / B-F10 usage column, kind-change text | ACCEPT | Column renamed "Organization" (every holder, any type); one record may count in two columns; Delete counts distinct records; section 6 and D10 kind-change text exempt organization holders; organization kept as data on a type change away from partner (stated). |
| A-F10 / B-F8 vocabulary still suggests caseworker | ACCEPT | The Other role suggestions on a tenant/landlord base leave out every `isCaseworkerRole` value, not only the placeholder. |
| B-F9 wording list incomplete | ACCEPT | Adds the landlord timeline "Sent to N tenants", the unresolved-seed note, the Broadcasts subtitle and "Send this property to tenants". |
| B-F11 Unknown card has four actions; create form Organization | ACCEPT | Mark as Caseworker goes after Partner; the create form does not offer Organization (POST ignores org fields). |
| A-F11 / B-F12 criteria edges | ACCEPT | Deleted excluded; one "mentions" rule for tenant and landlord bases; relationship rows on unknown/team_member contacts and partners with a non-caseworker role stated as accepted. |
| A-F12 importer type changes never re-type | ACCEPT (wording) | I2 states it covers staff changes only (pre-existing). |
| A-F13 A2P position unstated | ACCEPT as a ruling | Planner default stated in D20 (covered); added to Cameron's rulings. |
| A-F14 preview shows a partner's authority as voucher facts | ACCEPT | Preview rows carry voucher size and housing authority only for tenant-typed recipients. |
| A-F15 / B-F13 header hides the authority on unknowns | ACCEPT | Header facts show for `tenant` and `unknown`. |

Counts: 28 findings (13 distinct after de-duplication across reviewers and
the shared root causes); all accepted in substance; 3 partial rejections
(send-time re-type, admin-only tenant rows, extending the tour/placement
guards - the last deferred to section 12).
