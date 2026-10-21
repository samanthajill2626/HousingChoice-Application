# R2 - build research: app landlord, Apply and matching (S3 + S4 app)

- Reader: R2 (read-only live-tree drift check, charter
  `.superpowers/sdd/research/CHARTER.md`).
- Slices: S3 App landlord and Apply (Tasks 3.1-3.3, plan lines 8558-10626)
  and the APP part of S4 Matching (Tasks 4.1-4.4, plan lines 10627-12227,
  plus its coverage map / notes 13487-13565). Sections 0-4 (plan lines
  1-913) read in full. S1/S2 code S3/S4 import skimmed (plan 1600-1880
  registry, 2715-2802 `planUnitApply`, 5740-5916 fenced repo + harness
  fake). Cross-slice greps into the S4 dashboard part (12228-13486), S5 Task
  5.1 (14140-14366) and S6 Apply dialog model (22540-22580).
- Tree: `b0b07a5a080b5303b74e77d91e02977d503584e0` (main @1d7a4667 + docs).
  Every S3/S4 target file is LF-only.
- Method: all 56 quoted anchors of Tasks 3.1-3.3 and 4.1-4.4 were extracted
  from the plan by line range and counted in the target file with a script
  (count + live start line in the reference file
  `.superpowers/sdd/research/R2-app-landlord-matching-ref.md`). No S1/S2
  task edits any S3/S4 target file (grep of plan 914-8557), so every S3/S4
  anchor must match the branch-point tree directly - and does.

## Findings

Counts: BLOCKER 0, MAJOR 0, MINOR 7.

R2-F1 - Task 3.3 Step 3(b) - KIND: INVARIANT / RULING - SEVERITY: MINOR
- Plan 3.1 row "landlordId vs requirement_sources (PR1-9)" (plan 607):
  "Do not add a map writer that skips `updated_at`." Task 3.3 (plan
  10481-10497) adds `requirement_sources` to the PM unit and no `updated_at`.
- Tree: the PM unit (`app/src/lib/seed/cast.ts:1344-1369`) carries
  `created_at: CD` and no `updated_at`. The importer's import-owned branch is
  `attribute_not_exists(updated_at)` (`app/src/lib/import/apply.ts:1601-1606`),
  BUT importer unit ids are `unitIdForAddress` = uuidv5 of the address
  (`apply.ts:1491`, `ids.ts:84-86`), so an import can never address
  `unit-cast-*`. No behavior risk; the watch's rationale does not apply.
