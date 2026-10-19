# S3a - Dashboard first half (Tasks 3.1-3.4) - build report (feat/matching-blast-rules)

Implementer S3a (Claude Opus 5.5), 2026-10-18. Plan section 7, Tasks 3.1-3.4,
with binding rulings AR13, AR14, AR15, AR16 (orgList as a prop), AR21, AR43
and worklist rulings OR-S3-7 (lint) and OR-S3-8 (AR43 copy). OR-S3-1..6 are
S3b's (Tasks 3.5-3.6). Base 182c349c (S2 tip e2cbd2a8 + the worklist S2 -> S3
hand-down). Four task commits, then this report. Run logs (gitignored):
`.superpowers/sdd/S3a-*.log` / `S3a-*-eslint.json`.

## Commits

| Task | Commit | One-liner |
|---|---|---|
| 3.1 | 933737c7 | wire types (housing_authorities, TourHold, checkedByDefault, tourHolds, optional estimatedCount; AR15 transitional fields kept); audienceSummary joins a list |
| 3.2 | e80344f8 | tourHoldLabel; RecipientPreview follows the server checkedByDefault, tour tags, cue names, Add a tenant cues, seeds-only notice, truncation copy; `declineLabelsUnavailable` deleted |
| 3.3 | 004e4bab | AudienceFilters: "Housing authorities" multi-picker, caption, prefill notes, incomplete-list suffix, orgList prop; composer reads the list once; `AudienceFilter.housing_authority` deleted |
| 3.4 | b3480811 | prefillAuthorities (AR13 early return) |

## RED / GREEN evidence

- Baseline before 3.1: `src/routes/broadcasts` 14 files / 265 tests, exit 0
  (`S3a-baseline.log`). `git diff a2b3d80d 182c349c -- dashboard e2e` empty.
- 3.1 RED: 1 failed | 1 passed files; 2 failed / 73 passed (75) - both
  audienceSummary cases, `expected 'Tenants - 2-BR' to be 'Tenants - 2-BR -
  Atlanta'` (still reading the one string). GREEN 2 files 75/75; dashboard
  typecheck 0; eslint 0 on the 5 files.
- 3.2 RED: 2 failed | 1 passed files; 9 failed / 97 passed (106) - exactly
  the plan's nine names plus `Failed to resolve import "./tourHoldLabel.js"`.
  Reasons: `Plain` checked against a server false (client rule), checkbox
  names with tour cues not found, the option note carried one suffix, the
  seeds-only notice absent, the old truncation copy. GREEN 3 files 108/108;
  typecheck 0; eslint 0 on the 6 files.
- 3.3 RED: 2 failed | 1 passed files; 29 failed / 50 passed (79) - exactly
  the plan's 29 names (17 AudienceFilters, 12 BroadcastComposer): 19 x the
  "Housing authorities" combobox or label not found, 2 x no alert (the
  FAILED list prop was still ignored), 6 x caption / notes / suffix text not
  found, 1 x reach-line text content, 1 x last-call shape (the voucher chip
  dropped the list). No unhandled errors. GREEN 3 files 79/79
  (BroadcastComposer.prefill.test.tsx unchanged and green); typecheck 0;
  eslint exactly the 5 pre-existing errors (below).
- 3.4 RED: 1 file failed, no tests - `Failed to resolve import
  "./authorityPrefill.js"`. GREEN 6/6; typecheck 0; eslint 0.
- Slice end: the whole folder once, 16 files / 290 tests, exit 0
  (`S3a-end-folder.log`) = 265 + 1 broadcastFormat + 7 RecipientPreview
  (-2 deleted degraded-line tests, +9 new) + 9 AudienceFilters (17 -> 26) +
  2 tourHoldLabel + 6 authorityPrefill; BroadcastComposer stays 51, prefill 2.
- Root `npm run typecheck` (bare, redirected): EXIT=0, 0 `error TS`
  (`S3a-end-typecheck.log`).
