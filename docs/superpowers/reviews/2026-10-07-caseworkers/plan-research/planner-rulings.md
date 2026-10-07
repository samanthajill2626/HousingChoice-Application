# Caseworkers (branch B) - plan research: planner rulings

Five opus researchers (R1 contacts server + conversion, R2 organization across
the org-list machinery, R3 shares to partners, R4 dashboard contact surfaces,
R5 seeds/e2e/harness) read spec revision 13 against `feat/caseworkers`
@97ac55ee. Rulings are BINDING on the plan. Items marked SPEC are folded into
the spec as precision (revision 14); the rest are plan-level.

## R1 - contacts server and the conversion

- F1 ACCEPT (SPEC). `make`, `dismiss` and the preview answer 404
  `contact_not_found` for a pointer row (`phone_ref` or `email_ref`) and for a
  row whose `type` is not one of the five ContactTypes; pinned with a pointer
  id (the fake's sentinel `type: 'unknown'` must not hide it).
- F2 ACCEPT (SPEC). The commit guard gains a fifth clause,
  `attribute_not_exists(deleted_at)`; a failed condition whose consistent
  re-read is missing or deleted answers 404. The repair path re-checks
  deletion.
- F3 ACCEPT. The guard carries the stored revision as read (a number clause, or
  `attribute_not_exists` when absent - never the folded 0); `expect` widens to
  a list of clauses with number or string values; the no-op path evaluates
  every clause; the FakeWorld mirrors it.
- F4 ACCEPT AND FILE. An extraction run in flight may write tenant facts or new
  suggestions onto a just-converted caseworker (its writes are unconditional
  against a run-start snapshot). Not fenced in B; filed in section 12; RUNBOOK
  says `make` again re-sweeps suggestions but does not remove an AI-written
  authority.
- F5 ACCEPT AS STATED. The importer's `type_source` guard is a read-then-write
  (the same accepted race as `preserveStatus`); import type writes never bump
  the revision, so the commit guard does not cover imports. Both stated.
- F6 ACCEPT (SPEC). Soft-deleted units count. The landlord-of-record refusal
  reads `listByLandlord` for live AND deleted units; the roster refusal is one
  Scan without the deleted filter. The contacts router gains a `unitsRepo` dep.
- F7 RULED (SPEC). The relationship signal uses the "mentions" rule on the
  relationship row's role.
- F8 RULED (SPEC). "Mentions": D4's `normalizeOrgText(role)` contains
  `caseworker`, `case worker` or `case manager` (nothing else). The AI-note
  signal: a `notes` line that starts with the extraction prefix
  `[Auto - <date>]` and whose text after it, normalized, starts with
  "identified as" followed by "a caseworker", "caseworker", "a case worker" or
  "case worker"; tested with `prompt.ts:93`'s string verbatim. A line without
  the prefix does not count.
- F9 RULED (SPEC). Rows carry `signals[]` (R4-04). `dismiss` writes through
  `contactsRepo.update` with no revision bump and a `contact_updated` audit
  (`fields: ['caseworker_review']`); `dismiss` on an `unknown` answers 400; a
  `dismiss` body carrying `organization` answers 400.
- F10 ACCEPT (SPEC). Contacts POST refuses `caseworker_review`,
  `caseworker_conversion` and `type_source` too, through one helper both
  parsers call.
- F11 ACCEPT. The PATCH reads consistently when `type` or `role` is in the
  body; the 409 decision uses the MERGED result (stored role when the body
  omits it; `''`/null as absent).
- F12 ACCEPT. The conversion's status milestone labels by the NEW type.
- F13 ACCEPT (SPEC). "Clears `agency`" means SET `''`, matching every machine
  clear; `caseworker_conversion.agency` captures the prior value.
- F14 ACCEPT. Server copy beside `PROPERTY_MANAGER_ROLE`, dashboard copy in a
  small module, a mirror test pinning the constant and a table of
  `isCaseworkerRole` and mentions cases (R4-16).
- F15 ACCEPT. A new conversations-repo primitive sets `type` conditional on the
  read type (a lost condition is skipped and counted, never thrown to the
  client), mirrored in the fake; the conversion also writes the display-name
  denorm as the PATCH does; a type-less open 1:1 row is left and counted.
- F16 ACCEPT. Section 12's tour/placement follow-up also names
  `deriveTenantStatus` writing tenant statuses onto a caseworker.
- F17 ACCEPT. GLOSSARY's caseworker entry says the tenant's free-text
  `contact.caseworker` name is a different thing; B neither reads nor writes
  it.
- F18 ACCEPT (e2e rules below).

## R2 - organization across the org-list machinery

- F1 ACCEPT (SPEC). Usage keeps the per-field columns for display and adds two
  server-computed DISTINCT-record totals per entry: `inUse { active, deleted }`
  (any field, organization included - Delete) and `kindLocked { active,
  deleted }` (fields of the entry's kind only - Change kind).
  `refuseWhileUsed` takes the mode; both dialogs read the totals, never a
  column sum. The organization count shows inside today's "Used by" cell.
- F2 ACCEPT. The rewrite target kind comes from the first NON-organization
  field, never `fields[0]`; `organization` is listed last; both pinned. The
  widened revalidation union for a housing-authority rename gets a test.
- F3 ACCEPT. Organization-mode add (picker dialog, Settle "Add as new"): no
  default kind; the add button stays disabled until a kind is chosen.
- F4 ACCEPT. Copy: "Add <text> as a new organization"; "Couldn't load
  organizations"; `notOnListMessage` noun "organization"; NewOrgDialog
  organization intro "Check that this organization is really new"; no Split
  in its compound copy; `FIELD_LABEL.organization` = "Organization".
- F5 ACCEPT. `/check`: exactly one of `kind` / `kinds`; `kinds` a non-empty
  subset of the two kinds; else 400; `spellingFor` allowed with either.
- F6 ACCEPT. Resolve `add` on an organization row requires `kind` (400);
  `kind` on any other field or action is 400; `use` on an organization row
  searches both kinds.
- F7 ACCEPT. The carry test = `hasOrgControlChar` + `ORG_NAME_MAX` +
  `normalizeOrgText(text) !== ''`, NOT `checkNewOrgName`; a compound text is
  carried; pinned.
- F8 ACCEPT. The Organization picker's answer routes by FIELD; organization
  422s render under it; the Settle dialog's Remember lookup, "Name to use"
  picker and compound-half Use buttons search both kinds on organization rows.
- F9 ACCEPT. No script change; one docblock line and one RUNBOOK sentence.

## R3 - direct shares to partners

- F1 ACCEPT (SPEC). Neutral: kebab "Send to tenants" -> "Send this property";
  the card action's aria-label "Send this property to tenants" -> "Send this
  property"; the Matching empty state quotes the new label and says "a
  contact's Properties sent"; "check at least one tenant" -> "check at least
  one recipient"; "Flagged tenants you picked" -> "Flagged recipients you
  picked"; "No tenants reached" -> "No recipients reached" on the property
  Activity AND the landlord timeline; both timeline label sites
  (`contactTimeline.ts:695-697`, `:764`). Every share label keeps the
  "Sent to " prefix (R5-F5).
- F2 ACCEPT (SPEC). These STAY tenant-worded because the control reaches only
  tenants: "Add more tenants by filters", "Add a tenant", "No candidates - add
  a tenant below.", `audienceSummary`'s "Tenants - ...", TenantFile's "Send a
  property to this tenant".
- F3 ACCEPT (SPEC). A resolved non-tenant recipient row is labelled with
  `displayKind` (role, else type label - "Partner"); tenant rows unlabelled;
  an unresolved row omits `type`/`role` and renders unlabelled.
- F4 ACCEPT. `type`/`role` optional, units recipients route only, via a SECOND
  projection (the shared display projection is not widened); the harness
  fake projection changes in the same task; reserved-word placeholders;
  `listingSendsApi.test.ts:146-163` amended.
- F5 ACCEPT. PartnerFile's Properties sent rows show no tour chips.
- F6 ACCEPT. Proved by an API test (Renee as the negative fixture).
- F7 ACCEPT. The results-row fallback becomes "Recipient".
- F8 ACCEPT. Tests say "no thread for this phone"; the adoption site is proved
  by calling `adoptBroadcastRecipient` directly.
- F9 ACCEPT. PartnerFile's action aria-label "Send a property to this
  partner"; selectors.md updated.
- F10-F14 ACCEPT as written (a fresh consented partner for the share e2e; no
  send-time type re-fence; `tenantCount`/`tenantName` keys stay; stale
  comments updated; the deleted-seed gap noted, unchanged).

## R4 - dashboard contact surfaces

- 01 ACCEPT (SPEC). `make` and `dismiss` answer `{ contact }`.
- 02 ACCEPT. The plan pins one preview TypeScript shape (plan section 3),
  mirrored in `dashboard/src/api/types.ts`.
- 03 ACCEPT (SPEC). The server sends codes; the dashboard maps the four
  refusal codes, `contact_changed` and `caseworker_use_conversion` to its own
  copy. Each refusal (409 body and preview list) carries the blocking ids
  (`placementId`, `tourId`, `unitId`) so the sentence links to them.
- 04 ACCEPT (SPEC). A Possible row carries `signals: Array<'role_mentions' |
  'ai_note' | 'relationship' | 'partner_no_role'>`, one staff label each.
- 05 ACCEPT. E2E rules (below).
- 06 ACCEPT (SPEC). Today's Unknown card order is Tenant, Landlord, Partner,
  Property Manager; B makes it Tenant, Landlord, Partner, Caseworker, Property
  Manager, and the KindPicker segments follow it (then Other).
- 07 ACCEPT. Every one-kind spot listed becomes a plan task.
- 08 ACCEPT. The dialog settles typed text with `useTypedOrgText`.
- 09 ACCEPT. Confirm is disabled while the preview lists a refusal (the server
  re-checks). "Not a caseworker" asks a one-line confirm ("Hide <name> from
  Possible caseworkers? This can't be undone in the app."). The plan fixes all
  dialog words and accessible names.
- 10 ACCEPT (SPEC). "Make caseworker" is a menuitem in the contact header's
  More actions menu (ContactActionsMenu).
- 11 ACCEPT. The edit form's 409 `caseworker_use_conversion` copy points to
  More actions > Make caseworker.
- 12 RULED. A new CaseworkersList page (not a ContactsList filter); the
  Contacts "Filter contacts" tabs gain Caseworkers (they mirror the nav); nav
  order Tenants, Landlords, Caseworkers, Unknown; the partner dot token; chips
  URL param `org`; rows show the organization; ChipGroup/Chip factored out of
  TenantFilters.
- 13 RULED. `/contacts/caseworkers` joins IMPLEMENTED and is EXCLUDED from the
  page profiler with a filed issue naming the three-partition scan (A's
  `/settings/organizations` precedent); the preview read fires only when the
  dialog opens; nothing new loads at ContactDetail or TenantFile mount.
- 14 ACCEPT. On success the dialog refetches the contact's suggestions,
  timeline and threads hooks.
- 15 ACCEPT. The preset lights on exact `CASEWORKER_ROLE`; the OFFER is gated on
  the STORED contact (`type === 'partner' && isCaseworkerRole(role)`).
- 16 ACCEPT. A small dashboard module holds `CASEWORKER_ROLE`,
  `isCaseworkerRole` and the mentions matcher (no import cycle), mirror-tested.
- 17 ACCEPT AS STATED. Typing a caseworker role on a tenant/landlord base stays
  possible; the Possible list catches it.
- 18 ACCEPT (SPEC). A partner header's facts line shows its organization.
- 19 ACCEPT. Update `staff-notes-on-landlord-partner-files` (landlord half stays
  open); wire `onContactUpdated` into PartnerFile.
- 20 ACCEPT. Email triage's create-contact is a known entry point without
  Caseworker (listed, unchanged).
- 21 ACCEPT. Phone-width check of the six-segment picker in self-QA; the touched
  placeholder line becomes ASCII.
- 22 ACCEPT. No message-catalog change; GLOSSARY gains caseworker and
  organization.
- 23 RULED. Dashboard functions `makeCaseworker`, `dismissPossibleCaseworker`
  (POSTs: catalog count +2) and `previewCaseworker` (GET).

## R5 - seeds, e2e, harness

- F1 = R4-06. F2 ACCEPT (SPEC): only `role` counts; `role_title` is left alone.
- F3 ACCEPT (SPEC): "no path" means no UI path and no seed; the API can.
- F4 = R3-F1. F5 ACCEPT: keep the "Sent to " prefix.
- F6 ACCEPT (SPEC). The KindPicker datalist filter uses the "mentions" rule.
- F7 = R1-F8 (prefix required; e2e plants the line through POST `notes`).
- F8 = R1-F7.
- F9 = R4-12. F10 = R4-10.
- F11 ACCEPT. `contact-create.spec.ts:201` is scoped to the relationship card
  and made exact in the same task as the nav link.
- F12 ACCEPT. `org-lists.spec.ts:557-562` moves with the usage wire change.
- F13 ACCEPT. The dev seam, the e2e fixture types and the README/selectors rows
  move together.
- F14 = R4-13.
- F15, F16 ACCEPT as e2e rules.
- F17 ACCEPT. Extend the REAL repos and the harness fakes together, with parity
  tests: the multi-clause update guard, a conditional conversation re-type, an
  all-holders byPhone/byEmail read, paging in the fake unit list; the
  possible-caseworkers tests use `contactsPartitionFake`.
- F18 ACCEPT. No seed change.

## E2E rules (binding on every B spec)

1. Assert only rows the spec created with a run-unique stamp; never a count,
   never an empty state, on the Possible list or the Caseworkers tab.
2. Never convert or dismiss a seeded contact (Renee, Dario, Tasha, Marcus...).
   Tasha (open placement) and Marcus (landlord of record) may be used READ-ONLY
   as preview-refusal fixtures.
3. The share e2e mints its own consented partner and never pre-opens the
   conversation before the share.
4. The household-phone case is unit/integration only (POST refuses a held
   phone).
