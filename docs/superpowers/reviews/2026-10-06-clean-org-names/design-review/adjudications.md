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
