# Property requirements - planner adversarial code review, round 2 (FW5 re-review)

Summary: 0 BLOCKING, 0 HIGH, 0 MEDIUM, 2 LOW, 3 INFO (5 findings); 1 ruling contested (PA-5,
with new evidence); PA-2 nudge, PA-6, PA-8, PA-9, PA-10 not contested.

Scope: `git diff 4a976cec..c1cc7e80` (60e64d66 PR-1, 5627a9d3 PR-2, 3c400035 PR-3, ca8f64d4
PR-4, 5360615f PR-5, dd6f5a8a issue file), read against the whole repo with the round-1
charter. Read under docs/superpowers/: only code-review/planner-adjudications.md and
build/FW5-planner.md, as permitted. No suite was run.

## What FW5 closes (verified, no finding)

- PR-1 closes PA-1 for every own value on every path I could build:
  - a colleague's own-to-own change after the dialog read: skipped
    (app/src/lib/requirements.ts:466-472);
  - a value that becomes own after the read: not in ownItems, skipped as before;
  - a copied or blank value a colleague edits: it either now equals the landlord (not changing)
    or classifies set_here (own, not in ownItems), so it is skipped.
  The other paths:
  - Later batches send `seen` from the click-time read. A property changed while earlier
    batches ran is skipped, which is correct.
  - A re-read inside the open dialog replaces `ready`, so the next Update sends `seen` from the
    re-read (ApplyRequirementsDialog.tsx:229, :243).
  - A legacy boolean `pets` interprets identically on both sides (the dashboard mirror and the
    app's unitItemValue). For example `pets: true` is sent and compared as
    { no_pets: null, pets: 'Allowed', pet_fee: null }.
  - Text compares trimmed on both sides; money and the tour-type set are identical.
  - planUnitApply is pure and the fence is unchanged, so the harness fake versus the real repo
    is unaffected.
  - A stale dialog read now fails SAFE: a mismatch with `seen` skips instead of writing (see
    PA2-3).
- The new `seen` field is validated well:
  - keys must be exactly the de-duplicated ownItems, so a JSON `__proto__` key is an own key
    outside ownItems and gets a 400;
  - every key of each item must be present, and values are string, number, boolean or null;
  - the parser is shared with `expected` (contactRequirementsApply.ts:79-93, :143-157).
- The new `?consistent=1` parameter:
  - only the exact string '1' selects the consistent read; a repeated parameter (an array) or
    any other value falls back to the old read (contacts.ts:1262-1266);
  - no other caller of getContact changed behavior, because the new options argument is
    optional and third.
- PR-4: FlyerPage is the only public renderer of the two amounts. The staff pages use
  formatRequirementMoney, and no SMS merge field carries them.
- PR-5: the re-read is best-effort and only names the reason. It can never write.

---

## PA2-1 - LOW - PLAUSIBLE - PR-3 made the LOCKED New property read consistent; the PICKER path still fills (and snapshots) from an eventually consistent GSI list

Evidence: dashboard/src/routes/listing/UnitCreateForm.tsx:257-265 (`onPickLandlord` fills the
section and `requirements_snapshot` from `landlords.find(...)`). `landlords` comes from
`getAllContacts({ type: 'landlord' })` at mount (:210), a byTypeStatus GSI Query, and a GSI
cannot be read consistently. PR-3 changed only the locked read (:231).

Failure scenario: this is PA-3's case (b) on the other entry point. Staff save landlord L's
requirements, then press New property on the Properties list and pick L inside the GSI
replication window. The form fills in L's OLD terms. The server classifies them `copied` against
that snapshot (requirements.ts nextRequirementSources), so the new property is created with
superseded terms that show on its flyer and carry "Landlord updated" tags at once. The ruling
accepted this failure for the locked path; the picker path is the same harm.

Who: staff creating a property from the Properties list right after a landlord edit.

Suggested fix: on a pick, read the picked landlord with
`getContact(id, signal, { consistent: true })` and fill and snapshot from that read, reusing
the locked path's loading / failed / Try again states. Or keep the list fill for speed and
replace it with the consistent read when it lands, but only while staff have typed nothing
(fillBlankRequirementItems already encodes that rule).

PROPOSED TEST (dashboard/src/routes/listing/UnitCreateForm.test.tsx):
- getAllContacts returns ROSA with `req_credit_requirements: '600+'`;
- getContact (consistent) returns ROSA with `req_credit_requirements: '650+'`;
- pick ROSA in the picker;
- expect getContact called with (ROSA's id, expect.any(AbortSignal), { consistent: true });
- expect the Credit score field to read '650+'.

On this branch it fails: getContact is never called and the field reads '600+'.

---

## PA2-2 - LOW - PLAUSIBLE - The Apply body re-sends requirement text (`expected` once, now `seen` per checked own row) under express's 100 KB limit, and the batches are 100 rows by COUNT: a 413 is a dead end

Evidence:
- app/src/app.ts:140: `express.json` with its default 100 KB limit.
- requirements.ts:251-255: requirement text is uncapped (PA-5, deferred).
- applyRequirementsModel.ts `applyRequestBody`:
  - `expected` carries every key of every checked item, landlord text included;
  - since PR-1, each row adds `seen` with the full text of its own items;
  - `chunk(checkedRows, 100)` splits by row count only.
- ApplyRequirementsDialog.tsx:262-266: a non-409 failure of the first request shows
  APPLY_FAILED_NOTICE ("Couldn't update the properties. Review the list and press Update
  again."), and pressing Update again sends the same body.

Failure scenario:
- (a) Pre-existing since round 1, and missed by me then. A landlord saves Qualifications and
  Income requirements of about 55 KB each, in two PATCHes that each fit. Both items are
  non-blank, so they start checked. Every Apply body carries both in `expected`, exceeds
  100 KB and gets a 413. Staff see the generic notice and get the same 413 on every retry.
  Nothing says the text is the cause.
- (b) New with PR-1. A checked row whose own Qualifications is large adds that text to `seen`.
  A batch of hand-checked own rows can cross 100 KB even when the landlord's text is short,
  and that batch fails the same way every time.

Both need unusually long text, which is why this is LOW. The dead end and the misleading copy
are what make it worth recording.

Who: staff applying requirements for a landlord, or properties, with long free text.

Suggested fix: any of the following.
- Cap requirement text, sized so that the eight items plus one checked row of `seen` fit well
  under the limit. This is PA-5's fix, with this as a second reason.
- Batch by serialized size as well as by count.
- Give the Apply route its own `express.json({ limit })`, applied before the global parser
  sees the body.
- Map a 413 to a sentence that names the cause.

PROPOSED TEST (app/test/requirementsApplyApi.test.ts):
- seed the landlord with `req_qualifications: 'q'.repeat(55_000)` and
  `req_income_requirements: 'i'.repeat(55_000)`;
- POST an Apply listing both items with a matching `expected` for one plain unit.

On this branch the expected result is status 413 and nothing written.

---

## PA2-3 - INFO - CONFIRMED - The units half of the Apply dialog's re-read is still eventually consistent; after PR-1 that surfaces as a spurious "changed since you opened this"

Evidence: ApplyRequirementsDialog.tsx:163-168. The landlord read is now consistent (PR-3), but
`getAllUnits({ landlordId })` is the byLandlord GSI, which cannot be read consistently.

Effect: staff edit property P's Pets ("Cats OK" to "Dogs OK", set_here), go to the landlord
page and open Apply within the GSI lag.
- The dialog shows "Cats OK" as P's own value. Staff check P and press Update.
- The server's consistent read finds "Dogs OK", which differs from `seen`, so P is skipped:
  "changed since you opened this - review it again". Nobody changed P after the dialog
  opened; staff changed it just before.
- Before PR-1 the same stale read silently wrote over "Dogs OK". So PR-1 also fixed a
  self-inflicted variant of PA-1, and what remains is a confusing but safe skip.

No code needed. Noted so the sentence is not diagnosed as a bug.

---

## PA2-4 - INFO - CONFIRMED - PR-5 reports two benign races as "changed since you opened this"

Evidence: contactRequirementsApply.ts LOST_WRITE_REASONS = { landlord_changed, deleted,
not_found }. Any other re-read plan becomes changed_during_apply. Two benign cases fall into it:
- (a) A colleague's identical Apply landed first. The re-read plan is `already_matches`, but the
  report says "changed since you opened this - review it again".
- (b) The lost condition was requirement_sources changing because a colleague edited a NON-listed
  item. The re-read plan is a `write`, so a retry would be safe (it is re-planned with the same
  `seen`), but the unit is skipped. The PATCH path retries three times in the same situation
  (units.ts writeFencedPatch).

Suggested fix (cheap):
- add `already_matches` to LOST_WRITE_REASONS;
- optionally, when the re-read plan is a `write`, attempt that write once more before reporting
  changed_during_apply.

---

## PA2-5 - INFO - CONFIRMED - The flyer's rent line, one row above the fixed amounts, still prints raw cents

Evidence: dashboard/src/routes/public/FlyerPage.tsx:46-52 (`$${min}`, `From $${min}`). Rent is
the 'number' kind (unitFields.ts), which accepts cents. After PR-4 the same flyer can read
"$1250.5/mo" above "Deposit: $1250.40". The rent line predates the branch and is not touched by
it. A one-line reuse of `flyerMoney` would make the page consistent. Cameron's eye.

---

## Contested rulings

### PA-5 (DEFER) - contested, with new evidence (see PA2-2)

The deferral reasoned that uncapped text is a pre-existing class whose harm is the 400 KB item
limit. There is a second harm the ruling and the issue file
(docs/issues/requirement-text-no-length-cap.md) do not name. Apply re-sends requirement text in
its body: `expected` since the branch began, and per-row `seen` since PR-1. That makes the
100 KB body limit a reachable dead end for a landlord or property with long text, at a far
smaller total than 400 KB.

Request:
- at minimum, add this path to the issue file, so a future cap is sized against the Apply body
  and not only against the item limit;
- preferably, take the batching-by-size or route-limit fix from PA2-2, because PR-1 made the
  body grow with the number of checked own rows.

The PROPOSED TEST in PA2-2 proves the 413.

### Not contested (no new evidence)

- PA-2 nudge: the new legend says how a value reaches a property.
- PA-6: the comment at app/src/routes/broadcasts.ts:1038-1041 is about the housing-authority
  re-check, not voucher sizes, so it is not falsified.
- PA-8, PA-9, PA-10: the rulings cite spec decisions I have no evidence against.
