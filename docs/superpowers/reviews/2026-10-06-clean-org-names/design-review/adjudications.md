# Spec design review - adjudications

Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`.
Planner: the feature-mission planner session (Claude Opus 5.5).

Legend: ACCEPT (spec edited) / REJECT (reason given) / DEFER (filed or left
for a later stage). "Decision changed" = the accepted finding altered what
gets built, added or removed a surface, or moved an invariant.

## Round 1 (spec @e78345f6; reviewers A and B in parallel)

Reviewer reports: `spec-r1-reviewer-a.md` (17 findings),
`spec-r1-reviewer-b.md` (21 findings). Both overlap heavily; findings are
adjudicated by theme, each tagged with the reviewer finding numbers it covers.

| # | Theme (findings) | Ruling | Resulting change | Decision changed |
|---|---|---|---|---|
| T1 | Non-tenant contacts hold `housingAuthority`/`agency` (A1, B4) | ACCEPT | I1, counts, rename/merge rewrites, delete/kind gates and the cleanup cover EVERY contact type; branch B migrates a converted partner's values into `organization` | yes |
| T2 | Off-list values are unreachable and invisible; "uses" undefined; D7 premise false (B1, B8, A11, A13) | ACCEPT | "uses" = exact stored text equals the entry's name; NEW Settings section "Not on the list" lists every distinct stored value that is not exactly a name, with counts and admin actions (Use a name, Move to Agency, Add as new, Clear, Show records); D7 rewritten | yes |
| T3 | Cleanup decisions sheet vs in-app settling | ACCEPT (follows T2) | the cleanup script applies automatic mappings only; its dry run lists the values it will leave (value + count, no people); the decisions CSV is REMOVED; leftovers are settled in the "Not on the list" view | yes |
| T4 | Suggestion accept cannot carry the dialog outcome (B2, A10) | ACCEPT | accept takes an optional `value` (housing authority suggestions only), D5-checked in plan building BEFORE the claim, stored in the replay plan; verdict `accepted` when the value is the suggestion's own resolution or one of its ambiguity candidates or a name just added from its text; a DIFFERENT name goes through the contact edit (verdict `superseded_by_human_edit`, as today); an agency-name suggestion is dismissed | yes |
| T5 | Rename/merge job: no lock, no recovery, sent-blast rewrite, merged spellings, GSI staleness (B3, A7) | ACCEPT | one rewrite at a time; list change + `lastRewrite: running` in one conditional write, then enqueue (enqueue failure -> failed); failed or stalled (> 15 min) shows "Run again"; the job reads base tables (all contact types, deleted included), rewrites by normalized match on a set of from-texts, de-duplicates unit lists, never touches broadcasts; merge transfers the merged entry's name and spellings as spellings of the target | yes |
| T6 | 60 s per-process cache: no cross-process or reseed invalidation (B5, A5) | ACCEPT | NO in-process cache; every read is one consistent GetItem of the small item | yes |
| T7 | List-driven prompt breaks fingerprint, driver interface, drop reasons, ASCII rule (B6, A6) | ACCEPT | the system prompt stays a static template (fingerprint mechanism unchanged); the list rides in the USER content as a block passed through the extraction input; each run records the list `version`; new drop reason `agency_not_authority` with its dashboard label | yes |
| T8 | Draft blasts: wrong field name, no PATCH writer, never cleaned (B7, A3) | ACCEPT | field is `audience_filter.housing_authority`, written only by POST; rename/merge/cleanup never rewrite broadcasts; preview and send re-check a stored filter and refuse an off-list value with 422 `org_not_on_list` so the composer asks for a new pick; seeds' broadcast filters use list names | yes |
| T9 | Soft-deleted records and restore routes (A4) | ACCEPT | rewrites and the cleanup include soft-deleted contacts and units; delete/kind gates count them; restore needs no check because deleted records were rewritten too | yes |
| T10 | Spelling governance (B10, A8) | ACCEPT | non-admin add takes name + notes only; admin spelling edits refused when a spelling equals any name; adding a spelling another entry already has is allowed only with an explicit confirm ("now shared - no longer applied automatically"); renamed and merged names become spellings (added to D12's sources); a rename's new name must not equal another entry's name or spelling | yes |
| T11 | Pickers with an off-list current value; property form sends the whole list (B9, A9) | ACCEPT | D5 checks only values being SET that differ from what the record holds (scalar: only when changed; property list: only new members; a member equal to the unit's legacy `jurisdiction` passes); pickers show an off-list current value as a removable "Not on the list" chip | yes |
| T12 | Importer: unit-side write misdescribed; `updated_at` ownership; fill-only semantics (B13, A2) | ACCEPT | 1.2 corrected; the importer's unit ownership rule is unchanged (values resolved through D4); machine writers (cleanup, rewrite job) never stamp `updated_at` on units; importer contact writes use `if_not_exists` (a staff REMOVE of housing authority may be re-filled by a re-import - stated, accepted) and agency is written only when absent | yes |
| T13 | Clearing housing authority is not exempt from D5 (B14, A15) | ACCEPT | `''` clears (housing authority REMOVE - GSI key, never SET `''`; agency keeps today's `''`); scripts and jobs REMOVE | no (precision) |
| T14 | Ambiguity scope and compound values (B15) | ACCEPT | ambiguity counted within the kind(s) the field accepts; compound values are never stored as spellings | no (precision) |
| T15 | Appendix A duplicates under normalization; underscore (B16) | ACCEPT | normalizer folds `_`; Appendix A de-duplicated; the store de-duplicates spellings per entry on write | no (precision) |
| T16 | Item size claim false with 2000-char notes (B17, A14) | ACCEPT | notes <= 500 chars; <= 20 spellings per entry, <= 100 chars each; a write that would exceed 300 KB is refused `org_list_full` | no (precision) |
| T17 | Spec does not stand alone: "D2 script", "(pending Sam)", fulton slug, wrong precedent citation, dev/prod list divergence (B18, B19, A17) | ACCEPT | script file named; Appendix A must be final before the plan is written (section 13 answers); `fulton_housing` mapping defined by section 13 item 1; read-and-bump precedent cited (`conversationsRepo.ts`, `unitsRepo.ts`); no environment holds the item before A deploys, so dev and prod get the same list | no (precision) |
| T18 | Missed-call intake auto-text re-arms when an agency moves out of the authority field (B20, A16) | ACCEPT | `agency` counts as an intake fact in the missed-call check; clearing a junk value leaves a genuinely blank contact (stated) | yes (reader rule) |
| T19 | Branch B: role-less partners, canonical kind, importer re-types, composer search, other mint sites, placements/tours (B11, B12, A12) | ACCEPT (mostly) | Possible caseworkers also lists role-less partners and tenant/landlord custom kinds whose role says caseworker; `canonicalSuggestedContactKind` learns the Caseworker preset; staff type changes stamp `type_source: manual` and the importer keeps such a type; composer recipient search stays tenant-only (D18 wording fixed: a partner starts a send from its own page); the public intake mint site is a stated exception owned by tracker #13; Make caseworker is refused while the contact has an open placement or an upcoming or unresolved tour | yes |
| T20 | Tenant free-text `caseworker` attribute (B21) | REJECT | out of scope: nothing writes it except the lean seed, and it is display-only on tour and placement pages; added to the non-goals so a builder does not touch it | no |

Counts: 38 findings; 37 accepted (in 19 themes), 1 rejected (T20).
Decisions changed this round: yes (T1-T12, T18, T19) - round 2 is required.
Round 2 continues reviewer B (more accepted findings: 20 vs 17), handed
reviewer A's report.

## Round 2 (spec revision 2 @28243656; reviewer B continued, handed reviewer A's report)

Reviewer report: `spec-r2-reviewer-b.md` (16 findings). It conceded the one
round-1 rejection (T20) and reopened none.

| # | Finding | Ruling | Resulting change | Decision changed |
|---|---|---|---|---|
| R2-1 | "Uses", "Not on the list" and the D7 re-check ignore the field's kind | ACCEPT | D3 defines "on the list" per field kind; wrong-kind exact names are listed (resolution "the other kind") and are not uses; D7 and I1 use the per-kind rule | yes (invariant definition) |
| R2-2 | "Show records" reaches only active tenants' housing authority values | ACCEPT | a row expands into its holding records (contact name, type, deleted marker, or property address, each linked); records whose page lacks the field are settled with value-level actions | yes (new surface) |
| R2-3 | Accept `value` checked only against the list | ACCEPT | server refuses a value outside the text's D4 resolution or its ambiguity candidates (422 `value_not_from_suggestion`); a re-accept with a different value answers 409 `suggestion_already_resolved` | no (guard on D8) |
| R2-4 | (B) Importer writes a status for its own type after a manual retype; re-fills the removed authority | ACCEPT | for `type_source: 'manual'` the importer writes none of type, status, housing authority, agency; "mirroring its status rule" wording removed (a NEW field, contacts without it import as today) | no (B rule precision) |
| R2-5 | Automatic spelling additions: caps, name collision, compound test, people's names, cross-kind sharing | ACCEPT | D4 defines COMPOUND; cross-kind sharing refused; automatic additions SKIP (never fail on) a rule-breaking spelling and report it; Use shows the value with "Remember this spelling" | no (rule precision) |
| R2-6 | "Not on the list" GET admin-only though visible to all | ACCEPT | viewing is for everyone; actions stay admin | no |
| R2-7 | D15 omits the Templates hint that mirrors the intake rule | ACCEPT | hint and its test change with D15; added to readers | no |
| R2-8 | Send-time re-check guards a filter the dashboard's send never uses | ACCEPT | re-check at preview and on a filter-resolved send only; 1.2 corrected | no |
| R2-9 | Per-run list `version` is not recoverable | ACCEPT | run log records `orgListFingerprint` (hash of the rendered block) | no |
| R2-10 | No AI list block budget; names uncapped | ACCEPT | block budget 16,000 chars (spellings dropped first, WARN); names <= 120 chars | no |
| R2-11 | Create-on-first-read races the reseed window | ACCEPT | seeds write the item with an unconditional put | no |
| R2-12 | Cleanup ignores the rewrite lock | ACCEPT | the cleanup apply takes the D11 lock (action `cleanup`) | no |
| R2-13 | No "Move to Housing authority" for agency-field authority names | ACCEPT | symmetric admin action added | yes (new action) |
| R2-14 | Rewrite job writes no per-record audit | ACCEPT | `org_name_rewrite` audit event per record | no |
| R2-15 | (B) Make caseworker on landlord-based kinds ignores unit ownership | ACCEPT | also refused while the contact is a landlord of record or on a unit roster | no (precondition) |
| R2-16 | (B) Thread re-typing reaches only the primary phone and emails | ACCEPT | re-typing covers every phone in `phones` and every email | no (precision) |

Counts: 16 findings, 16 accepted, 0 rejected.
Decisions changed this round: yes (R2-1, R2-2, R2-13) - round 3 is required
(cap: 4).

## Round 3 (spec revision 3 @bfec445a; reviewer B continued)

Reviewer report: `spec-r3-reviewer-b.md` (7 findings). No adjudication
contested.

| # | Finding | Ruling | Resulting change | Decision changed |
|---|---|---|---|---|
| R3-1 | COMPOUND test, read literally, makes every value holding a shared spelling compound (incl. "Atlanta (AHA)") | ACCEPT | exact equality decided first and never compound; compound = two or more non-overlapping longest-first spans with no single entry matched by every span; worked examples; plan tests every Appendix A row | no (corrects R2-5's definition to its intent) |
| R3-2 | D12's "skip a spelling another entry carries" breaks merge's "shared stays shared" | ACCEPT | merge transfers ALL spellings (the target replaces the merged carrier); D12's skip rules exempt the merge transfer; a merge that would break a cap is refused 409 `org_spellings_full` | no (precision) |
| R3-3 | Cleanup takes the lock, but "Run again" assumes a re-enqueueable job | ACCEPT | no "Run again" for action `cleanup`; the script releases the lock on abort/failure; a hard-killed lock goes stale after 15 minutes; RUNBOOK names the wait | no (precision) |
| R3-4 | Compound values have no settling action keeping both halves | ACCEPT | new admin action **Split into <housing authority> + <agency>** (agency set where absent or `''`, conflicts counted) | yes (new action) |
| R3-5 | (B) `type_source` stamped on every staff type change, triage included | ACCEPT | stamped only when staff OVERRIDE an existing tenant/landlord/partner type, and by Make caseworker; triage from `unknown` does not stamp | no (precision) |
| R3-6 | No way to create off-list values in e2e; shared seeds would leak between specs | ACCEPT | dev-only `POST /__dev/org-fixture` writes run-unique off-list values onto spec-created records; nothing off-list seeded into the lean world | no (test seam) |
| R3-7 | List-block budget has no rule when names exceed it | ACCEPT | over budget: drop spellings, then agency names, then housing authority names that do not fit (WARN with counts) | no (precision) |

Counts: 7 findings, 7 accepted, 0 rejected.
Decisions changed this round: yes (R3-4 only) - round 4, the last allowed
under the 4-round cap, follows. If round 4 still changes a decision, the
design goes to Cameron as a decision with the open findings.

## Round 4 (spec revision 4 @ccf74ebd; reviewer B continued) - TERMINAL

Reviewer report: `spec-r4-reviewer-b.md` (7 findings, all LOW, all labelled
precision by the reviewer; #5 "decision if triage is to be protected").

| # | Finding | Ruling | Resulting change | Decision changed |
|---|---|---|---|---|
| R4-1 | `lastRewrite` cannot re-run a Split's agency half | ACCEPT | `lastRewrite` stores `agencyName` and the target `field` | no |
| R4-2 | Split only for contact housing authority values | ACCEPT | stated: compound property-list members and compound agency values are settled with Use / Clear or record by record | no |
| R4-3 | Names 120 chars, spellings 100: long names can never be merged | ACCEPT | spelling cap raised to 120 (the name limit) | no |
| R4-4 | Compound text refused as a spelling but accepted as a name | ACCEPT | compound text refused as a new name too (add, Add as new, rename), pointing to Split | no |
| R4-5 | (B) Unstamped triage is still reverted by a re-import | ACCEPT as statement; protection NOT added | D21 states triage of `unknown` is not protected (pre-existing importer behavior; prod re-import unknown); filed as a section-12 follow-up. Protecting triage would stop the importer filling fields for every triaged contact (the round-3 concern) - not changed here | no |
| R4-6 | D9 cites D20 for the importer type rule | ACCEPT | now D21 | no |
| R4-7 | Deleted-only users show zero uses yet block delete | ACCEPT | rows show "+N deleted"; the 409 says how many deleted records hold the name | no |

Counts: 7 findings, 7 accepted (R4-5 as a statement), 0 rejected.
Decisions changed this round: NONE. Round 4 is the terminal round; the
review is closed at spec revision 5.

## Totals

| Round | Reviewer(s) | Findings | Accepted | Rejected | Decisions changed |
|---|---|---|---|---|---|
| 1 | A + B | 38 | 37 | 1 (T20) | yes |
| 2 | B | 16 | 16 | 0 | yes (3) |
| 3 | B | 7 | 7 | 0 | yes (1) |
| 4 | B | 7 | 7 | 0 | no - terminal |

The only rejection: T20 (the tenant's free-text `caseworker` attribute) -
out of scope; written only by the lean seed and display-only on tour and
placement pages; added to the non-goals. The reviewer conceded it in round 2.

## Spec gate

APPROVED by Cameron on 2026-10-06 at spec revision 5 (@9633b7e4): "Reviewed
and Approved". Sam's answers to spec section 13 are pending (Cameron's
meeting); they change only Appendix A and the `fulton_housing` seed mapping,
and are folded into the spec and the plan's starting-list task before the
launch gate.
