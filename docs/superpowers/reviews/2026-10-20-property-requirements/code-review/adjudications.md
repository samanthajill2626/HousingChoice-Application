# Code review adjudications - property requirements (round 1)

Branch feat/property-requirements, reviewed at 738a2b4e (the single main sync,
merge of main @3df43172). Three fresh opus reviewers, in parallel, while the
completion gates ran (their tests waited for the gates' end marker):

- RC - spec conformance (spec, plan 0-4, worklist): `R1-conformance.md` -
  0 blocker, 0 high, 0 medium, 1 low, 10 info. Every spec decision D1-D13 and
  D10a CONFORMS.
- RA - plan-blind adversarial, server: `R1-adversarial-app.md` - 1 medium,
  3 low, 6 info.
- RD - plan-blind adversarial, dashboard + e2e: `R1-adversarial-dashboard.md` -
  1 medium, 8 low, 5 info.

Gates at 738a2b4e (before review): typecheck 0, npm test 0, smoke 0, e2e 0
(367 passed, 18.8m), lint 1 = 5 pre-existing react-hooks errors,
branch-attributed 0 (baseline compare). The fix wave below changes code, so
every gate re-runs on the final commit.

## Rulings

| # | Finding | Severity | Ruling | Fix unit |
|---|---|---|---|---|
| RA-1 | The unit requirements fence (landlordId + requirement_sources) does not cover the item VALUES a write is computed from: two overlapping saves of one item can record a wrong source (a later Apply then overwrites a value set on the property unseen), store BOTH deposit forms (D1 broken, on the public flyer), and let Apply overwrite an edit made between its read and its write. Confirmed on the harness fake and on DynamoDB Local. | MEDIUM | ACCEPT - OR-29 below (overrides plan ruling AR11 with evidence) | FW1a |
| RA-2 | Landlord PATCH: `deposit_conflict` and the landlord-only gate are decided on a read the write is not conditioned on (both deposit forms storable by a race; req_ keys can land on a contact re-typed mid-save). | LOW | ACCEPT - OR-30 | FW1a |
| RA-3 | `WRITABLE_FIELDS[key]` is an inherited lookup: `__proto__` (and `toString`, `constructor` ... - pre-existing) pass the strict allowlist; through the prototype the new fenced PATCH sees a fake landlordId change and wipes requirement_sources with no trace. | LOW | ACCEPT - `Object.hasOwn` before the lookup; regression tests for `__proto__` and `toString` (400 unknown field) and the map kept | FW1a |
| RA-4 | The importer's fill of a vacant landlordId keeps requirement_sources. | LOW | REJECT - spec D5 decides exactly this ("The importer's fill of an absent landlordId does not touch the map ... Accepted"); spec section 5: no importer change | - |
| RA-5 | A legacy stored bedroomSize n reads as [min(n, 4)] (widens old drafts; old sent shares project 4+). | INFO | NO ACTION - spec D12 and section 4 decide it | - |
| RA-6 | Apply refuses an `expected` without exactly the item's keys (a future field would 400 open tabs). | INFO | NO ACTION - spec D8 / AR14 bind the exact-keys refusal; noted for the next registry change | - |
| RA-7 | The fenced PATCH reads the landlord contact on every attempt even when no requirement item is touched (only an unchanged landlordId re-sent). | INFO | ACCEPT (cheap): skip that read when the body touches no requirement key and the landlord does not change; a test pins that such a save never reads contacts | FW1a |
| RA-8 | unit_updated.fields means different things on the two PATCH paths. | INFO | NO ACTION - PR1-10 / PR2-2 | - |
| RA-9 | Apply of Touring switches a property's interested routing. | INFO | NO ACTION - spec section 4 states it | - |
| RA-10 | Apply is not transactional; it accepts a soft-deleted landlord. | INFO | NO ACTION on the first (spec D8). The second: handback item for Cameron with RD-13 | - |
| RD-1 | Apply dead-ends on 409 deposit_conflict: generic "Couldn't update ... press Update again" on every retry, and the landlord card / dialog show only "One month's rent" (the amount is dropped), so nothing explains the refusal. | MEDIUM | ACCEPT - OR-31 | FW1b |
| RD-2 | Staff surfaces round requirement money to whole dollars while equality is exact (a tag / an Apply change nobody can see; staff and tenants read different amounts). | LOW | ACCEPT - a requirement money formatter that keeps cents when present (`$1,250.40`, integers unchanged `$1,400`) for formatItemValue; the flyer keeps its existing formatter (plan 1.1) | FW1b |
| RD-3 | A stopped Apply run drops the earlier batches' skips. | LOW | FILE - spec D8 defines the stop message (N only; "the re-read shows the true state"); new issue `apply-stopped-run-drops-earlier-skips` | orchestrator |
| RD-4 | The New property dialog (and the contact Edit dialog) survive a contact change: the New dialog re-opens on the next contact, locked to it, and its D7 read loads that contact as the landlord (another landlord = a property under the wrong owner). | LOW | ACCEPT - the contactId reset effect also closes `addingProperty` and `editing` (and any other open per-contact dialog flag the page holds); ContactDetail test: open + Add a property on L1, move away and back, no dialog | FW1b |
| RD-5 | "Tour & application process" card says "No process recorded yet." while a tour process is recorded (tour fields moved to Requirements). | LOW | ACCEPT (copy) - the empty state reads `No application process recorded yet.`; the title stays (spec D10 names the card) - retitling is listed for Cameron | FW1b |
| RD-6 | Circular import requirements.ts <-> listingFormat.ts. | LOW | ACCEPT - requirements.ts stops importing listingFormat (the RD-2 formatter lives in requirements.ts or a leaf module); listingFormat keeps importing WASHER_DRYER_LABELS (AR39) | FW1b |
| RD-7 | The Apply result's role="status" block is mounted already filled (may not be announced). | LOW (PLAUSIBLE) | ACCEPT (cheap a11y) - an always-mounted, initially empty status container on the landlord Requirements card, filled on done | FW1b |
| RD-8 | "Clears" text contrast 4.28:1 < 4.5:1 at 13px. | LOW | ACCEPT - the `.clears` rule uses `--c-evt-amber-text` (7.1:1); the shared `--c-warning` token is not changed | FW1b |
| RD-9 | A company-only / nameless landlord reads "Unknown contact has no requirements recorded yet." | LOW | ACCEPT - one landlord display-name rule (the name the landlord page itself shows; company / primary phone fallbacks) shared by the property card and the New form's note, loading and failure lines | FW1b |
| RD-10 | An Apply run keeps posting its remaining batches after the dialog unmounts. | INFO | ACCEPT as intended (Cancel is disabled while sending; leaving the page does not cancel staff's Update) - a code comment says so | FW1b |
| RD-11 | Create waits on an untimed landlord read. | INFO | NO ACTION - a stalled read is closed and reopened; the failure path exists | - |
| RD-12 | Stale doc on the dashboard `UnitActivityEvent.reason`. | INFO | ACCEPT - doc comment | FW1b |
| RD-13 | A deleted landlord's page still offers Apply (Add a property and Edit behave the same today). | INFO | NO ACTION - handback item for Cameron (with RA-10) | - |
| RD-14 / RC-9 | Gate 5 exit 1. | INFO | Settled by the baseline compare: 5 pre-existing react-hooks errors (BroadcastComposer.tsx x2, useComposerDraft.ts x1, FlyerPage.tsx x2), branch-attributed 0, removed 0 - named in the handback; no lint-backlog edit (Task 7.9 Step 8 skipped) | - |
| RC-1 | No DynamoDB Local test of the PATCH landlord change + requirement_sources REMOVE through updateIfRequirementsCurrent. | LOW | ACCEPT - add the integration case (the fence change of OR-29 needs real-repo cases anyway) | FW1a |
| RC-2..RC-8, RC-10 | Recorded rulings and deviations (AR19 / PR2-2 audit lists, OR-17, the tour card title, BLANK, OR-20, OR-26, OR-5's type). | INFO | NO ACTION (RC-4 folds into RD-5) | - |
| RC-11 | No flyer case for a studio inside three or more sizes. | INFO | ACCEPT - add the case (`[0, 2, 3]`) | FW1b |
| O-1 (orchestrator) | FlyerPage.test.tsx it.each titles print `reads "undefined"` (`$1800` read as an index). | INFO | ACCEPT - fix the titles | FW1b |

## Orchestrator rulings from this round

- OR-29 (RA-1) - DIVERGENCE from plan ruling AR11, recorded for Cameron's
  eye. AR11 accepted "two staff writing different keys of one multi-key item at
  once while the map stays the same" because "the item's next write
  reclassifies it". RA proved consequences AR11 did not weigh: the D1 deposit
  rule is defeated (both forms stored and published), and Apply's own-value
  protection (spec goal 3, D8) is bypassed silently. The fix keeps the spec's
  design and only completes its fence: `updateIfRequirementsCurrent` and
  `applyRequirements` (real repo AND the harness fake) ALSO condition every key
  of every requirement ITEM the patch writes on its value in the read
  (`#k = :read` when the read holds it, `attribute_not_exists(#k)` when not;
  the item of a key from the registry), so a write computed from a stale item
  fails its condition, and the existing retry (PATCH: re-read, recompute, at
  most 3 attempts, then 409 property_changed) or the Apply skip
  (`changed_during_apply`) takes over. No route or wire change, no new stored
  attribute. Regression tests: RA's three races at route level on the harness
  (RA-1a wrong source then Apply; RA-1b both deposit forms; RA-1c Apply over a
  racing edit) and at repo level on DynamoDB Local, each failing on 738a2b4e.
- OR-30 (RA-2): the contacts PATCH write rides the existing `expect` guards:
  when the body carries a Deposit `req_` key, guards on the stored
  `req_deposit_one_month` and `req_deposit` as read (ExpectClause gains a
  boolean value; null = absent; real repo and harness); when the body carries
  any `req_` key and no type change, a guard on the stored `type`. A lost guard
  answers the existing 409 `contact_changed` with the fresh contact.
  Regression tests: RA-2a and RA-2b.
- OR-31 (RD-1): the Apply dialog handles 409 `deposit_conflict` on ANY batch
  (first or later): it sends no more, re-reads, and shows
  `This landlord's deposit is set to both one month's rent and a fixed amount. Fix it with Edit requirements, then press Update again.`
  (new copy, ASCII; for Cameron's eye). formatItemValue('deposit') shows both
  when both are recorded (`One month's rent; $1,400`), so the landlord card
  and the dialog show what the server refuses. With OR-30 the state is
  reachable only by a direct data edit; this is the defense in depth.

## For the handback (Cameron's eye)

- OR-29 overrides AR11 (a planner ruling) on evidence; no product behavior
  changes outside a race.
- OR-31's new copy; RD-5's empty-state copy (the card keeps the title
  "Tour & application process" - retitle it "Application process"?).
- RD-13 / RA-10: a soft-deleted landlord's page still offers Apply to
  properties (and Add a property / Edit, as today).
- RD-3 filed, not fixed (spec defines the stop message).

# Round 2 (2026-10-21) - two FRESH re-reviewers on fix wave 1

Fix wave 1 = FW1a (app, 2aa30812, report build/FW1a-app.md) + FW1b (dashboard,
83ec4ee3, report build/FW1b-dashboard.md). Gates at 83ec4ee3 ('fw1'):
typecheck 0, npm test 0 (app 522 files 10891 passed + 1 skipped, dashboard 263 /
5290, e2e 22 / 508, fake-twilio 34 / 275, fake-twilio-web 13 / 111;
[dynamoAdmin] 0), smoke 0, e2e 0 (367 passed, 18.8m), lint 1 = the same 5
pre-existing errors (branch-attributed 0).

- R2A (server): `R2-app.md` - 0 blocker/high/medium, 1 low, 4 info. Every FW1a
  fix REAL (mutant-killed on the real repo and the harness).
- R2D (dashboard): `R2-dashboard.md` - 1 medium, 8 low, 4 info. Every FW1b fix
  REAL except three RD-4 resets left unpinned (R2D-9).

| # | Finding | Severity | Ruling | Fix unit |
|---|---|---|---|---|
| R2D-1 | Apply: a property staff UNCHECKED by hand comes back CHECKED after a failed / stopped / deposit_conflict Update (the re-read resets row choices), and "press Update again" then writes it. Challenges OR-17's "row choices reset". | MEDIUM | ACCEPT - OR-32 below | FW2 |
| R2D-2 | A Delete (and the creates) still in flight when staff move to another contact lands on the next contact's page (its error, or a navigation away). | LOW | FILE - the in-flight resolution class predates this branch and spans flows the feature does not own; new issue `contact-detail-inflight-actions-cross-contact` | orchestrator |
| R2D-3 | A later batch answering 409 deposit_conflict replaces D8's stop sentence (the count already written is lost). | LOW | ACCEPT - on a LATER batch show D8's stop sentence AND the deposit sentence (OR-31 added a sentence; it never removed the spec'd one) | FW2 |
| R2D-4 / C4 | The RD-9 name rule disagrees with the New form's own landlord picker (company-only landlord: the picker shows the phone, the note names the company) and with the contact page header. | LOW | ACCEPT - OR-33 below | FW2 |
| R2D-5 | The Application fee box disables itself mid-typing whenever the partial text reads 0 ("0.50", or deleting the 4 of "40"): "No application fee" is DERIVED from the amount text. | LOW | ACCEPT - "No application fee" becomes its own form flag, set only by the checkbox (initially checked when the stored fee is 0); the amount is disabled only by the checkbox; checked records 0, unchecked records the typed amount (blank = none) - D10 unchanged | FW2 |
| R2D-6 | The New form's D7 loading / failure lines are live regions inserted already filled (the RD-7 pattern). | LOW | ACCEPT - one always-mounted status region for the section's lines (the failure may use role="alert") | FW2 |
| R2D-7 | Try again after a failed D7 read silently replaces what staff typed into the Requirements section. | LOW | ACCEPT - on the retry path a successful read fills only the fields staff left blank (D7 replaces typed values only for a DIFFERENT landlord pick); the snapshot is still the landlord's values | FW2 |
| R2D-8 | Public flyer "Fits a 8-bedroom voucher" / "a 11-" / "a 8- or 9-". | LOW | ACCEPT (grammar; plan 1.1's examples never meet 8 or 11) - "an" when the phrase starts with 8 or 11; cases added; listed for Cameron's eye | FW2 |
| R2D-9 | Three of the nine RD-4 resets (Start placement, Schedule a tour, the tour property override) are unpinned; the override guards a real cross-tenant prefill. | LOW | ACCEPT - tests only | FW2 |
| R2D-10 | Sub-cent money shows a difference nobody can see. | INFO | NO ACTION (sub-cent amounts are not a real input) | - |
| R2D-11 | The edit forms' "Reload ... and try again" cannot help a record that already holds both deposit forms. | INFO | NO ACTION - reachable only by a direct data edit since OR-30; the remedy (untick One month's rent) works | - |
| R2D-12 | Possible tag overflow at ~320px on the property Requirements card. | INFO (PLAUSIBLE) | DEFER to live self-QA (measure at 320 / 360 / 768 / 1280); fix if confirmed | self-QA |
| R2D-13 | The deposit notice says "then press Update again" but the fix is behind the dialog. | INFO | ACCEPT - copy revised (amends OR-31): `This landlord's deposit is set to both one month's rent and a fixed amount. Close this, fix it with Edit requirements, then open Apply to properties again.` | FW2 |
| R2A-1 | A plain re-type away from landlord keeps the contact's req_ keys, and the gate refuses the null that would clear them. | LOW | NO ACTION - the D2-bound residue already recorded (worklist OR-10, R2-F6): spec D2 makes every req_ key a 400 on a non-landlord; the keys are invisible off the landlord page and return with a re-type to landlord. Listed for Cameron (options in R2-app.md) | - |
| R2A-2 | OR-30's guards also refuse a Deposit save that could not conflict, under a race (409 contact_changed). | INFO | NO ACTION - race-only, a safe refusal, the form keeps the draft | - |
| R2A-3 | A money value past 2^53 validates, then the write 500s. | INFO | NO ACTION - the pre-existing unbounded-number class; noted in the handback | - |
| R2A-4 | An Apply whose `expected` carries ~99k chars of requirement text exceeds the 100kb body limit. | INFO | NO ACTION - free text has no length cap anywhere today; noted | - |
| R2A-5 | The spec (D5 / D8) and AR11 still describe the fence as landlordId + map only. | INFO | Handback note (OR-29 is stricter than the spec's text, never looser) | - |

## Orchestrator rulings from round 2

- OR-32 (R2D-1, amends OR-17): the preserving re-reads (after a mid-run stop, a
  first-request non-409 failure, and any 409 deposit_conflict) carry the hand
  UNCHECKS too: a row staff unchecked stays unchecked when it still exists and
  is not "Already matches"; hand CHECKS are still dropped (staff confirm a check
  again - the safe direction). So no re-read ever writes more than staff chose,
  rows and items alike. A first-request 409 requirements_changed keeps today's
  full reset (the spec's "Review the updated list"). Pin: the R2D-1 scenario
  (the unchecked row stays unchecked; the button reads the smaller count) after
  a failure and after a deposit_conflict.
- OR-33 (R2D-4 / C4, amends the RD-9 ruling): plan 1.1 defines `<L>` as "the
  landlord contact's display name as the page already shows it". The one rule
  is therefore exactly the contact page header's name (first + last, else the
  default phone - primary of phones[] before the legacy phone - else
  "Unknown contact"), with NO company step, so the card, the New form's note /
  loading / failure lines, its picker and the landlord page agree. RD-9's real
  defect ("Unknown contact" while phones[] holds a number) stays fixed. A
  company-first name across the dashboard is a separate product change
  (handback, Cameron's eye).
