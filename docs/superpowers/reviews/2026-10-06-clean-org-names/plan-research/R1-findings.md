# R1 findings - contact and unit writers/readers, and the missed-call intake rule

Plan research, area R1 (contacts PATCH/POST/restore, units POST/PATCH/restore,
the contacts and units repos, `unitFields.ts`, `similarUnits.ts`, the
missed-call intake rule). Spec:
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
(revision 5). Code read at `feat/clean-org-names` HEAD `93c3c65b`. Byte-exact
quotes for every anchor below are in the gitignored reference
`.superpowers/sdd/plan-research/R1-contacts-units-reference.md`.

Six findings: one rule whose scope is wider than the code it protects (F1),
three low-severity misses (F2 audit key, F3 an unnamed reader, F4 D15
mirrors), and two citation-precision notes (F5, F6). None changes the design
direction; F1 needs a one-line spec ruling before the plan pins tests.

---

## F1 (low, rule scope) - D5's `jurisdiction` pass-through is wider than the synthesis it protects

**Spec says.** D5: "`accepted_authorities` is checked per member: members the
unit already holds (exact text), or equal to the unit's legacy
`jurisdiction`, pass unchanged; only new members must resolve." I1: every
accepted-authority member WRITTEN after the deploy is on the list.

**Code does.** `authoritiesOf` (`app/src/lib/unitFields.ts:283-291`) uses the
legacy `jurisdiction` ONLY when `accepted_authorities` is absent (not an
array); a stored list wins, including a stored `[]` ("cleared", comment at
`unitFields.ts:273-278`). The dashboard edit form prefills from that synthesis
(`dashboard/src/routes/listing/ListingEditForm.tsx:38`, sends the list only
when changed, `:156-166`) - which is the case the pass rule exists for. Stored
tombstone values are never removed (`unitFields.ts:113-123`), and section 8's
cleanup backfills `accepted_authorities` on jurisdiction-only units without
removing `jurisdiction`; D11 rewrites list members only.

**Why it matters.** Implemented literally, the rule also passes the old raw
`jurisdiction` text as a NEW member on units where it is not held at all:
a unit whose list was cleared to `[]`, and every legacy unit forever after
the cleanup or a rename. Example: jurisdiction `DCA`, list backfilled to
`['Georgia Department of Community Affairs']`; a PATCH adding `DCA` passes
unchanged and is stored as a second, off-list member (exact-text de-dup keeps
both). That contradicts I1 and puts the value back into "Not on the list".

**Suggested resolution.** Scope the pass to the synthesized case: a member
passes unchanged when it is in `authoritiesOf(storedUnit)` (equivalently:
equal to `jurisdiction` only while the stored `accepted_authorities` is
absent). Pin it with a route test: unit `{ accepted_authorities: [],
jurisdiction: 'Fulton' }` + PATCH `['Fulton']` -> 422.

---

## F2 (low) - D11's audit payload key `by` bypasses the codebase's `actor` convention

**Spec says.** D11: each record write appends `org_name_rewrite` `{field,
from, to, action, by}`.

**Code does.** The audit item builder hoists only `payload.actor` (a string)
into the top-level `actorId`, the byActor GSI key, and calls `actor` "the
established convention" (`app/src/repos/auditRepo.ts:80-100`, comment
`:83-90`). The property Activity projection reads that hoisted `actorId`
(`app/src/routes/units.ts:209`). Every human-path writer in this area passes
`actor: req.user?.userId` (`app/src/routes/contacts.ts:1090`, `:1867`,
`:2283`; `app/src/routes/units.ts:461`, `:1388`, `:1434`).

**Why it matters.** With `by`, every rename / merge / settle row is missing
from "all actions by actor X" and shows no actor on the property Activity tab.

**Suggested resolution.** Use `actor` for the admin's userId (the cleanup
script's `org_name_cleanup` rows simply omit it, as system actions do).

---

## F3 (low, missed reader) - the property Activity tab shows every machine rewrite with a bare label

**Spec says.** D11 and section 8 append `org_name_rewrite` /
`org_name_cleanup` to each rewritten record. Section 9's reader list does not
name the property Activity feed.

