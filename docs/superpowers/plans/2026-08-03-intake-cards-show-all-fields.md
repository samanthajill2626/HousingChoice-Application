<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-04).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Intake cards show every field, blanks included - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two structured-intake cards on the contact Details pane render
every field always, showing an em-dash placeholder for anything not yet recorded, so
a half-finished intake call is visibly distinguishable from a complete one.

**Architecture:** Purely a rendering-policy change in three presentational React
components. Each card currently builds a `rows` array by conditionally pushing only
recorded fields, then returns `null` when the array is empty. Both become an
unconditional array literal where an unrecorded value maps to a shared `BLANK` token,
and both drop their `| null` return type. No schema, API, validation, or backend
change. A third component (PartnerFile) has its two ASCII-dash placeholders corrected
to the same token.

**Tech Stack:** React 19 + TypeScript (strict, `noUncheckedIndexedAccess`), Vitest +
@testing-library/react for unit tests, Playwright for e2e. Dashboard workspace is
`@housingchoice/dashboard`.

**Spec:** `docs/superpowers/specs/2026-08-03-intake-cards-show-all-fields-design.md`

## Global Constraints

- **Worktree:** all work happens in `w:/tmp/intake-cards` on branch
  `feat/intake-cards-show-all-fields`. Never move HEAD in the shared checkout at
  `w:/AI Projects/Housing Choice/HC Application`.
- **Placeholder character:** the em dash, Unicode U+2014. It is written ONCE in
  source, as the escape `'\u2014'` in the shared `BLANK` token, and referenced by name
  everywhere else (including tests). Do not type a literal em dash into any file -
  this repo has a documented PowerShell file-rewrite mojibake footgun, and the escape
  is immune to it.
- **Separators stay ASCII.** The ` - ` used to join phone numbers and to separate the
  "Manage" action is a SEPARATOR, not a placeholder. It is ASCII in every contact file
  and must stay ASCII. Only placeholder VALUES change.
- **This plan file and all docs stay pure ASCII** (repo convention). Verify with
  `tr -d '\11\12\15\40-\176' < <file> | wc -c` returning `0`.
- **Never edit files with PowerShell `Get-Content`/`-replace`/`Set-Content`.** Use the
  Edit tool.
- **Commit discipline:** run a bare `git status` as its OWN command before every
  commit, then commit by explicit pathspec (`git commit -F - -- <paths>`). A bare
  `git commit` takes the whole index, which may contain unrelated work.
- **Gate commands run bare**, never piped. Filter output afterwards if needed.

---

### Task 1: LandlordOnboardingCard renders every checklist row

**Files:**
- Modify: `dashboard/src/routes/contact/Card.tsx` (add the `BLANK` export)
- Modify: `dashboard/src/routes/contact/LandlordOnboardingCard.tsx`
- Test: `dashboard/src/routes/contact/LandlordOnboardingCard.test.tsx`

**Interfaces:**
- Produces: `export const BLANK: string` from
  `dashboard/src/routes/contact/Card.tsx` - the em-dash placeholder token, consumed by
  Task 2 and Task 3 and by both card test files.
- Produces: `LandlordOnboardingCard` returns `React.JSX.Element` (no longer
  `| null`). Props are unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the last two `it(...)` blocks in
`dashboard/src/routes/contact/LandlordOnboardingCard.test.tsx` (`omits fields that are
unset` and `renders nothing when no onboarding data is recorded`) with the three below,
and add the `BLANK` import to the top of the file.

Add to the imports at the top of the file:

```tsx
import { BLANK } from './Card.js';
```

Replacement tests:

```tsx
  it('renders unset fields as the blank placeholder instead of omitting them', () => {
    render(<LandlordOnboardingCard contact={{ registered_landlord: true }} />);
    expect(screen.getByText('Registered landlord')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    // The four unanswered rows are PRESENT, each reading the placeholder: a gap a
    // navigator can SEE, not a row that silently disappears.
    expect(screen.getByText('Contract status')).toBeInTheDocument();
    expect(screen.getByText('Submits RTA within 48h')).toBeInTheDocument();
    expect(screen.getByText('Passes inspection first try')).toBeInTheDocument();
    expect(screen.getByText('Voucher counts as income')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(4);
  });

  it('renders every checklist row as a blank when nothing is recorded', () => {
    render(<LandlordOnboardingCard contact={{}} />);
    expect(screen.getByText('Landlord onboarding')).toBeInTheDocument();
    expect(screen.getByText('Contract status')).toBeInTheDocument();
    expect(screen.getByText('Registered landlord')).toBeInTheDocument();
    expect(screen.getByText('Submits RTA within 48h')).toBeInTheDocument();
    expect(screen.getByText('Passes inspection first try')).toBeInTheDocument();
    expect(screen.getByText('Voucher counts as income')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(5);
    // Park reason is status-scoped, not a checklist item: absent when not parked.
    expect(screen.queryByText('Park reason')).not.toBeInTheDocument();
  });

  it('renders the Park reason row as a blank when parked with no reason recorded', () => {
    render(<LandlordOnboardingCard contact={{ status: 'parked' }} />);
    expect(screen.getByText('Park reason')).toBeInTheDocument();
    // Five checklist blanks + the parked-but-unexplained Park reason blank.
    expect(screen.getAllByText(BLANK)).toHaveLength(6);
  });
```

Leave the other four tests in the file exactly as they are: the recorded-values case,
the `Unsigned` case, and both Park-reason status cases all still describe correct
behavior and must keep passing unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd w:/tmp/intake-cards/dashboard && npx vitest run src/routes/contact/LandlordOnboardingCard.test.tsx`

Expected: FAIL. The `BLANK` import does not resolve yet (`Card.js` has no such export),
so the file fails to load and every test in it errors.

- [ ] **Step 3: Add the shared BLANK token**

In `dashboard/src/routes/contact/Card.tsx`, add this immediately above the existing
`KV` component's doc comment:

```tsx
/** The dashboard-wide placeholder for a value that is not recorded: an em dash
 *  (U+2014), written as an escape so no file-encoding round-trip can mangle it. The
 *  Settings numbers table is the ONE deliberate exception and uses an ASCII "-"
 *  (spec adjudication A10). */
export const BLANK = '\u2014';
```

- [ ] **Step 4: Make every row unconditional**

In `dashboard/src/routes/contact/LandlordOnboardingCard.tsx`:

Change the import to pull in `BLANK`:

```tsx
import { BLANK, Card, KV } from './Card.js';
```

Replace the `yesNo` helper so an unrecorded boolean reads as the placeholder:

```tsx
const yesNo = (v: boolean | undefined): string =>
  typeof v === 'boolean' ? (v ? 'Yes' : 'No') : BLANK;
