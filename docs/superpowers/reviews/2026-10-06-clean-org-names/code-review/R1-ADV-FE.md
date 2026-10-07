# R1-ADV-FE - adversarial, plan-blind review: dashboard + e2e half

Reviewer: R1-ADV-FE. Branch `feat/clean-org-names` vs merge base `d839494a`.

Covered: every dashboard/ and e2e/ file in the diff package (68 files: the API
client and wire types, OrgPicker, NewOrgDialog, useOrgList, orgCopy, the tenant
form, both property forms, the blast composer and its draft hook, the AI
suggestion accept flow, the Settings tab - useOrgAdmin, OrgListSection,
OrgEntryDialogs, NotOnListSection - AI run log labels, property Activity,
settings tabs/route, the org e2e fixture, steps.ts and every changed spec, and
the perf route/mutation catalogs). Every client call was checked against its
server route (app/src/routes/organizations.ts, contacts.ts PATCH, units.ts,
broadcasts.ts, suggestions.ts) and services (orgNames, orgRecords, orgRewrite),
and every other reader/writer of housingAuthority / agency /
accepted_authorities / audience_filter.housing_authority in dashboard/ and e2e/
was swept.

Counts: CRITICAL 0 | HIGH 1 | MEDIUM 2 | LOW 5 | INFO 2.

All throwaway tests named below were run alone and then deleted by exact name.

---

## R1-ADV-FE-1 | HIGH | CONFIRMED

**Where:** dashboard/src/routes/orgs/OrgPicker.tsx:12-14, :312-316 (typed text
is local state only), :255-260 (Enter with nothing highlighted is not
consumed); hosts: dashboard/src/routes/contact/ContactEditForm.tsx:344-349 and
:385-388, dashboard/src/routes/listing/ListingEditForm.tsx:177,
dashboard/src/routes/listing/UnitCreateForm.tsx:198.

**Scenario:** the old tenant/property fields were free-text inputs: type the
authority, Save. With the picker, a staffer types the full name (or "DCA"),
SEES the matching option listed under the field, and clicks Save / Create (or
presses Enter). The typed text is never committed (only a pick or a chip
removal calls onChange), so the form saves every OTHER change, reports
success and closes - the authority is silently not saved. On the tenant form
an edit with no other change closes as "nothing changed". On New property the
property is created with no accepted_authorities, so it is missing from that
authority's Properties facet/available view and every flow that keys on it.
Enter: the Save button carries form="contact-edit-form", so it is the form's
default button and an Enter in the combobox with nothing highlighted
implicitly submits (HTML default-button rule; OrgPicker.test.tsx:137-151 pins
"otherwise the surrounding form submits"). The composer's no-commit rule (D7)
exists because the composer recreates its draft per filter change; the forms
inherited it without any guard. No unit or e2e test exercises "type, then
save" (the e2e helper pickOrgName waits for the chip precisely because typed
text is dropped).

**Evidence:**
- zz-review-R1-ADV-FE-1.test.tsx "Save with the exact list name typed (not
  picked)": typed "Atlanta Housing Authority" (its option rendered), changed
  voucher size, clicked Save -> onSaved called, PATCH sent `{"voucherSize":3}`;
  `expect(patch).not.toHaveProperty('housingAuthority')` passed.