**Code does.** `GET /api/units/:unitId/activity` returns every `units#<id>`
audit row with no type allowlist (`app/src/routes/units.ts:1251-1265`),
projected by `toUnitActivityEvent` (`units.ts:191-221`, which keeps
`from` / `to`). The dashboard label switch has no case for these types and
falls back to `humanize(e.type)` (`dashboard/src/routes/listing/listingFormat.ts:189-220`,
`dashboard/src/routes/contact/format.ts:118-122`), rendering "Org name
rewrite" / "Org name cleanup" with no detail. The landlord timeline is NOT
affected (it allowlists unit audit types,
`app/src/routes/contactTimeline.ts:331-336`), and no route reads `contacts#`
audit rows (the only `audit.listByEntity` keys are `units#`, `placements#`,
`tours#`).

**Why it matters.** The cleanup apply alone writes one such row on every
property whose list it maps - potentially every legacy unit - each showing an
unexplained "Org name cleanup" entry.

**Suggested resolution.** Either add labels in `listingFormat.ts` (for
example "Housing authority renamed" with a `from -> to` sub-line, both fields
already projected) or record in the plan that the humanized fallback is
accepted; add the feed to section 9's reader list either way.

---

## F4 (low) - D15's mirrors: the named test does not pin the field list, and one mirror is unnamed

**Spec says.** D15: the operator hint "(Settings > Templates,
`TemplatesSection.tsx`, and its test) changes with it."

**Code does.**
- The test matches only "hold no details on" and "landlord, partner, or team
  member" (`dashboard/src/routes/settings/TemplatesSection.test.tsx:70-77`).
  Editing the hint's field list (`TemplatesSection.tsx:215-219`) cannot turn
  it red, so a TDD task has no failing test unless the plan ADDS an assertion
  (for example `/agency/i`).
- `docs/issues/missed-call-autotext-partial-intake.md:12-15` enumerates the
  four intake facts (firstName, lastName, voucherSize, housingAuthority) and
  `:43-44` says the hint "has to be updated in the same change"; adding agency
  leaves that issue body stale.
- Prose in the job describing the four-field rule:
  `app/src/jobs/missedCallAutoText.ts:16-19`, `:62-67`, `:96-111`; and the
  test comment `app/test/missedCallAutoText.test.ts:152-155`.

**Suggested resolution.** The D15 task: add `'agency'` to `INTAKE_FIELDS`
(`missedCallAutoText.ts:80`), extend the loop at
`missedCallAutoText.test.ts:221` and the blank-value case at `:231-236`
(`agency: ''` must still send), add the hint assertion, and update the issue
body and the comments above.

---

## F5 (info) - D1 cites `unitsRepo.ts` for a version read-and-bump it does not have

**Spec says.** D1: writes are read-and-bump on `version = :expected` (and
`version + 1`), "the read-and-bump pattern of `conversationsRepo.ts` and
`unitsRepo.ts`".

**Code does.** `unitsRepo.ts` has no version counter. Its optimistic writer
conditions on the stored values themselves - `landlordId` and the whole
`contacts` list - with three attempts (`app/src/repos/unitsRepo.ts:466-528`,
retry loop `:730-754`). The version-counter precedent is the relay roster
writer (`app/src/repos/conversationsRepo.ts:1183-1247`,
`participants_version`, condition "absent OR equal to the read value", SET to
read + 1).

**Why it matters.** Only that a planner should copy the conversationsRepo
shape for the `org-list` item and not look for a version field in unitsRepo.
The unitsRepo whole-list equality condition IS the right precedent for D11's
"conditional on the record still holding the text it read" on unit lists.

---

## F6 (info) - the tombstones are accepted on unit POST too, not only PATCH

**Spec says.** Section 5.2: the legacy `jurisdiction` / `accepted_programs`
tombstones "stay accepted and ignored on the unit PATCH".

**Code does.** `validateUnitBody` is shared by create and update and drops the
tombstoned keys in both modes (`app/src/lib/unitFields.ts:139-155`); the
create behavior is pinned by `app/test/unitsApi.test.ts:116-137`.

**Why it matters.** Only for D5 on POST: there is no stored unit, so a member
equal to a tombstoned `jurisdiction` in the same POST body gets no pass and
must resolve like any new member.