```

Replace the whole component body (from `const rows` through the closing `}`) with:

```tsx
}: LandlordOnboardingCardProps): React.JSX.Element {
  // Every checklist row ALWAYS renders. An unanswered question reads as BLANK
  // rather than vanishing, so a half-finished onboarding call is visibly
  // different from a complete one.
  const rows: Array<{ k: string; v: string; hint?: string }> = [
    {
      k: 'Contract status',
      v: contact.contract_status
        ? contact.contract_status === 'signed'
          ? 'Signed'
          : 'Unsigned'
        : BLANK,
    },
    {
      k: 'Registered landlord',
      v: yesNo(contact.registered_landlord),
      hint: LANDLORD_ONBOARDING_HINTS.registered_landlord,
    },
    {
      k: 'Submits RTA within 48h',
      v: yesNo(contact.rta_within_48h),
      hint: LANDLORD_ONBOARDING_HINTS.rta_within_48h,
    },
    {
      k: 'Passes inspection first try',
      v: yesNo(contact.pass_inspection_first_try),
      hint: LANDLORD_ONBOARDING_HINTS.pass_inspection_first_try,
    },
    {
      k: 'Voucher counts as income',
      v: yesNo(contact.income_includes_voucher),
      hint: LANDLORD_ONBOARDING_HINTS.income_includes_voucher,
    },
  ];
  // The park reason is status-scoped, not a checklist item: it appears only when the
  // lead is actually parked. But a parked lead with no reason recorded IS a gap, so
  // within that state it follows the same rule and reads BLANK.
  if (contact.status === 'parked') {
    rows.push({ k: 'Park reason', v: contact.park_reason || BLANK });
  }

  return (
    <Card title="Landlord onboarding">
      {rows.map((r) => (
        <KV key={r.k} k={r.k} v={r.v} {...(r.hint !== undefined && { hint: r.hint })} />
      ))}
    </Card>
  );
}
```

Note the hints stay attached whether or not a value is recorded: an unanswered
question is exactly when a navigator most needs to know what it means.

- [ ] **Step 5: Update the file's header comment**

The comment at the top of `LandlordOnboardingCard.tsx` still claims the old behavior.
Replace lines 4-7 (from `onboarding call (contract status` through
`landlord's file. Mirrors EligibilityIntakeCard (the tenant sibling).`) with:

```tsx
// onboarding call (contract status and the four Yes/No criteria), plus a Park
// reason row shown only when the lead is `parked`. EVERY field always renders -
// an unrecorded one reads as BLANK - because this is a checklist worked through on
// a call, so "nobody has asked yet" must be visible rather than indistinguishable
// from "not applicable". Mirrors EligibilityIntakeCard (the tenant sibling).
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd w:/tmp/intake-cards/dashboard && npx vitest run src/routes/contact/LandlordOnboardingCard.test.tsx`

Expected: PASS, 7 tests.

- [ ] **Step 7: Typecheck**

Run: `cd w:/tmp/intake-cards && npm run typecheck`

Expected: exit 0. This gate is REQUIRED and separate - Vitest strips types without
checking them, so a green test run is not proof the types check.

- [ ] **Step 8: Commit**

Run a bare `git status` first, as its own command, then:

```bash
cd w:/tmp/intake-cards
git commit -F - -- dashboard/src/routes/contact/Card.tsx dashboard/src/routes/contact/LandlordOnboardingCard.tsx dashboard/src/routes/contact/LandlordOnboardingCard.test.tsx
```

with the message:

```
feat(dashboard): landlord onboarding card shows every field, blanks included

The card is a checklist worked through on the onboarding call, so a hidden
row made "nobody asked yet" indistinguishable from "not applicable". Every
row now always renders; unrecorded reads as the em-dash placeholder, newly
shared as BLANK in Card.tsx. Park reason stays status-scoped but reads
BLANK when a lead is parked with no reason recorded.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

---

### Task 2: EligibilityIntakeCard renders every intake row, unblocking its suggestion chips

**Files:**
- Modify: `dashboard/src/routes/contact/EligibilityIntakeCard.tsx`
- Test: `dashboard/src/routes/contact/EligibilityIntakeCard.test.tsx`
- Modify: `docs/issues/intake-card-hides-pending-suggestions.md`

**Interfaces:**
- Consumes: `BLANK` from `./Card.js` (Task 1).
- Produces: `EligibilityIntakeCard` returns `React.JSX.Element` (no longer `| null`).
  Props are unchanged.

This task also closes a filed bug. Chips are rendered PER ROW
(`r.field ? chipFor(r.field) : null`), and rows exist only for recorded fields - so a
pending AI suggestion for `evictions` on a tenant with no intake data has no row to
attach to and is invisible inline, even though it counts on the Today page.
Always-present rows fix that structurally.

- [ ] **Step 1: Write the failing tests**

In `dashboard/src/routes/contact/EligibilityIntakeCard.test.tsx`, add `BLANK` to the
imports:

```tsx
import { BLANK } from './Card.js';
```

Replace the three tests `omits the "Voucher expires" row when unset or unparseable`,
`omits fields that are empty/undefined`, `renders nothing when no intake is recorded`,
and `treats an empty-string field as not recorded` with these four:

```tsx
  it('renders the "Voucher expires" row as a blank when unparseable', () => {
    render(<EligibilityIntakeCard contact={{ voucher_expiration_date: 'not-a-date' }} />);
    expect(screen.getByText('Voucher expires')).toBeInTheDocument();
    // All five rows are blank: an unparseable date is no more "recorded" than an
    // absent one, but it must not silently drop the row.
    expect(screen.getAllByText(BLANK)).toHaveLength(5);
  });

  it('renders empty/undefined fields as blanks instead of omitting them', () => {
    render(<EligibilityIntakeCard contact={{ pets: '2 dogs' }} />);
    expect(screen.getByText('Pets')).toBeInTheDocument();
    expect(screen.getByText('2 dogs')).toBeInTheDocument();
    expect(screen.getByText('Evictions')).toBeInTheDocument();
    expect(screen.getByText('Time at current address')).toBeInTheDocument();
    expect(screen.getByText('LIF eligible')).toBeInTheDocument();
    expect(screen.getByText('Voucher expires')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(4);
  });

  it('renders every intake row as a blank when nothing is recorded', () => {
    render(<EligibilityIntakeCard contact={{}} />);
    expect(screen.getByText('Eligibility intake')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(5);
  });

  it('treats an empty-string field as not recorded, rendering it as a blank', () => {
    render(<EligibilityIntakeCard contact={{ pets: '', evictions: '' }} />);
    expect(screen.getByText('Pets')).toBeInTheDocument();
    expect(screen.getByText('Evictions')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(5);
  });
```

Then add this regression pin for the closed bug as the last test in the `describe`:

```tsx
  it('shows a pending suggestion chip on a contact with NO intake recorded (regression: intake-card-hides-pending-suggestions)', () => {
    render(
      <EligibilityIntakeCard
        contact={{}}
        suggestions={[
          {
            itemId: 'sug-1',
            ownerContactId: 'contact-tenant-0001',
            target: 'evictions',
            suggestedValue: 'one, 2019',
            conversationId: 'conv-1',
            createdAt: '2026-08-03T12:00:00.000Z',
          },
        ]}
      />,
    );
    // The card used to vanish entirely here, swallowing the chip with it: the
    // suggestion existed in the store and counted on Today, but staff could not
    // see or act on it from the contact page.
    expect(screen.getByText('Eligibility intake')).toBeInTheDocument();
    expect(screen.getByText('Evictions')).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'AI suggestion for evictions' }),
    ).toBeInTheDocument();
  });
```

Leave the first three tests (`renders recorded intake fields as label->value rows`,
the friendly-date case, and the `lifEligible is false` case) exactly as they are.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd w:/tmp/intake-cards/dashboard && npx vitest run src/routes/contact/EligibilityIntakeCard.test.tsx`

Expected: FAIL. The blank-row tests fail because the card still returns `null` or omits
rows (`Unable to find an element with the text: <em dash>`), and the regression test
fails because the card renders nothing at all for an empty contact.

- [ ] **Step 3: Make every row unconditional**

In `dashboard/src/routes/contact/EligibilityIntakeCard.tsx`, change the import:

```tsx
import { BLANK, Card, KV } from './Card.js';
```

Replace the block from `const rows: Array<...>` through `if (rows.length === 0) return null;`
with:

```tsx
  // Extractable intake rows carry a `field` + its AI provenance stamp so we can
  // attach an AutoBadge + a review chip; the derived rows (LIF, voucher expiry) do
  // not. EVERY row always renders - an unrecorded field reads as BLANK - so a gap in
  // the intake is visible, and so a pending suggestion always has a row to hang its
  // chip on (see intake-card-hides-pending-suggestions).
  const voucherExpires = contact.voucher_expiration_date
    ? friendlyDate(contact.voucher_expiration_date)
    : '';
  const rows: Array<{ k: string; v: string; field?: string; src?: FieldSource }> = [
    {
      k: 'Pets',
      v: contact.pets || BLANK,
      field: 'pets',
      ...(aiSource(contact.pets_source) && { src: aiSource(contact.pets_source) }),
    },
    {
      k: 'Evictions',
      v: contact.evictions || BLANK,
      field: 'evictions',
      ...(aiSource(contact.evictions_source) && { src: aiSource(contact.evictions_source) }),
    },
    {
      k: 'Time at current address',
      v: contact.tenure || BLANK,
      field: 'tenure',
      ...(aiSource(contact.tenure_source) && { src: aiSource(contact.tenure_source) }),
    },
    {
      k: 'LIF eligible',
      v: typeof contact.lifEligible === 'boolean' ? (contact.lifEligible ? 'Yes' : 'No') : BLANK,
    },
    { k: 'Voucher expires', v: voucherExpires || BLANK },
  ];
```

Note this MOVES the existing `voucherExpires` computation above the array (it currently
sits below the row pushes) and DELETES the `if (rows.length === 0) return null;` line
and the old `if (voucherExpires) rows.push(...)` line. Leave `friendlyDate`, `aiSource`,
and `chipFor` untouched.

Change the return type on the signature line:

```tsx
}: EligibilityIntakeCardProps): React.JSX.Element {
```

- [ ] **Step 4: Update the file's header comment**

Replace lines 4-5 of `EligibilityIntakeCard.tsx` (`// intake (pets, evictions, ...` through
`// intake without reopening the editor, without cluttering a fresh tenant's file.`)
with:

```tsx
// time at current address, LIF eligibility). EVERY field always renders - an
// unrecorded one reads as BLANK - so Team can SEE both what was captured and what
// is still missing, and so a pending suggestion always has a row to hang its chip on.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd w:/tmp/intake-cards/dashboard && npx vitest run src/routes/contact/EligibilityIntakeCard.test.tsx`

Expected: PASS, 8 tests.

- [ ] **Step 6: Close the issue**

In `docs/issues/intake-card-hides-pending-suggestions.md`, change the frontmatter
`status: open` to `status: resolved` and add `resolved: 2026-08-03` directly beneath it.
Then append this section to the end of the file:

```markdown
**Resolution (2026-08-03) - fixed by the general always-render rule.** Both
structured-intake cards now render EVERY field always, with an em-dash placeholder
for anything unrecorded, per
`docs/superpowers/specs/2026-08-03-intake-cards-show-all-fields-design.md`. Because
chips hang off rows, always-present rows mean a pending suggestion always has a row
to attach to. This supersedes the narrower fix shape proposed above ("render the card
when EITHER intake content exists OR a pending suggestion targets one of its fields"),
which would have surfaced the card but still needed per-row special-casing for the
suggested field. Human decision (Cameron, 2026-08-03) to resolve it this way. Pinned by
the `regression: intake-card-hides-pending-suggestions` case in
`dashboard/src/routes/contact/EligibilityIntakeCard.test.tsx`.
```

Verify the file is still pure ASCII:
`tr -d '\11\12\15\40-\176' < docs/issues/intake-card-hides-pending-suggestions.md | wc -c`
must print `0`.

- [ ] **Step 7: Typecheck**

Run: `cd w:/tmp/intake-cards && npm run typecheck`

Expected: exit 0.

- [ ] **Step 8: Commit**

Run a bare `git status` first, as its own command, then:

```bash
cd w:/tmp/intake-cards
git commit -F - -- dashboard/src/routes/contact/EligibilityIntakeCard.tsx dashboard/src/routes/contact/EligibilityIntakeCard.test.tsx docs/issues/intake-card-hides-pending-suggestions.md
```

with the message:

```
fix(dashboard): eligibility intake card shows every field, blanks included

Matches the landlord sibling: every intake row always renders, unrecorded
reads as BLANK. This also closes intake-card-hides-pending-suggestions -
chips are rendered per row, so a tenant with no intake data had no row for
a pending suggestion to attach to and the chip was invisible inline.

Closes: intake-card-hides-pending-suggestions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

---

### Task 3: PartnerFile placeholder drift

**Files:**
- Modify: `dashboard/src/routes/contact/PartnerFile.tsx:57,69`

**Interfaces:**
- Consumes: `BLANK` from `./Card.js` (Task 1).
- Produces: nothing new.

`PartnerFile` renders an ASCII `-` where every other contact file renders the em dash.
This is unintentional drift, not a Settings-style deliberate exception - a partner file
IS a contact file and sits beside the others.

- [ ] **Step 1: Change the import**

In `dashboard/src/routes/contact/PartnerFile.tsx`:

```tsx
import { BLANK, Card, CardAction, CardInlineAction, KV, NotesText, PendingPanel } from './Card.js';
```

- [ ] **Step 2: Fix the two placeholders**

Line 57, inside the "Phone numbers" `KV` value:

```tsx
              {phoneList || BLANK}
```

Line 69, the "Status" row:

```tsx
        <KV k="Status" v={contact.status ? contactStatusLabel(contact.type, contact.status) : BLANK} />
```

Change NOTHING else in this file. Specifically leave alone:
- line 36 `phones.map((p) => formatPhone(p.phone)).join(' - ')` - a separator, ASCII in
  `LandlordFile.tsx` too.
- line 60 `{' - '}` before the "Manage" action - a separator, ASCII in `LandlordFile.tsx` too.
- line 87 `'No preferences yet - added manually for now.'` - prose, not a placeholder.
- the file's ASCII prose comments.

- [ ] **Step 3: Verify no other ASCII-dash placeholder survives in the contact files**

Run: `cd w:/tmp/intake-cards/dashboard && npx tsc -p tsconfig.json --noEmit`

Expected: exit 0.

Then confirm the only remaining bare `'-'` values in `src/routes/contact/` are the two
separators:

Run: `cd w:/tmp/intake-cards/dashboard && grep -n "'-'" src/routes/contact/*.tsx`

Expected: only the ` - ` join/separator occurrences in `PartnerFile.tsx` (lines 36, 60)
and their `LandlordFile.tsx` / `TenantFile.tsx` / `UnknownFile.tsx` equivalents. No
placeholder `|| '-'` or `: '-'` remains.

- [ ] **Step 4: Run the dashboard unit suite**

Run: `cd w:/tmp/intake-cards/dashboard && npx vitest run`

Expected: PASS. `PartnerFile` has no dedicated spec; this confirms no other suite
asserted on its ASCII dash.

- [ ] **Step 5: Commit**

Run a bare `git status` first, as its own command, then:

```bash
cd w:/tmp/intake-cards
git commit -F - -- dashboard/src/routes/contact/PartnerFile.tsx
```

with the message:

```
fix(dashboard): partner file uses the em-dash placeholder like its siblings

PartnerFile rendered an ASCII "-" for a missing phone list and status where
every other contact file uses the em dash. Drift, not a deliberate
exception (that is the Settings numbers table, adjudication A10).
Separators stay ASCII.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

---

### Task 4: Full gates and live self-QA

**Files:** none modified unless a gate turns something up.

**Interfaces:**
- Consumes: Tasks 1-3 complete and committed.

The e2e sweep the spec called for has already been done during planning, and the
finding is that NO existing e2e assertion depends on a card or row being hidden - every
one is a positive `toBeVisible` on a label or value, and the one count-based assertion
(`e2e/scenarios/steps.ts:1253`) uses `getByText('Yes', { exact: true })`, which blanks
cannot perturb. So no spec edits are expected. This task VERIFIES that by running the
suite rather than assuming it.

- [ ] **Step 1: Full typecheck**

Run: `cd w:/tmp/intake-cards && npm run typecheck`

Expected: exit 0.

- [ ] **Step 2: Full unit suite**

Run: `cd w:/tmp/intake-cards && npm test`

Expected: exit 0 across all workspaces.

- [ ] **Step 3: Full e2e suite**

Run: `cd w:/tmp/intake-cards && npm run e2e`

Expected: exit 0. Requires Docker. The lane resolver hashes this worktree's gitdir, so
it picks its own lane automatically - do NOT set `E2E_LANE` unless the run reports a
collision. Run the command BARE; do not pipe it.

If a spec does fail, the likely cause is a strict-mode violation from a locator that
now matches more than one element (several rows in a card can read the same em dash).
Fix by scoping the locator to its row rather than by reverting the card behavior.

- [ ] **Step 4: Live self-QA in the harness**

Start the interactive stack: `cd w:/tmp/intake-cards && npm run e2e:session`

Then drive the dashboard with the Playwright MCP and confirm all four states. Log in
first via the dev-login button (an isolated browser profile starts logged out).

1. **Landlord with partial onboarding data** - open the seeded landlord
   (`contact-landlord-0001`). The "Landlord onboarding" card shows all five checklist
   rows; recorded ones show their values, any unrecorded show an em dash. The info
   icons still appear on all four criteria rows, including blank ones.
2. **Fresh landlord with nothing recorded** - create a new landlord through the UI. The
   card renders with five em-dash rows and NO "Park reason" row.
3. **Fresh tenant with no intake** - create or open a tenant with no intake recorded.
   The "Eligibility intake" card renders with five em-dash rows.
4. **Partner contact** - open a partner. The Details card's Phone numbers and Status
   rows render em dashes (not ASCII hyphens) when unset.

Take a screenshot of each card state. Name them with the `.playwright-mcp/` prefix
(e.g. `filename: ".playwright-mcp/landlord-onboarding-blanks.png"`) - a named
screenshot resolves against the repo ROOT, so an unprefixed name lands in the repo.

Confirm visually that a card of five placeholder rows does not look broken: rows are
evenly spaced, the em dash aligns with where values normally sit, and nothing overflows.

Stop the stack when done: `npm run e2e:stop`

- [ ] **Step 5: Sync with main and re-run the gates**

`main` moves fast and other work is landing on it in parallel.

```bash
cd w:/tmp/intake-cards
git fetch
git merge main
```

Resolve any conflicts keeping BOTH sides' intent. Then re-run the REQUIRED gates green
on the updated base - `npm run typecheck`, `npm test`, `npm run e2e` - each bare.

Do this ONCE, at the end. If the merge surfaces conflicts, stop and report rather than
resolving through anything non-obvious.

- [ ] **Step 6: Report, do not merge**

Do NOT merge this branch into `main` - that needs explicit human approval. Report:
the commits on the branch, the three gate results with their actual exit codes, the
screenshots from Step 4, and anything the e2e run turned up.

---

## Self-Review

**Spec coverage.** Spec 2.1 LandlordOnboardingCard -> Task 1. Spec 2.2
EligibilityIntakeCard -> Task 2 steps 1-5. Spec 2.3 issue closure -> Task 2 step 6.
Spec 2.4 PartnerFile -> Task 3. Spec 3 call sites -> no change needed (both callers
already render unconditionally; narrowing away `| null` is source-compatible), verified
by the typecheck gates. Spec 4 testing -> unit tests in Tasks 1-2, e2e sweep resolved
during planning and verified in Task 4 step 3, gates + live QA in Task 4. Spec 5 out of
scope -> no task touches the schema, adds placeholder styling, changes the Settings
numbers table, or edits PartnerFile beyond the two placeholders.

**Placeholder scan.** No TBD/TODO. Every code step carries real code. No "similar to
Task N" references - Task 2 and Task 3 each repeat the import line they need rather
than pointing at Task 1.

**Type consistency.** `BLANK` is declared in Task 1 step 3 and consumed under that
exact name in Tasks 1, 2, and 3 and in both test files. `yesNo` is widened to
`(v: boolean | undefined) => string` in Task 1 step 4, matching its new call sites which
pass possibly-undefined contact fields. `FieldSource` is already imported in
`EligibilityIntakeCard.tsx` and the rows array in Task 2 step 3 uses it under that name.
The `SuggestionItem` literal in Task 2 step 1 supplies exactly the six required fields
of that interface (`itemId`, `ownerContactId`, `target`, `suggestedValue`,
`conversationId`, `createdAt`), omits only the genuinely optional ones
(`currentValue`, `suggestedAddress`, `reason`, `tsMsgId`), and invents none. The chip's accessible name
`AI suggestion for evictions` matches `SUGGESTION_TARGET_LABEL.evictions === 'evictions'`
and the documented selector in `e2e/support/selectors.md`.