- zz-review-R1-ADV-FE-5.test.tsx: New property, typed "DCA" (option "Georgia
  Department of Community Affairs (DCA)" rendered), Beds 2, Create ->
  onCreated called, POST /api/units body
  `{"landlordId":"contact-landlord-0001","beds":2}`; no accepted_authorities.

**Fix:** keep the composer's rule, but give the forms a commit-or-block step:
expose the picker's uncommitted text (e.g. `onPendingTextChange`, or an
imperative `commitPending()`); on submit, if the text resolves (normalizeOrgText)
to exactly one offered entry by name or unique spelling, commit that name;
otherwise block the save with an inline error under the picker ("Pick a name
from the list, add it, or clear the text"). Optionally auto-highlight the
first option so Enter picks instead of submitting.

---

## R1-ADV-FE-2 | MEDIUM | CONFIRMED

**Where:** dashboard/src/routes/orgs/OrgPicker.tsx:185-218 (the list is
dismissed only on scroll, resize or an outside mousedown - never on focus
leaving the input), :247-266 (Escape is handled only by the picker whose list
is shown); dashboard/src/routes/contact/Modal.tsx:96-101 (document Escape
closes the topmost modal).

**Scenario:** keyboard user in Edit contact types "AHA" in Housing authority
(list opens), does not pick, presses Tab. Focus moves to Agency, but the
portaled HA listbox stays painted directly below the HA input - i.e. over the
Agency field - and the HA combobox keeps aria-expanded=true. The natural way
to dismiss the stray popup is Escape; the Agency picker has no list shown, so
it does not consume the key, the Modal's document listener closes the whole
Edit contact dialog and every unsaved edit is discarded. Same shape in Edit
property / New property (Housing authorities -> Beds) and the Settle dialog's
Split (two pickers). The old datalist inputs closed their native popup on
blur, so the orphaned popup is new.

**Evidence:** zz-review-R1-ADV-FE-1.test.tsx "Tab away leaves the HA listbox
open...": after `user.type(ha, 'AHA')` + `user.tab()`: Agency combobox has
focus, `getByRole('listbox', { name: 'Housing authority suggestions' })` still
present, HA `aria-expanded="true"`; `user.keyboard('{Escape}')` ->
`onClose` called once (passed).

**Fix:** dismiss on focus leaving the field: an input onBlur that ignores a
relatedTarget inside the listbox (options already preventDefault on
mousedown, so clicks keep focus), or a document focusin listener alongside
the existing mousedown one.

---

## R1-ADV-FE-3 | MEDIUM | CONFIRMED (service-level composition; reachable from the dashboard)

**Where:** app/src/services/orgNames.ts:249 (`add` - no
refuseWhileRewriteRuns, unlike delete/kind at :336/:364 via :165);
app/src/services/orgRecords.ts:546 (`matches`: normalized from-texts, no list
check) and its header PRECONDITION (orgRecords.ts:35-39: "no from-text may
normalize equal to the exact NAME of an entry ... such a value would be
rewritten too"); dashboard callers of POST /api/organizations:
NewOrgDialog.tsx:136-147 (tenant form, both property forms, AI suggestion
"Yes, add it", Settings Add).

**Scenario (concrete interleaving):**
1. Admin: Settings > Not on the list > "Metro HA" (housingAuthority) > Clear ->
   202, lastRewrite running {action clear, fromTexts ["Metro HA"]}.
2. VA, meanwhile, in a tenant's Edit contact: types "Metro HA" -> "Add Metro HA
   as a new housing authority" -> /check: unknown, no nameProblem -> "Yes, add
   it" -> POST /api/organizations -> 201 (no lock check). Save -> PATCH
   housingAuthority "Metro HA" -> D5: exact list name -> stored.
3. The Clear pass reaches that tenant, reads "Metro HA", normalizes it into its
   from-set and REMOVEs it (its conditional write holds - the value is what it
   read).
Result: a list name a VA just saved is erased without any error, as is every
other record holding the brand-new name, and the list keeps an entry the pass
just emptied. With Use/Move/Split the tenant is instead rewritten to the
admin's target. The start-time precondition check (services/orgRewrite.ts)
cannot see an add made after the start.

**Evidence:** app/test/zz-review-R1-ADV-FE-6.test.ts (fakes only): seeded a
fresh-heartbeat running clear on ["Metro HA"]; `names.add({kind:
'housing_authority', name: 'Metro HA'})` resolved (no 409); `lastRewrite.status`
still 'running'; `checkScalar('housingAuthority','Metro HA')` ->
`{ok:true,value:'Metro HA'}`; then `records.rewrite(clear)` -> counts
`{"housingAuthority":1,...}` and the tenant came back
`{"contactId":"t-va","type":"tenant","status":"searching"}` (passed).

**Fix:** refuse `add` with 409 org_rewrite_running while a rewrite holds the
lock (at least when the new name normalizes equal to one of a value action's
fromTexts) - the dashboard already words that code; or have the pass skip a
value that is exactly a list name of the field's kind (re-reading the list
per page).

---

## R1-ADV-FE-4 | LOW | CONFIRMED

**Where:** dashboard/src/routes/orgs/orgCopy.ts:319-334 (`isRewriteStalled`,
`isRewriteLive`, `canRunAgain` default to the BROWSER clock);
dashboard/src/routes/settings/useOrgAdmin.ts:107;
dashboard/src/routes/settings/OrgListSection.tsx:192, :256-257.

**Scenario:** the heartbeat is a SERVER-written stamp, and the server's lock
(orgRewrite.ts refuseWhileHeld / orgNames.ts:136) judges it on the server
clock. The repo already has the rule for this (dashboard/src/api/serverClock.ts:
judge server stamps with serverNowMs()). On a browser running 15+ minutes
fast, a live rewrite is shown "An update stopped responding", polling never
starts, the admin is offered "Run again" (server: 409 org_rewrite_running)
and Rename/Merge/Change kind/Delete are enabled but refused. On a browser
15+ minutes slow, a truly stalled rewrite is polled forever and the actions
stay disabled although the server would accept them; Run again is never
offered.

**Evidence:** zz-review-R1-ADV-FE-3.test.tsx test 1: `noteServerDate('Wed, 01
Jul 2026 11:40:00 GMT', Date.now())` (browser pinned 12:00), heartbeat 10 s old
on the server clock -> `isRewriteLive(lr, serverNowMs())` true, page
`rewriteLive` false, `canRunAgain(lr)` true, getOrgList called once (no poll).

**Fix:** pass `serverNowMs()` to isRewriteLive / canRunAgain /
rewriteStatusText in useOrgAdmin and OrgListSection.

---

## R1-ADV-FE-5 | LOW | CONFIRMED

**Where:** dashboard/src/routes/settings/useOrgAdmin.ts:108-112 (setInterval
calls list.reload every pollMs) + dashboard/src/routes/orgs/useOrgList.ts:44-50
(every load() aborts the read in flight).

**Scenario:** while a rewrite runs, each 2 s tick aborts the previous GET
/api/organizations. When a read takes longer than 2 s (a slow phone
connection, a cold backend), no read ever lands: the status line stays
"Updating records", polling never stops (rewriteLive is computed from the
stale state), and the once-on-stop counts / "Not on the list" re-read never
happens.

**Evidence:** zz-review-R1-ADV-FE-3.test.tsx test 2: pollMs 25, every read
after mount takes 60 ms (rejects on abort like fetch) -> after 600 ms, 22
list reads, `lastRewrite.status` still 'running', `rewriteLive` still true.

**Fix:** do not abort for polls - skip a tick while a read is in flight, or
schedule the next poll (setTimeout) after the previous read settles.

---

## R1-ADV-FE-6 | LOW | CONFIRMED

**Where:** dashboard/src/routes/settings/OrgEntryDialogs.tsx:133-155
(SpellingsDialog: addDraft vs save).

**Scenario:** an admin types a spelling into "New spelling" and clicks the
primary footer Save instead of the inline Add. The draft is dropped silently;
the PATCH sends the old list (still restamping updatedAt/updatedBy) and the
dialog closes as a success.

**Evidence:** zz-review-R1-ADV-FE-2.test.tsx test 2: typed "ATL HA", clicked
Save -> onSaved called, PATCH `{"spellings":["AHA"]}`
(`toHaveBeenCalledWith('o-atl', { spellings: ['AHA'] })` passed).

**Fix:** on Save, fold a non-empty draft into the list first (or disable Save
with a hint while the draft is non-empty), and skip the PATCH when the list is
unchanged.

---

## R1-ADV-FE-7 | LOW | CONFIRMED

**Where:** dashboard/src/routes/contact/ContactEditForm.tsx:876-883 (onUse /
onUseOtherField apply the ref but never tell useOrgList);
ListingEditForm.tsx:554-557 and UnitCreateForm.tsx:579-582 (same).

**Scenario:** the form's list is read once when the dialog opens. A name added
(or renamed) by someone else afterwards is not in it, so the picker offers
"Add X as new"; "Is this really new?" asks the server, which answers "It is
already on the list as X"; staff click "Use X" - and the chip they just
picked from the server's own answer is marked "Not on the list" (the save
succeeds). Only onAdded calls noteAdded.

