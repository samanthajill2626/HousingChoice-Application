# R4 code review - feat/unknown-inactive (round 4, scoped to fix wave 3, fresh reviewer)

- Reviewer: round-4 scoped code reviewer, fresh (wrote no earlier round or fix
  wave). Read the code-review folder (R3-review finding 1, R3-adjudications,
  FW3-report; R2-adjudications and the FW1/FW2 residual lists, for what is
  already recorded), the FW3 diff (`.superpowers/review/fw3-diff.md`,
  d71b776f..798de475) and the live tree. Did not read docs/superpowers/specs,
  plans, build-research or slices. Authority: the live tree at HEAD 798de475
  (merge base 916258ae).
- Battery-4 at 798de475 (read before any run; ALL.done 2026-10-23 20:10:57):
  typecheck 0; npm test 0 (app 527 files / 11174 passed + 1 skipped,
  dashboard 266 / 5492, e2e workspace 22 / 508, 34 / 275, 13 / 111; no
  `[dynamoAdmin]` line; aws-names.txt empty); smoke 0 (1733 specifiers / 301
  files); e2e 0 (372 passed, 15.8m).
- Empirical work, all after ALL.done: 12 module-swap runs (2 baselines, 4
  reverts, 6 mutant runs; method under the verification table) and one
  throwaway probe file, `dashboard/src/routes/contact/zz-review-r4-reopen-race.test.tsx`
  (probes A-D, then A-E on a second run), deleted. One test FILE per vitest invocation; no
  e2e, no root `npm test`. No tracked file was edited; `git status` was clean
  at the end apart from this report.

Counts: CRITICAL 0, HIGH 0, MEDIUM 0, LOW 0, INFO 3.

---

## Findings

### 1. INFO - NEW (a window in the FW3-1 guard; the FW3-written claims overstate it) - CONFIRMED (probe A)

The page's re-read protects a reopen only once it has ANSWERED. A form
reopened while that consistent GET is still in flight is built from the
stale contact with Save on, stays stale when the answer lands (the form never
re-bases), and a redone type-changing draft re-sends `{ type }` over the
colleague's re-type - R3-1's outcome.

Where:
- `dashboard/src/routes/contact/ContactDetail.tsx:943-949` - the re-read is
  fire-and-forget; nothing on the page remembers "a 409 said this contact is
  stale" until the read lands. `:1373-1387` - the form mounts from the page's
  current `contact` whenever editing opens (no key, no stale flag).
- `dashboard/src/routes/contact/ContactEditForm.tsx:183`
  (`const [base] = useState(contact)`), `:216` (`statusType` from `base`),
  `:344` / `:643` (`retypedUnderForm` is per mount, false on every new
  opening).
