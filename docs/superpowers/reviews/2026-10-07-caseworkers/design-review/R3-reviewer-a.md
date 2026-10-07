# Design review R3 - reviewer A (adversarial) - branch B (caseworkers), revision 11

- Date: 2026-10-07
- Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
  at 500e1a24 (revision 11).
- Read with: `git diff 4884aa91 500e1a24` and the "Round 2" section of
  `adjudications.md`.
- Read-only; nothing run. Code is cited `file:line` as read in this tree.

## Verdict

Two findings (1 and 2) change WHAT gets built:
- finding 1 adds an API surface (the dialog needs a server read the spec does
  not define);
- finding 2 changes the route contract (how the dialog's Organization is sent).

Everything else is LOW wording or precision. Revision 11's main move is sound:
taking the conversion out of the PATCH and refusing `caseworker_use_conversion`
there. I checked that the 409 breaks no existing writer (section "Checked",
below).

---

## 1. [MEDIUM] The dialog shows numbers no endpoint provides

**What is wrong.** D19's dialog, "the same on every entry point", shows:
- how many threads it will re-type and how many it leaves because another
  contact shares the phone or address;
- an Organization picker prefilled with the stored organization, else the
  DERIVED one.

Neither can be computed in the browser, and section 6 defines no read that
returns them.

- **Thread counts.** They need D21's new all-holders byPhone / byEmail Query
  (pointer rows resolved, deleted holders excluded) for every phone and email
  of the contact, plus each thread's participant `contactId`.
  - `findByPhone` returns one arbitrary holder (`app/src/repos/contactsRepo.ts:1069-1083`).
  - No dashboard endpoint answers "who else holds this number".
  - The only phone-to-thread reader is server-side
    (`app/src/lib/contactThreads.ts:38-54`).
- **Derived organization.** It needs D4 resolution over both lists, the
  agency-first rule, the carried-text decision and D13's limits.
  - The dashboard has an `isOnList` twin (`dashboard/src/routes/orgs/orgCopy.ts:95-101`),
    not the carry or limit logic.
  - A second client copy of that decision would drift from the route's.
- Section 6 lists only `POST /api/contacts/:contactId/caseworker-review`
  (`make` / `dismiss`). It has no preview or dry-run, and every entry point
  (Possible list, Unknown card, contact pages) opens the dialog BEFORE calling
  it.

**Implies.** Add a read, for example `GET /api/contacts/:contactId/caseworker-conversion`
or `action: 'preview'` on the route. It returns:
- the derived organization (resolved name, carried text, or none);
- re-typed and left-alone thread counts;
- ideally the refusals, so the dialog can say "resolve X first" before staff
  confirm.

This also needs a page-profiler / mutation-catalog decision (section 10's
pins). Without it, the builder must either invent the endpoint or drop the
counts the spec promises.

## 2. [MEDIUM] Prefilled off-list text is refused when the dialog sends it back, and "clear" cannot be expressed

**What is wrong.**
- The route "takes the dialog's `organization` (D5-checked, either kind);
  without one in the request it keeps a stored organization, else derives
  one". The dialog's picker is "prefilled with the contact's stored
  organization, else the derived one".
- When the derived value is CARRIED not-on-the-list text (D19: an off-list
  agency "carried as written"), the untouched dialog sends that text back as
  `organization`.
- D5 checks a scalar "only when its value changes" (D5, section 4). The stored
  value is absent, so this is a change, the text is off the list, and the
  answer is 422 `org_not_on_list`.
- The carry exception (D17) applies only when the request has NO organization.
  So the carry path is unreachable from the dialog that is now its only entry
  point, and staff get a 422 for pressing Confirm on what the server proposed.
- "Staff may change or clear" has no wire form:
  - `organization: ''` is, by D17, "clear = REMOVE";
  - but "without one in the request ... derives one".
  - The spec does not say whether `''` means "leave absent" or "no request
    value, derive".

**Implies.** The contract must say:
1. the dialog OMITS `organization` when staff left the prefill untouched (the
   server re-derives, carry included); or the route accepts the exact
   derived/carried text it would itself produce;
2. `organization: ''` means "leave it absent", overriding stored and derived.

## 3. [LOW] Where the contact-page "Make caseworker" action is shown

**What is wrong.**
- **team_member.** The tenant page renders for `team_member` too:
  `ContactDetail` maps every type that is not landlord, partner or unknown to
  the tenant kind (`dashboard/src/routes/contact/ContactDetail.tsx:563-573`).
  A "Make caseworker" action on "the tenant page" would appear on team members
  and always answer 400. Key the action on `contact.type`.
- **Deleted contacts.** The route answers 404, so hide the action.
- **Landlord pages.** Most landlords are a landlord of record or hold a roster
  seat, so the action there nearly always ends in 409. Acceptable, but the
  dialog (finding 1's read) should show the refusal before the confirm.

## 4. [LOW] The commit write's condition does not cover the values it records and removes

**What is wrong.**
- Step 1 is conditional on `classification_revision` only. The contacts PATCH
  bumps that revision only on type and role writes
  (`app/src/repos/contactsRepo.ts:1318-1320`, :1352-1358, per the R1
  re-check).
- A concurrent PATCH of `housingAuthority`, `agency` or `organization` between
  the route's read and its write still commits. The conversion then:
  - records the STALE value in `caseworker_conversion`;
  - REMOVEs or clears the NEW one, which is recorded nowhere;
  - may derive `organization` from a value that no longer exists.

**Implies.** Also condition the write on the values it read for those three
attributes, or state the race as accepted next to the refusal race already
accepted.

## 5. [LOW] The repair text lags revision 11's own thread rule; `caseworker_conversion` can be overwritten

**What is wrong.**
- **Vestigial old-type read.** D19 says a repair re-run "reads the old type
  from `caseworker_conversion`". D21 (revision 11) re-types every OWN thread
  not already `partner_1to1`, whatever its type, so the repair needs no old
  type. Drop the clause, or a builder will key the rule on `fromType` again.
- **Overwrite.** A contact converted, re-typed to Tenant by the generic change,
  then converted again gets a second commit write. That write overwrites
  `caseworker_conversion`, losing the first conversion's removed values. Only
  the best-effort audit (step 4) keeps them. State it, or keep a list.
- **New contacts have no record.** A caseworker created with the Caseworker
  choice has no `caseworker_conversion` at all. The step-4 audit payload, which
  "carries `caseworker_conversion`", must tolerate its absence on a `make`
  repair.

## 6. [LOW] Cross-section wording

- D19 says "RUNBOOK names the repair". Section 11's branch B line is still
  "deploy only. No script", with no RUNBOOK entry listed.
- D18: "the tab starts empty until a conversion writes a role". A new contact
  saved with the Caseworker choice (D16) also writes one.
- D16: "accepting an AI 'partner' suggestion through the Caseworker choice ...
  records `accepted`". The choice is now offered only on new contacts and
  existing caseworkers. Neither carries a pending type suggestion (type
  suggestions are made for `unknown` contacts only,
  `app/src/services/extraction/apply.ts:577-578`, per R1). Only the conversion
  path can record it.

---

## Round-2 rulings

- **2(c), a repair button.** Conceded: route-only plus an error log and a
  RUNBOOK entry is proportionate for a rare failure after the commit point.
  Finding 6's RUNBOOK gap still applies.
- **All other round-2 rulings.** No contest: each fix is present in revision 11
  and matches the code it relies on.

## Checked and correct (revision 11)

- **The PATCH refusal breaks no current writer.** A write is now refused when
  its result is partner + an `isCaseworkerRole` role on a contact that is not
  one. Today, nothing writes partner + any role through the PATCH:
  - KindPicker Partner and the Unknown card send `role: ''`
    (`dashboard/src/routes/contact/contactProfile.ts:26-34`);
  - Other offers only tenant and landlord bases
    (`dashboard/src/routes/contact/KindPicker.tsx:32-43`);
  - type suggestions are accepted only through triage
    (`app/src/services/suggestionResolution.ts:269`);
  - the importer and seeds bypass the PATCH (`app/src/lib/import/apply.ts:1079`;
    `app/src/lib/seed/lean.ts:170-176`).
  - Every "Case worker" role in the app, dashboard and e2e tests is on a TENANT
    base (`app/test/contactsCrud.test.ts:209`, `app/test/contactTriage.test.ts:599`,
    :608, `dashboard/src/routes/contact/KindPicker.test.tsx:114`, :196,
    `dashboard/src/routes/contact/ContactEditForm.test.tsx:216-226`). None
    trips the 409.
  - POST create cannot produce one for an existing phone or email (409
    `contact_exists`, `app/src/routes/contacts.ts:1070-1086`).
- **Taking the conversion out of the PATCH** removes R2 findings 1, 5 and 10 at
  the root.
- **The type drain on the route.** It needs the pre-write read the PATCH makes,
  because `wasPrewriteIdentity` gates `accepted`
  (`app/src/routes/contacts.ts:1765-1770`). This is plan precision, already
  implied by "the PATCH's existing ... drain".
- **All-holders plus participant ownership** is the correct test for
  `participants` holding exactly one entry
  (`app/src/repos/conversationsRepo.ts:174-179`).
- **The relationship signal** is back to tenants only. The Marcus Bell e2e link
  (`e2e/tests/dashboard-next/contact-create.spec.ts:185-200`) no longer reaches
  the list.