**Evidence:** zz-review-R1-ADV-FE-4.test.tsx: list read [Atlanta]; /check
returns match Metro; after "Use Metro Housing Authority" the chip's text is
"Metro Housing AuthorityNot on the list" and getOrgList was called once.

**Fix:** in onUse/onUseOtherField record the server-confirmed ref the way
noteAdded records an added entry (or reload the list).

---

## R1-ADV-FE-8 | LOW | CONFIRMED (latent - no current caller)

**Where:** dashboard/src/routes/orgs/NewOrgDialog.tsx:89-99, :117, :124.

**Scenario:** with `initialCheck` and an editable name (mode 'field' or
'settings' - the props allow it), edit the name (its check lands, `checked`
now belongs to the edited text), then edit it back to the original: the
effect skips the check (attempt 0 + initialCheck + original text) while
`checked.name` no longer matches, so the dialog shows "Checking the list..."
forever and "Yes, add it" stays disabled. Today only ContactDetail passes
initialCheck, in 'suggestion' mode where the name is read-only.

**Evidence:** zz-review-R1-ADV-FE-2.test.tsx test 1: field mode, text "Metro
Housing", initialCheck given; type "X", wait for the check, Backspace, wait
600 ms -> checkOrgText called once, "Checking the list..." present, "Yes, add
it" disabled.