- Lint, all 15 S3a-touched .ts/.tsx files in one run (`S3a-end-eslint.json`),
  severity-2 counted per rule id against R3's base JSON
  (`R3-lint-baseline.json`): BroadcastComposer.tsx
  react-hooks/set-state-in-effect 4 = base 4 (now :211/:236/:255/:277, the
  base :205/:230/:249/:271 statements shifted +6 by Task 3.3's import and
  orgList lines); useComposerDraft.ts react-hooks/refs 1 = base 1 (:140);
  every other file 0, the 4 new files clean, 0 warnings. NEW errors: 0.
  OR-S3-7's end state (3 errors) arrives with Task 3.5, which removes the
  composer's `setUnit(null)` and voucher effects.
- ASCII: `git diff -U0 | grep '^+' | grep -P '[^\x00-\x7F]'` printed nothing
  before each commit; the 4 new files and the rewritten
  AudienceFilters.test.tsx hold 0 non-ASCII bytes; `grep -cF '\u'` is 0 in
  every touched file (0 at base). Every touched file is LF
  (`git ls-files --eol`: `w/lf`).

## Deviations from the plan text

None in content. Proof: replaying plan lines 6590-9184 (Tasks 3.1-3.4: 64
Edit items, 5 Writes, 2 Appends) in memory over the base (a2b3d80d) copies
gives files byte-identical (`cmp`) to HEAD for all 16 touched files
(`S3a-self-replay.log`).

Process only: the plan's PowerShell lines ran as Git Bash equivalents with
absolute paths; the merge check used `git rev-parse --git-path MERGE_HEAD`
(clean before every commit); commit messages are the plan's, and 3.2's adds
one paragraph naming AR43 / OR-S3-8. The two appends were made with
`cat <scratch file> >> <target>` (see N2).

## Surprises / notes

- N1: in the Bash tool, `grep -c $'\r' FILE` counts EVERY line (the pattern
  arrives empty). Use `tr -cd '\015' < FILE | wc -c` or `git ls-files --eol`.
- N2: a heredoc whose body holds an apostrophe failed to parse in the Bash
  tool (`unexpected EOF while looking for matching`), so nothing ran (line
  count re-checked). A scratch file written with the Write tool plus
  `cat >>` works.
- N3: plan Task 3.5 item 13's new_string is prose ("the EMPTY string (delete
  the block).") with no code fence; a mechanical replayer must special-case
  it or it swallows item 14.
