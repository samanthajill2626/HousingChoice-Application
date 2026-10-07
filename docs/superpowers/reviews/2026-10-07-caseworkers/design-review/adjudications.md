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

## Round 2 (2026-10-07) - revision 10 -> revision 11

Reviewer A continued (it landed the most accepted round-1 findings and held
reviewer B's report): `R2-reviewer-a.md`, 11 findings (2 HIGH, 5 MEDIUM, 4
LOW) plus concessions. Decisions CHANGED again, so a round 3 follows (cap 4).

The root of findings 1, 5, 6 and 10 is one design choice of revision 10:
running the conversion INSIDE the contacts PATCH. Ruling: reverse it. The
conversion becomes one action - a confirm dialog with an Organization picker
and one route - reached from the Possible list, the Unknown card's Mark as
Caseworker and a Make caseworker action on contact pages; the PATCH refuses
409 `caseworker_use_conversion` a write that would make a caseworker.

| Finding | Ruling | What changed in revision 11 |
|---|---|---|
| 1 conversion overwrites a staff-picked organization | ACCEPT | Request (the dialog's picker) wins, else stored, else derived; the edit form no longer offers Caseworker on a non-caseworker, so there is no same-save pick to lose. |
| 2 repair does not work | ACCEPT (a, b, d); (c) stated | Threads: re-type every OWN thread not already `partner_1to1` (old-type limit dropped). Removed values recorded atomically in the commit write (`caseworker_conversion`). The PATCH no longer converts, so (d) is moot. (c) repair stays route-only, logged and named in RUNBOOK - a page button for a rare partial failure is not worth a surface. |
| 3 participant matching cannot see a shared phone | ACCEPT | Own = no other live holder of the phone/address by an all-holders byPhone/byEmail Query (pointer rows resolved), plus participant check; the plan adds the read; the dialog counts left-alone threads. |
| 4 blanket supersede vs `accepted` and the guarded type drain | ACCEPT | Type suggestion through the existing revision-guarded drain; every OTHER suggestion superseded after it. |
| 5 PATCH request semantics undefined | ACCEPT (by removal) | The PATCH never runs the conversion; the route owns its whole write; the write condition is named (`classification_revision`, 409 `contact_changed`). |
| 6 contest: admin-only rejection's reasons fail on two paths | ACCEPT the contest | Every entry point opens the same confirm dialog; the removed values survive in the commit write. The rejection of admin-only stands on that mechanism; who-can remains Cameron's ruling. |
| 7 relationship signal silently widened | ACCEPT | Restored to tenants only (an editing slip in revision 10), with the reason stated; Marcus Bell's e2e link no longer reaches the list. |
| 8 "other provenance stamps" is the empty set | ACCEPT | Stated: other tenant facts stay as data with their stamps; only `housingAuthority` and its stamp are removed. |
| 9 agency-first inverted for off-list; D13 limits skipped | ACCEPT | The agency wins whenever present (resolved or carried); carried text must pass D13's limits or stays only in `caseworker_conversion`. |
| 10 PATCH vs route inputs; "already a caseworker" undefined | ACCEPT | One entry point; "a caseworker" defined once: partner + `isCaseworkerRole`. |
| 11 units scan inside an interactive save | ACCEPT | Stated as accepted on the explicit action; folded into the section 12 cost item. |
| 12 concessions; name the tour harm | ACCEPT | Section 12 item names it: a reopened tour has no reminder thread. |

## Round 3 (2026-10-07) - revision 11 -> revision 12

Reviewer A continued: `R3-reviewer-a.md`, 6 findings (2 MEDIUM, 4 LOW). It
verified the PATCH's new 409 `caseworker_use_conversion` breaks no current
writer (seeds, importer, AI accept path, app/dashboard/e2e tests), conceded
round-2 ruling 2(c) and contested nothing.

| Finding | Ruling | What changed in revision 12 |
|---|---|---|
| 1 dialog's counts and prefill have no read | ACCEPT | New read-only `GET /api/contacts/:contactId/caseworker-review/preview` from the same server code: refusals now, removed values, suggestion count, thread counts, the organization and its source. Advisory; `make` recomputes. |
| 2 carried prefill hits D5 on send; clear has no wire form | ACCEPT | `organization` omitted = server decides (carry included); non-empty = staff pick, D5-checked; `''` = clear. The dialog sends it only when staff changed the picker. |
| 3 page action must key on type | ACCEPT | Keyed on `contact.type` (tenant/landlord/partner), live contacts only; the landlord page's usual refusal is shown by the preview. |
| 4 commit write stale against org edits | ACCEPT | Conditional also on the `housingAuthority`, `agency` and `organization` values read; 409 `contact_changed`. |
| 5 repair text stale; second conversion; new-contact record | ACCEPT | Old-type phrase dropped; a later conversion replaces the record (the earlier survives in its audit); new-contact caseworkers have none (stated). |
| 6 cross-section wording | ACCEPT | Section 11 names the RUNBOOK repair entry; D18 counts new-contact Caseworker saves; D16's `accepted` path is the conversion. |

Decision check: finding 1 ADDS a read surface (a decision change by the
rule), finding 2 fixes a route contract. Both fill gaps in the round-2
design rather than move it. Round 4 (the cap) is a narrow check of these
two additions only.