- The claims, all FW3-written: `ContactEditForm.tsx:119-124` ("so the form
  opened next is built from the stored contact ... That read is best-effort;
  when it fails, the copy's reload is the way to a fresh read"), `:339-343`;
  `ContactDetail.tsx:937-940` ("the pill and the next edit form offer the new
  type's statuses even when no contact.updated reaches the page"),
  `:1381-1383` ("so a reopened form is built from the stored contact even
  with the event stream down"); `ContactEditForm.test.tsx:1947-1949`.
  FW3-report residual 1 records the read FAILING; the read being SLOW is not
  recorded.

Probe A (ContactDetail-level, that test file's own mocks; passed = shown):
1. A's page holds u9 = (unknown, inactive). Draft: Change type -> Tenant,
   Searching, Save. The PATCH resolves; the status write answers 409
   contact_type_changed; the page's re-read `["u9",undefined,{"consistent":true}]`
   is issued and held.
2. Cancel, then More actions > Edit contact details, before it answers: the
   Status options are `["needs_review","inactive"]` (the unknown's), value
   `inactive`, Save enabled.
3. The re-read answers (landlord, interested): the header pill reads
   "Contact status: Interested", but the open form still offers
   `["needs_review","inactive"]` with Save enabled.
4. A redoes the draft on that form: second PATCH `["u9",{"type":"tenant"}]`,
   second status write `{"toStatus":"searching","source":"manual","expectedType":"tenant","porting":false}`.
   Server-side that PATCH has no type fence (FW1 residual 1), so B's
   landlord is silently undone.

Control (probe B, passed): the same reopen AFTER the read answered offers
`statusOptionsFor('landlord')`.

Consequence for staff: rarer than R3-1 - its two conditions (a re-type inside
the PATCH-to-status-write window, and a page that missed the event) plus a
consistent GET slower than Cancel and two clicks. But that slowness is
correlated with what drops the event stream in the first place (a poor
connection), and when hit the outcome is R3-1's silent undo.

Fix (planner's pick):
- (a) Text only: qualify the five claims - "once that read has answered; a
  form opened before it answers, or after it fails, is built from the old
  contact, and the copy's reload is the safe way".
- (b) Code, which also closes FW3's recorded failure residual: keep the 409's
  signal on the PAGE until a re-read succeeds - e.g. a pending flag in
  ContactDetail, set by `rereadRetypedContact`, cleared in its `.then`, reset
  with the other per-contact state (`:331-378`) and bound to the contactId as
  `setContact` is - and pass it to the form so an opening while it is set
  starts with Save off and the copy (seeding `retypedUnderForm` and
  `error`). Pin: probe A's reopen-before-the-answer -> Save disabled.

### 2. INFO - RECORDED residual (FW3-report residual 2), CONFIRMED, with an ordering the record does not name - CONFIRMED (probe D)

The shared helper's read is outside useContact's latest-wins sequence
(`dashboard/src/routes/contact/useContact.ts:74-87`). FW3-report calls the
exposure narrow because "both reads [are] consistent, both after the
re-type". On the FORM path that premise does not hold: the form's own field
PATCH emits contact.updated, so with the stream up an in-sequence re-read of
A's OWN write is in flight when the status write's 409 arrives - and it can
read BEFORE B's re-type, since B lands inside exactly that window. If B's
event is then missed and that older read answers after the helper's, it wins.

Probe D (passed = shown): the PATCH resolves; ONE contact.updated for u9 is
delivered (useContact's read R1 issued, held); the status write answers 409
(the helper's read R3 issued, held); B's event never arrives. Both reads are
`["u9",undefined,{"consistent":true}]`. R3 answers (landlord, interested) ->
pill "Interested"; R1 then answers A's (tenant, onboarding) -> pill
"Onboarding", and stays.

Consequence for staff: display-only, and no worse than before FW3 (without
the helper the page shows the same R1 answer) - FW3 just does not fix this
ordering. A redo from that page with no type change sends
`expectedType: 'tenant'` -> another 409 (safe); only a redo that changes the
type again could write over B. Fix (cheap, both 409s): expose useContact's
sequenced re-read (e.g. `refresh()` = `refetchInPlace(contactId)`) and have
`rereadRetypedContact` call it, so the 409's read takes the next sequence
number: R1's late answer is dropped and a later event's read supersedes it.
The header and form tests' `toHaveBeenLastCalledWith('u9', undefined, { consistent: true })`
hold as written.

### 3. INFO - NEW (test intent, for the handback) - CONFIRMED (by reading)

`dashboard/src/routes/contact/ContactEditForm.test.tsx:2051` ("the field
PATCH answers 409 contact_changed: onStale is not called") pins R3-2's
RECORDED behavior - the contacts PATCH's own lost-guard 409 leaves the page
on the old contact - in the same breath as the real rule. It is the right pin
for what ships, but it is the row that must flip if the planner rules R3-2 a
fix (the same Save-off and page refresh on `contact_changed`, whose body
already carries a consistent current contact: `app/src/routes/contacts.ts:2010-2019`
answers `409 { error, contact: current }`). Name it beside R3-2 in the
handback so the row is not read as a product decision. No code change.

---

## FW3 verification

| Item | Verdict | Revert / mutant proof (failed / passed (total)) |
|---|---|---|
| FW3-1, the page's re-read (`ContactDetail.test.tsx:600-666`) | REAL | d71b776f's ContactDetail.tsx AND ContactEditForm.tsx swapped in: 1 / 154 (155) - exactly that case, `:641` `AssertionError: expected 1 to be greater than 1` (FW3-report's RED reproduced to the line). ContactDetail.tsx reverted alone: the same 1 at `:641`. ContactEditForm.tsx reverted alone: the same 1 at `:641`. Mutants of the helper: an eventually consistent read -> 2 / 153, the header case `:595` and the form case `:642` (`toHaveBeenLastCalledWith`); a read whose answer is never applied -> 2 / 153, `:597` (no "Onboarding" pill) and `:645` (no "Interested" pill). Baseline (exact HEAD copies, same config) 155 / 155. |
| FW3-1, the form's callback (`ContactEditForm.test.tsx:2033-2074`) | REAL | d71b776f's form: 1 / 118 (119) - the 409 row, `:2072` `expected "spy" to be called 1 times, but got 0 times`; the three "not called" rows pass on unchanged code (pins, as FW3-report says). Mutants: onStale on EVERY failed save -> exactly the three "not called" rows fail (`expected "spy" to be called +0 times, but got 1 times`); onStale twice -> the 409 row (`got 2 times`); onStale ALSO on success -> survives both files (119 / 119, 155 / 155) - harmless by construction (that read follows both writes), not worth a pin. Baseline 119 / 119. |
| FW3-1, header 409 unchanged | REAL (by reading; the header case passes in every run) | See charge walk 1. |
| FW3-1 comments | True, except finding 1's window | `ContactEditForm.tsx:109-124`, `:132-135`, `:339-343`, `:613-618`; `ContactDetail.tsx:935-942`, `:983-988`, `:1381-1383`; `ContactEditForm.test.tsx:1946-1949`. |
| FW3-2 (docs, today.ts comment) | REAL (by reading) | Every clause checked; see surfaces swept clean. |

Method: each module copy is `git show <rev>:<path>` in the reviewer
scratchpad - HEAD copies from 798de475 (byte-identical to the tree, `cmp`),
reverts from d71b776f, which is exactly FW3-1 reverted (in d71b776f..798de475
the two modules change only in 0345be47); each mutant is the HEAD copy with
one anchor replaced exactly once. A throwaway config, also in the scratchpad,
spreads `dashboard/vite.config.ts` and prepends a `resolveId` pre-plugin that
redirects any import RESOLVING to ContactDetail.tsx / ContactEditForm.tsx to
the chosen copy and resolves the copy's own imports as if from the original
path, so every `vi.mock` in the test still applies. Every run logged its
redirects (three for ContactDetail.test.tsx: the test's two imports and the
detail copy's import of the form; one for ContactEditForm.test.tsx), and both
baselines through the same config were green.

## Charge walk - FW3-1

1. **Header 409, byte-for-byte.** Before, the arm ran
   `void getContact(contact.contactId, undefined, { consistent: true }).then((fresh) => setContact(fresh)).catch(...)`
   inline; now it calls `rereadRetypedContact()` (`ContactDetail.tsx:990`),
   which is that same expression, defined in the SAME render as onChangeStatus
   (`:943` vs `:957`), so it closes over the same `contact` and `setContact`,
   runs synchronously at the same point and is equally fire-and-forget. Only
   the catch comment changed. Same reads, same order, same state writes.
2. **Placement.** After the loading/error early returns (`:627-643`), where
   `contact` is non-null - right for a plain function (not a hook, so no
   hook-order hazard; typecheck and eslint 0). Re-created each render; the
   form only calls it inside onSubmit's catch (the form has no effect or memo
   at all), so identity churn costs nothing.
3. **Stale closure, navigation, setContact's binding.** onSubmit's catch calls
   the `onStale` of the render in which Save was clicked: that render's
   helper, whose `contact.contactId` is the route id of that render (the form
   unmounts on a contactId change, `:369`, and on Modal close) and whose
   `setContact` is bound to that id (`useContact.ts:51-53`). A late answer
   after navigating to B is a no-op once B is committed; while B is still
   loading it writes a `forId: A` state that useContact hides behind
   "loading" (`useContact.ts:94-96`) until B's load overwrites it. Probe E
   (passed): navigate to z99 mid-save - the form closes; A's 409 still
   re-reads u9 consistently; its answer while z99 loads leaves no trace; z99
   renders with no "Interested" pill and no copy. Probe C (passed): a form
   closed by Escape mid-save (the Modal's document keydown,
   `Modal.tsx:89-102`, is not gated on `saving`) still heals the page on its
   409 - the closure outlives the mount, which is the behavior wanted.
4. **useContact's sequence.** Finding 2.
5. **onStale exactly on that 409.** The only emitter of 409
   contact_type_changed is the transition route
   (`app/src/routes/statusTransition.ts:313`, `:386`); the contacts PATCH
   cannot produce it, so the arm (`ContactEditForm.tsx:613-621`) fires only
   for the status write. The catch runs once per save, and a second save from
   that opening is impossible: canSave (`:643`) and the submit guard (`:540`)
   both read `retypedUnderForm`, and `setSaving(true)` (`:570`) runs before
   the first await, so a double click is closed too. `getContact` is `async`
   (`dashboard/src/api/endpoints.ts:1480`), so onStale cannot throw
   synchronously and skip `setSaving(false)` (`:629`). Pinned by the it.each
   rows and the mutants above.
6. **Save-off unchanged.** `setError(CONTACT_TYPE_CHANGED_SAVE_COPY)` and
   `setRetypedUnderForm(true)` still precede the new `onStale?.()`; the copy
   text is unchanged; the FW2-2 cases pass in every run. When the page's
   re-read lands with the form still open, the copy and the disabled Save
   stay (pinned, `ContactDetail.test.tsx:648-649`): the form reads only
   `contact.contactId` and the then-unreachable `let updated = contact` from
   the live prop.

## Surfaces swept clean

- STATUS-MODEL.md:282-294 and GLOSSARY.md:717-730 (FW3-2), every clause:
  the skip needs `unknown_1to1` (`app/src/routes/today.ts:773-781`); a team
  member's and an unknown contact's threads are minted `unknown_1to1`
  (`conversationTypeFor`'s default, `app/src/lib/voiceMasking.ts:28-38`,
  `app/src/routes/webhooks/twilio.ts:221`); the PATCH flips only
  `unknown_1to1` threads and has no unknown / team_member arm
  (`app/src/routes/contacts.ts:541-547`, `:2152`); the importer writes `#type`
  onto an existing contact unless `type_source` is manual
  (`app/src/lib/import/apply.ts:1128`, `:1165-1166`; VALID_TYPES `:264-270`
  includes both) and mints threads `if_not_exists(#type)` as `unknown_1to1`
  (`:1284-1290`, `:460`); no dashboard UI re-types to unknown or team_member
  (KindPicker segments `:39-47`; no team_member type write under
  routes/contact). Needs you now has no other source an Inactive unknown
  contact's 1:1 text can reach (placements, relay opted-out members, the
  unread collect loop, the needs_review triage pass).
- GLOSSARY.md:702 (the flyer parenthetical): branch-authored (absent at
  916258ae:699-700), true.
- `app/src/routes/today.ts:761-770`: comment only, the skip untouched; the
  importer clause and the issue slug are exact, and
  `docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md`
  exists, open, saying the same. Its Cameron quote ("It just shows in the
  inbox") is the product intent; the rule text after it is precise.
- The adjudication's invariant ("EVERY 409 path the branch added on the
  contact page"): only two dashboard callers send `expectedType` - the header
  pill and the edit form - and both now re-read on that 409.
- ContactEditForm has one consumer (ContactDetail); `onStale` is optional.
- FW3 test comments (`ContactDetail.test.tsx:600-605`, `:611-612`;
  `ContactEditForm.test.tsx:2033-2036`): true.
- FW3-report's claims: both REDs reproduce to the line and message; +5 tests
  (battery-4 dashboard 5492 = battery-3 5487 + 5); "no new effect" (the form
  has none; ContactDetail added none); "Tree vs adjudication" - agreed.
- Pre-existing, not FW3's: after the form's 409 the timeline is not
  refetched with the stream down - as on the header's 409 and main's
  `onSaved` (916258ae ContactDetail.tsx:1345-1348).
- ASCII: 0 non-ASCII added lines in d71b776f..798de475.