- Instruction: in Task 3.3 record the exception in the slice report
  ("seed map writer without updated_at; importer cannot address
  unit-cast-* ids"). Only if the orchestrator wants the watch to hold
  literally, add `updated_at: CD,` to the PM unit in Step 3(b) (no test
  reads it).

R2-F2 - Task 4.2 Step 2 - KIND: OTHER (RED claim) - SEVERITY: MINOR
- Plan (11288-11294): "every `bedroomSizes` case fails because the resolver
  ignores that key ... and returns every tenant"; only "LEGACY below 4" is
  named as a PIN.
- Tree: `audienceResolution.ts:186-189` ignores `bedroomSizes`, so the case
  "an empty list, or none, is no size filter" (plan 11245-11249) returns
  everyone on unchanged code and is GREEN at Step 2 (a de-facto PIN).
- Instruction: in Task 4.2 Step 2 expect that case green too; the other D12
  cases, 1b and 1d still give the real RED.

R2-F3 - Task 4.3 Step 1b - KIND: ANCHOR (line hints) - SEVERITY: MINOR
- Plan hints `:2765-2769`, `:2799-2800`, `:2806-2807`, `:2812` (11578-11621).
- Tree (`app/test/broadcastApi.test.ts`): the quoted texts start at 2767,
  2791, 2798 and 2804. All quoted anchors are byte-exact and unique (the
  `replace_all` line is 2x, at 2260 and 2465, as the plan says).
- Instruction: none beyond using the quoted text, not the hints.

R2-F4 - S3 / S4 "Facts" - KIND: FACT (citation drift) - SEVERITY: MINOR
- Plan S3 facts (8713-8716): owner/manager in `castItems()` at
  `:1505-1506`, unit at `:1514`; `app.ts:145` deep-trim (8680). S4 F3
  (10716): authority list read `:146-147`.
- Tree: `cast.ts:1504-1505` and `:1513`; `trimJsonBody()` at `app.ts:146`;
  `audienceResolution.ts:145-146`. S4 F15's "Some anchors below contain an em
  dash or arrow in the OLD text" is not true of the APP anchors (all ASCII;
  the plan's 8558-12227 range holds no non-ASCII byte).
- Instruction: none (no step depends on these lines).

R2-F5 - Plan 3.1 row "Landlord `req_` keys" - KIND: INVARIANT - SEVERITY: MINOR
- Plan (602) lists writers contacts PATCH (3.x), full seed (3.x), contact
  create WATCH; readers dashboard + Apply route.
- Tree: further surfaces, all SAFE (no task needed): readers - S2's
  create/PATCH classification reads the landlord's `req_` values
  (`nextRequirementSources` -> `landlordItemValue`, plan 2392ff, IN-PLAN via
  S2); pass-through GET `/api/contacts/:id` (`contacts.ts:1202-1221`, whole
  item), GET `/api/contacts` (`contacts.ts:1107`, `listByType` has no
  projection), PATCH response (`contacts.ts:2046`). Writers - every other
  contact creator builds a named-field stub (`routes/public.ts:340`,
  `routes/unmatchedEmail.ts:462`, `services/contactCapture.ts:111`,
  `services/groupConvert.ts:347`, `services/groupMembers.ts:155`); the
  importer writes contacts by `UpdateCommand` SET of named fields
  (`import/apply.ts:748,861,1247,1376-1422`; its only Delete is a dropped
  imported contact, `:832`); the caseworker conversion writes named fields;
  extraction targets are `EXTRACTABLE_FIELDS` (`extraction/schema.ts:24-33`),
  never `req_`. The only stripper is `contactsRepo.update` null -> REMOVE
  (`contactsRepo.ts:1550-1556`), reached only through the PATCH. Display
  projections (`contactsRepo.ts:1050,1066`) never carry `req_` keys.
- Instruction: S3 slice report lists these as checked; no code change.

R2-F6 - Task 3.1 - KIND: OTHER (informational) - SEVERITY: MINOR
- Plan 2.4 / Task 3.1 (g): any present `req_` key on a contact whose
  RESULTING type is not `landlord` is 400 - null (REMOVE) included, since
  `requirementKeys` is taken from `parsed.patch` keys.
- Tree/spec: a landlord re-typed away (PATCH type change, which
  `typeChangeRefusals` allows when no live unit names it; or the caseworker
  conversion) keeps its stored `req_` keys and can no longer clear them.
  Spec D2 binds exactly this ("each is a 400 on a contact whose resulting
  type is not `landlord`"), and no reader surfaces them (the Apply route 400s
  a non-landlord; I3 keeps every live unit's landlord typed `landlord`).
- Instruction: none required; optionally one line in the S3 slice report.

R2-F7 - Task 4.4 Step 4 - KIND: OTHER (lean check) - SEVERITY: MINOR
- Plan (12114-12115, 12224): "Lean is untouched (byte-stable)" with no check
  (Task 3.3 has `git diff --exit-code 1d7a4667 -- app/src/lib/seed/lean.ts`).
- Tree: true by construction - `matrixItems` is merged only for
  `profile === 'full'` (`seed/index.ts:126-133`) and lean `SEED` has no
  `broadcasts` table at all (`lean.ts:85-541`, tables contacts, units,
  conversations, messages, matches, placements, invoices, users, settings,
  audit_events). No test snapshots lean; only the item COUNT is pinned
  (`seedProfile.integration.test.ts:100-104`).
- Instruction: optional - add the same `git diff --exit-code 1d7a4667 --
  app/src/lib/seed/lean.ts` line to Task 4.4 Step 4.

## Confirmed

- Anchors: Task 3.1 8/8 byte-exact and unique (`contacts.ts` 9, 101, 405,
  757 - the FIRST `LANDLORD_BOOLEAN_FIELDS` loop, unique by `patch[key] = v`;
  the second at 940 writes `item[key]` -, 1041, 1552, 1587 - `const allow =
  statusAllowlistFor(stored.type);` occurs once -, 1784); Task 3.2 2/2 (114,
  1196) + (d) produced by Task 3.1 (a); Task 3.3 2/2 (`cast.ts` 1323, 1357);
  Task 4.1 7/7; Task 4.2 11/11; Task 4.3 22/22 (`replace_all` 2x as stated);
  Task 4.4 4/4. Total 56/56.
- Contacts PATCH flow (Task 3.1 facts): `parseTriageBody` copies named keys
  only, unknown keys ignored, empty -> 400 `no updatable fields supplied`
  (`contacts.ts:537-793`, 784-786); one `getById` read, consistent only for
  org fields / classification (1546-1556); pointer 404 (1561-1564); status
  re-validation 1582-1592; provenance clear limited to `PROVENANCE_FIELDS`
  (1761-1765); snapshot loop 1784-1793; one `contacts.update` (1810-1814);
  audit `contact_updated` `{ fields: parsed.changedFields, actor }`
  (1997-2001); create copies named keys only (817-994, 1120-1184). No name
  collision for the new consts (`resultType` at 1659 is in a sibling block
  scope; `merged` at 1507 is another handler).
- Tenant `pets` / `evictions` / `pets_source` / AI suggestion path: Task 3.1
  edits only the snapshot loop (adds a `req_` skip); the string-only loop
  (731-737), the provenance clear and the supersede loop are untouched;
  `suggestions.test.ts:374-400` still pins the tenant path; no existing test
  sends a `req_` key (grep of app/test, dashboard/src, e2e is empty), so Task
  3.1 breaks no existing test.
- Apply route (Task 3.2) vs plan 2.4 / AR13-AR19 / PR1-6 / PR1-8: refusal
  order 404 (incl. phone/email pointer) -> 400 not a landlord -> 400 body
  (items, expected, units count, unitId, repeat, ownItems) -> 409
  `deposit_conflict` -> 409 `requirements_changed`; `structuredClone` of the
  consistent read passed to BOTH `planUnitApply` and `applyRequirements`;
  `ConditionalCheckFailedException` -> `changed_during_apply`, any other error
  rethrown (Express 5.2.1, `node_modules/express/package.json`); best-effort
  audit with `log.warn` (precedent `services/primaryHandoff.ts:127-137`,
  test precedent `primaryHandoffService.test.ts:208-224`); items de-duplicated;
  `false` in `expected` read as blank. Spec D8 test bullets all covered.
- Registration: `registerCaseworkerRoutes(router, ...)` at `contacts.ts:1196`
  runs before GET `/:contactId` (1202); only `/`, POST `/` and `/vocabulary`
  precede it; no route can capture POST `/:contactId/requirements/apply`.
  The router is mounted at `/api/contacts` behind requireAuth + CSRF
  (`api.ts:894-927`) and receives `auditRepo` and `unitsRepo`; CloudFront
  already forwards all methods for `/api/*` (`infra/modules/cloudfront/main.tf:158`).
  The dashboard catalog entry is S5's (plan 14332, AR42); the e2e mutation
  inventory scans `dashboard/src/api/endpoints.ts`, so the server route
  alone changes nothing there.
- Harness facts (S3): contacts `getById` live (`twilioWebhookHarness.ts:2279-2281`),
  `update` null -> delete and guards (2414-2462), units `getById` live
  (2886-2888), `conditionalCheckFailed` (625-626), audit fake +
  `failAuditAppendFor` (2648-2670), app logger to `capture` at info
  (5582), `/api` wiring incl. `contactsRepo`, `unitsRepo`, `auditRepo`,
  `extractionRepo` (5604-5626). `putSuggestion` input shape matches
  (`extractionRepo.ts:231-233`, `SuggestionItem` 86-113). `phoneRefId`
  exported (`contactsRepo.ts:405`); `UnitItem` (524) and `ContactItem` (350)
  have index signatures, so every test literal and `planUnitApply({ unit:
  read })` typecheck.
- Cross-slice S3 <- S1/S2: `parseLandlordRequirementPatch`,
  `hasDepositConflict`, `REQUIREMENT_ITEMS`, `REQUIREMENT_LANDLORD_KEYS`,
  `isRequirementItemId`, `landlordItemValue`, `itemValuesEqual`,
  `unitItemValue`, `readRequirementSources`, `normalizeRequirementValue`,
  `planUnitApply`, types `ItemValue` / `RequirementItemId` / `ApplySkipReason`
  - names, arity and shapes match S1's task code (plan 1609-1880, 2727-2802);
  error strings name the `req_` key (AR3), so every `toContain(key)` case
  holds. `UnitsRepo.applyRequirements(read, patch)` matches S2 (plan 5687,
  5835-5837 real repo stamps `updated_at` = AR18; harness fake 5914-5916
  compares by value with `isDeepStrictEqual`, 5863-5866 - the 3.2 race test
  holds). `requirementsFixtures` is NOT imported by S3 (its tests define local
  helpers), so no contract.
- Cross-slice S5/S6 <- S3: `applyLandlordRequirements` POSTs
  `/api/contacts/${encodeURIComponent(id)}/requirements/apply` (plan
  14303-14310); `ApplyRequirementsBody` / `ApplyRequirementsResult` /
  `ApplySkipReason` (14144-14166) equal the route's wire; S6's
  `applyRequestBody` sends `ownItems` on every row and `expected` from
  `landlordItemValue` (every key of each item, null blank) (22554-22566), as
  the route's exact-keys check needs.
- Seeds (Task 3.3): PM persona ids resolve (`cast.ts:97-99` ->
  `contact-cast-pm-managed-property-owner`, `unit-cast-pm-managed-property`);
  no seed writes `req_` or `requirement_sources` today (grep of
  `app/src/lib/seed/` empty); `matrixItems` / `buildLiveStaticItems` never
  re-emit cast rows, so the "exactly one holder" and "only PM unit holds the
  map" cases are exact; no test pins the persona's fields (only
  `seedHeardFrom.test.ts:83-84`, absence of `last_heard_from_at`);
  `seedOrgNames.test.ts:125-129` scans org values / retired slugs only; the
  history post-pass emits `listing_status_changed` only. Full-profile Put is
  exercised by `seedProfile.integration.test.ts:156`.
- Lean byte-stability: no task edits `lean.ts` (grep of the plan); lean =
  `SEED` only (`seed/index.ts:117-121`); no `toMatchSnapshot` anywhere in
  app/test or e2e; `1d7a4667` resolves (`git cat-file -t` = commit).
- S4 facts F1-F7, F15, F16: true against the tree (minor drifts in R2-F4).
  F5 holds: estimate (`broadcasts.ts:938`), preview (1039-1042) and no-body
  send (1285) all reach `resolveAudience` (781, 1285); create echo (987),
  results (450) and list (480) all go through `wireAudienceFilter`; nothing
  else in app/src reads the size (jobs, units, today, timeline: no
  `audience_filter` read).
- S4 existing tests: every app pin of the single size is in the plan's table
  and updated by 4.2 / 4.3 (`audienceResolution.test.ts:325-334, 386-396,
  492`; `blastAudienceRules.test.ts:105-150`; `broadcastApi.test.ts`
  2260, 2465, 2478, 2566, 2767, 2791, 2798, 2804, 2827); PINs 1962-1985 and
  3053-3062 still hold (stored as `bedroomSizes: [2]`, resolver matches 2).
  No test pins the `bedroomSize` 400 message; the log field
  `bedroomSizeFilter` appears only at `audienceResolution.ts:245` and its test
  (:492) - no runbook, infra query or script reads it.
- S4 importers: `WireAudienceFilter` (gains required `bedroomSizes`) is built
  only inside `wireAudienceFilter` (`blastAudienceRules.ts:207-234`); every
  `AudienceFilter` / `BroadcastItem` importer (25 files incl.
  `seed/performance.ts:1039` `satisfies BroadcastItem`) survives an optional
  key; ESLint is `tseslint.configs.recommended` (no `no-deprecated`), so the
  `@deprecated bedroomSize` uses are not lint errors.
- Cross-slice S4 app -> S4 dashboard: the dashboard `SIZE_CASES` (12276-12295)
  and mirror `bedroomSizesOfFilter` body (12563-12578) are byte-identical to
  the app's (10892-10911, 11065-11080); it reads the wire through that reader,
  so `bedroomSizes` always + compat `bedroomSize` (first, when non-empty)
  satisfies it; the composer sends `bedroomSizes` chip values 0..4, inside
  the POST's 0..12 rule. Rulings AR22, AR25 and plan 2.5 are implemented as
  bound.
- Commands: every test path in Tasks 3.1-3.3 and 4.1-4.4 RED/GREEN steps
  exists or is created by its task (34 neighbour files checked); app vitest
  from `app/`, typecheck/eslint from the root, ASCII checks in Git Bash.
  Typecheck covers app/test (`app/package.json:13`, `app/tsconfig.test.json`).
- ASCII: plan text 8558-12227 holds no non-ASCII byte; `blastAudienceRules.ts`,
  `audienceResolution.ts` and both their tests are pure ASCII today;
  `contacts.ts`, `cast.ts`, `matrix.ts`, `broadcasts.ts`, `broadcastsRepo.ts`,
  `broadcastApi.test.ts`, `seedMatrix.test.ts` carry pre-existing non-ASCII
  (added-lines check applies).

## Invariant sweep

(a) Landlord `req_` keys

| Surface | Kind | file:line | Status |
|---|---|---|---|
| contacts PATCH `parseTriageBody` + type gate + `deposit_conflict` | writer | `contacts.ts:757-764` (+ new block), 1552-1592 | IN-PLAN (3.1) |
| `contactsRepo.update` null -> REMOVE (only stripper) | writer | `contactsRepo.ts:1550-1556` | IN-PLAN (3.1, via PATCH) |
| full seed, Delia Okonkwo | writer | `cast.ts:1316-1330` | IN-PLAN (3.3) |
| contacts POST (`parseCreateBody`, named keys) | writer (ignores) | `contacts.ts:817-994, 1120-1184` | IN-PLAN (3.1 PIN) |
| public intake / unmatched email / auto-capture / group convert / group members creates | writer (stubs, cannot carry) | `public.ts:340`, `unmatchedEmail.ts:462`, `contactCapture.ts:111`, `groupConvert.ts:347`, `groupMembers.ts:155` | NOT-IN-PLAN (safe, R2-F5) |
| importer contact writes (UpdateCommand SET named fields; Delete of a dropped import) | writer (cannot carry/strip) | `import/apply.ts:748,832,861,1247,1376-1422` | NOT-IN-PLAN (safe) |
| caseworker conversion / type change keep the keys | writer (leaves residue) | `caseworkerConversion.ts:399,585`; `contacts.ts:1654-1696` | NOT-IN-PLAN (spec-consistent, R2-F6) |
| AI extraction / suggestion accept | writer (never) | `extraction/schema.ts:24-40` | IN-PLAN (3.1 row WATCH) |
| Apply route (landlord read, consistent) | reader | new `contactRequirementsApply.ts` | IN-PLAN (3.2) |
| units create/PATCH classification (`landlordItemValue`) | reader | plan 2392ff (S2) | IN-PLAN via S2, not in the 3.1 row (R2-F5) |
| GET contact / list / PATCH response pass-through | reader | `contacts.ts:1202-1221, 1107, 2046` | NOT-IN-PLAN (no action) |
| dashboard card, edit form, create prefill, `requirementDisplay`, dialog | reader | S5/S6 | IN-PLAN (5.x, 6.x) |
| `contact_updated` renderers | reader | none (no dashboard/app renderer of its `fields`) | n/a |

(b) Tenant `pets` / `evictions` / `pets_source` / AI suggestions: untouched by
S3 except the snapshot-loop `req_` skip (AR21); pinned by
`suggestions.test.ts:374-400` and the new 3.1 isolation case. IN-PLAN.

(c) Audience `bedroomSize` / `bedroomSizes`

| Surface | Kind | file:line | Status |
|---|---|---|---|
| `parseAudienceFilter` | writer | `broadcasts.ts:175-225` (size 210-223) | IN-PLAN (4.3) |
| `broadcastsRepo.create` / harness fake create (pass-through) | writer | `broadcastsRepo.ts:737`; `twilioWebhookHarness.ts:3702` | IN-PLAN (type 4.1; no edit) |
| matrix seed (sent legacy 1, draft -> `[2]`) | writer | `matrix.ts:1230, 1267` | IN-PLAN (4.4) |
| performance seed (no size key) | writer | `seed/performance.ts:1039-1043` | NOT-IN-PLAN (unaffected) |
| composer / AudienceFilters | writer | `BroadcastComposer.tsx:223`, `AudienceFilters.tsx:137,146` | IN-PLAN (4.6) |
| e2e API bodies POST legacy `bedroomSize: 2` | writer | `a2p-compliance.spec.ts:530`, `broadcasts.spec.ts:152,359`, `landlord-activity.spec.ts:85`, `listing-activity.spec.ts:105,186`, `send-outcome-cards.spec.ts:117` | IN-PLAN (S4 note: no repair needed) |
| scripts / dev routes | writer | none (grep of app/scripts, scripts, `routes/dev.ts`) | n/a |
| resolver match + log field | reader | `audienceResolution.ts:186-189, 245` | IN-PLAN (4.2) |
| estimate / preview / no-body send | reader | `broadcasts.ts:938, 1039-1042, 781, 1285` | IN-PLAN (4.2 via resolver; pinned 4.3) |
| `wireAudienceFilter` -> create echo, results, list | reader | `blastAudienceRules.ts:206-234`; `broadcasts.ts:987, 450, 480` | IN-PLAN (4.3) |
| dashboard summary / draft key / composer / types / endpoint comment | reader | `broadcastFormat.ts:68`, `useComposerDraft.ts:108`, `BroadcastComposer.tsx:298`, `AudienceFilters.tsx:175`, `types.ts:3280`, `endpoints.ts:1984` | IN-PLAN (4.5, 4.6) |
| fan-out job, units, today, timeline, analytics, exports | reader | none read the filter | n/a |
| over-cap 400 copy "bedroom-size filter" | copy | `broadcasts.ts:1324` | unchanged (still accurate) |

(d) Seed outputs: Task 3.3 (cast) and Task 4.4 (matrix) are FULL-profile only
(`seed/index.ts:126-133`); lean (`SEED`, no broadcasts table) is unchanged
by both; lean stability = by construction + COUNT pin
(`seedProfile.integration.test.ts:100-104`) + S3's new lean PIN + Task 3.3's
`git diff --exit-code 1d7a4667`. IN-PLAN (R2-F7 optional check for 4.4).
Unit requirement keys / `requirement_sources` from S3: Apply (3.2) and the
PM unit seed (3.3) - IN-PLAN (R2-F1 on the seed's missing `updated_at`).