**Fix:** skip only when `checked?.name === trimmed`, or restore
`{ name: text.trim(), result: initialCheck }` when the name returns to the
original.

---

## R1-ADV-FE-9 | INFO | PLAUSIBLE (reasoned)

**Where:** dashboard/src/routes/settings/NotOnListSection.tsx:256, :274, :296
(confirm sentences quote the row's own count) vs
app/src/services/orgRecords.ts:546 (the pass matches NORMALIZED text).

**Scenario:** "AHA", "aha" and "A.H.A." are separate "Not on the list" rows
(rows are keyed by exact value), but settling any one of them rewrites the
holders of all of them. The confirm says "(2 records)" while e.g. Clear
removes the value from every variant's records too, and the sibling rows
vanish after the reload. The normalized match is intended (pinned by
app/test/orgRecords.test.ts:197 "any case"); only the confirm copy
understates it.

**Fix:** in the confirm, sum the counts of every row whose value normalizes
equal (or list those sibling values).

---

## R1-ADV-FE-10 | INFO | PLAUSIBLE (reasoned)

**Where:** dashboard/src/routes/broadcasts/BroadcastComposer.tsx:118-130 and
:342-345 vs app/src/routes/broadcasts.ts:467-486.

**Scenario:** a draft made with "Old Name" is later renamed in Settings (the
old name becomes a spelling). Preview re-checks the stored value and answers
422 with the renamed entry as the ONE candidate - the server comment says "so
the composer can offer it" - but the composer ignores the body, clears the
pick and says "That housing authority is no longer on the list - pick it
again", although it was renamed, not removed.

**Fix:** when the 422 carries exactly one candidate, offer "Use <name>" (or
re-pick it with a notice naming the rename).

---

## Areas checked and found clean

- API client vs server: every /api/organizations path, method, body and
  unwrap; 201/202/204 handling; `acceptSuggestion` value body vs
  suggestions.ts parseAcceptValue; ApiError code/body narrowing.
- Wire types vs server shapes: OrgCheckResult, NotOnListRow/resolution
  (match/candidates/otherKind/compound/close), HolderRecord, OrgRewriteState,
  rename result incl. skippedSpellings, 409 bodies (entry, spans, uses,
  spelling/problem/entries).
- Hand mirrors: normalizeOrgText identical to app/src/lib/orgNames.ts;
  AI_RUN_DROP_REASON_LABELS keys equal app DROP_REASONS.
- Authorization: admin actions absent for a VA (isAdmin = me.role ===
  'admin') and enforced server-side (requireRole / inline PATCH check);
  /__dev/org-fixture lives on the dev router (app.ts:127 mounts it only when
  provided).
- Provenance-safe dirty tracking: the tenant form never sends an untouched
  housingAuthority/agency; property forms send accepted_authorities only on
  change vs the synthesized list; server D5 (unchanged passes, held members
  and legacy jurisdiction pass) agrees.
- 422 org_not_on_list handling in all three forms, the composer (create and
  Preview, gen-guarded, not marked stale) and suggestion-accept copy; no raw
  code is rendered.
- Composer: typing never recreates the draft; the send path is the curated
  selection, which the server never re-checks.
- AI accept (D8): exact-name short-circuit, value accept vs close-name PATCH,
  contact-change generation guard; ContactDetail is the only accept caller.
- Nested modals: NewOrgDialog rendered outside every form, Escape stack,
  backdrop mousedown, focus restore; listbox z-index 100 above modals (50).
- useOrgAdmin under StrictMode; details read never aborted; one re-read on
  stop.
- Other readers: TenantFile, tenantFacets, unitListFacets, FlyerPage,
  broadcastFormat read only and are unaffected; the contact timeline never
  surfaces org rewrite audits; unit Activity maps org_name_rewrite/cleanup
  with string from/to (orgRecords.ts record()).
- Perf harness: no profiled page mounts useOrgList on load; mutation catalog
  (+7) and the /settings/organizations exclusion are consistent.
- e2e: remaining `accepted_authorities: ['atlanta_housing']` posts resolve via
  the starting-list spelling "Atlanta Housing" to the exact name; preflight
  reseeds each run; workers 1; run-unique names; pickOrgName waits for the
  chip.
- Legacy jurisdiction-only units are outside "Not on the list" by design
  until app/scripts/clean-org-names.ts backfills them.
- ASCII rule: no non-ASCII character on any added line of the package.