- N4: S3b anchors on the S3a tree: replaying plan lines 9185-10611 (Tasks
  3.5-3.6) in memory in order finds all 29 Edit items once each (R3's count)
  plus the 2 Appends (`S3a-s3b-anchor-replay.log`). The worklist rulings'
  own anchors are also unique: `    if (!hasBody) {` (useComposerDraft.ts:160),
  `  onOrgNotOnList?: () => void;` (:49), `    reachPending,` (:264),
  `  const [unitCandidates, setUnitCandidates] = useState<UnitItem[]>([]);`
  (BroadcastComposer.tsx); `  useEffect(() => {` still matches twice in
  useComposerDraft.ts, as OR-S3-1 warns. S3a changed useComposerDraft.ts at
  :95 only.
- N5: interim state until Task 3.5 (by design, plan 3.3 text): the composer
  still holds `filter` state and the voucher prefill effect; it prefills no
  authority; a 422 still clears the WHOLE authority list
  (`rejectAuthorityPick`, BroadcastComposer.tsx:136-143) with the old copy
  `That housing authority is no longer on the list - pick it again` (:62),
  which its existing tests pin. `orgList` is read once
  (BroadcastComposer.tsx:96-100) and passed to AudienceFilters (:549); the
  composer itself does not read it yet. The e2e suite is expected red on the
  new label until S4 (plan section 3).

## Contract S3a shipped (S3b consumes)

### Types - FINAL, equal to binding 2.7 (`dashboard/src/api/types.ts`)

- AR15: BOTH transitional fields are DELETED - `PreviewResponse.
  declineLabelsUnavailable?` by Task 3.2 (e80344f8),
  `AudienceFilter.housing_authority?` by Task 3.3 (004e4bab). Nothing is
  left for S3b to delete; no dashboard reader of either remains.
- `AudienceFilter` (:3271-3281): `{ contact_type: 'tenant';
  housing_authorities?: string[]; bedroomSize?: number }`.
- `TourHoldKind` (:3505) = `'needs_placement' | 'upcoming' | 'needs_outcome' |
  'not_marked' | 'no_show' | 'requested'`; `TourHold` (:3516) = `{ kind:
  TourHoldKind; tourId: string; at?: string }` (comments say MIRRORS the app).
- `PreviewCandidate` += `tourHold?: TourHold` (:3494), `checkedByDefault:
  boolean` (:3499, REQUIRED).
- `PreviewResponse` += `tourHolds: Array<{ contactId: string } & TourHold>`
  (:3547, REQUIRED), `audienceRulesUnavailable?: true` (:3551).
- `createBroadcast` (`dashboard/src/api/endpoints.ts:1989`) resolves `{
  broadcastId: string; status: 'draft'; estimatedCount?: number; truncated:
  boolean; flyerUrl?: string }` (:2001, :2008). The draft hook's
  `setReachCount(created.estimatedCount)` already takes undefined ("Reach
  estimate unavailable").
- `audienceSummary` (`broadcastFormat.ts:63`): `Tenants`, then the size
  label, then the non-blank authorities joined with `, `; an empty list adds
  nothing.

### AudienceFilters props (`AudienceFilters.tsx:48-90`)

`filter`, `onChange(next: AudienceFilter)`, `orgList: OrgListView`
(REQUIRED, new), `propertyVoucherSize?: number`, `unusedAuthorities?:
readonly string[]` (default `[]`), `noAuthorityMapped?: boolean` (default
false), `prefillNotices?: readonly string[]` (default `[]`), `reachCount?:
number`, `reachPending: boolean`, `truncated: boolean`, `authorityError?:
string | null` (the picker's role="alert" error; outranks the list-load
error), `onAuthorityTextChange?: (text: string) => void`, `disabled?:
boolean`.

- The component no longer calls `useOrgList`; the composer passes the list.
- `OrgPicker multiple`, label `Housing authorities` (:195), value
  `filter.housing_authorities ?? []`; a pick APPENDS, a chip removal removes;
  `onChange` emits `{ contact_type: 'tenant', housing_authorities?, bedroomSize? }`
  with `housing_authorities` OMITTED when empty; a voucher chip keeps the list.
- `unusedAuthorities` non-empty -> ONE plain `<p>` (class `matchNote`, no
  role) under the picker: `Not used (not on the organization list): ` +
  names joined `, ` + ` This blast is not limited by housing authority.`
  ONLY while `noAuthorityMapped` AND the list is empty (AR14, :211-217). With
  `unusedAuthorities` empty nothing renders, whatever `noAuthorityMapped` says.
- `prefillNotices` -> one plain `<p>` each (class `prefillNotice`, no role,
  React key = the text) under the picker (:218-222). The reach line stays the
  panel's only `role="status"`.
- Caption `<p className={styles.caption}>` under the always-excluded note
  (:241-245). Reach suffix inside the role="status" reach line (:258).
  Pending text unchanged: `Estimating reach` + U+2026 (:250) - match it with
  `/Estimating reach/`.

### RecipientPreview props - UNCHANGED (`RecipientPreview.tsx:80-99`)

`draftId`, `preview: PreviewResponse`, `tenantCandidates`,
`candidatesLoading`, `unitId?`, `resolvedFor?`, `now?` - the composer's call
site needs no change. It reads `preview.tourHolds` unconditionally and every
candidate's `checkedByDefault`: rows start at it (:123-145), Select all
re-applies `r.checkedByDefault` (:266), a promoted row and an added row take
`checkedByDefault = hasConsent` / `true` (:326, :355), an added tenant's hold
comes from `tourHolds` (:164-173, :331).

### Helpers

- `tourHoldLabel(hold: TourHold): string` (`tourHoldLabel.ts:8`); an unknown
  kind reads `Tour<d>`.
- `prefillAuthorities(propertyAuthorities: readonly string[], list:
  OrgListView): { names: string[]; unused: string[] }`
  (`authorityPrefill.ts:14`): `{ names: [], unused: [] }` while
  `orgListUnknown(list)` (AR13, :18); trims, skips blanks; maps through
  `settleTypedOrgText(list, HOUSING_AUTHORITY_KINDS, text)` (the exact name,
  the name in another case/spacing, or a spelling exactly one housing
  authority entry carries); `names` = entry names, property order,
  de-duplicated; `unused` = the trimmed texts that did not resolve,
  de-duplicated.

### Copy shipped (exact; every string ASCII)

- Picker label `Housing authorities`; placeholder `Any housing authority`.
- Caption: `Only tenants in Onboarding or Searching are included. Add any
  other tenant by hand when you review recipients.`; with a non-empty list
  the middle sentence `While a housing authority is selected, tenants whose
  housing authority is missing or not on the organization list are left
  out.` (single spaces).
- `Not used (not on the organization list): <a>, <b>` and the suffix
  ` This blast is not limited by housing authority.`
- Reach: `Reaches <n> recipient(s)` + ` - the list is incomplete` when
  truncated.
- Tour labels: `Tour <d>`, `Tour <d>, not marked`, `Toured <d>, needs
  outcome`, `Toured <d>, needs placement`, `No show <d>`, `Tour requested
  <d>, no date yet` (AR43); no `at` -> no date and no space (`Tour, not
  marked`, `Tour requested, no date yet`). `<d>` = `shortDate(at)`.
- Checkbox names: `<name> - consent not recorded` (no consent); else
  `<name>` + ` - ` + cues joined `, ` in order `already sent`, `not
  interested`, the tour label lower-cased (e.g. `Zia Both - already sent,
  not interested, tour requested oct 12, no date yet`).
- Add a tenant option note: `Not interested`, `Already sent`, the tour label
  as displayed, joined `, `.
- Seeds-only notice (role="status"): `Tour and Not interested labels
  couldn't be loaded.` (:531-535).
- Review truncation alert (role="alert"): `Too many tenants to read - some
  matches may be missing from this list.` (:699).
- Removed: `Couldn't load not-interested labels - ...`, `The audience hit the
  cap - ... Narrow the filter ...`, ` - list is capped; narrow the size or
  housing authority ...`.
- NOT in S3a (S3b, Task 3.5 / 3.6): the two prefill failure notices, the 422
  member-removed copy, the 503 copy + `Try again`, the picker empty states.
  AudienceFilters renders whatever `prefillNotices` / `authorityError` the
  composer passes; S3a's tests pass the 1.1 strings through it.

### Test fixtures S3b inherits

- RecipientPreview.test.tsx `candidate()` (:38) computes `checkedByDefault`
  from the flags unless the test passes it; `previewOf()` (:64) defaults
  `tourHolds: []`.
- BroadcastComposer.test.tsx: the preview fixtures carry `checkedByDefault:
  true` and `tourHolds: []` (:234, :491/:496, DEKALB_TENANT :820,
  previewOf :830); every label lookup is `Housing authorities`; both
  `draftAuthorities()` helpers read `audience_filter.housing_authorities`
  (string[]); the refused-create mock keys on `housing_authorities`.

## Not done

Tasks 3.5-3.6 (S3b). No root `npm test`, no e2e (per the brief). Final root
typecheck exit code: 0.
