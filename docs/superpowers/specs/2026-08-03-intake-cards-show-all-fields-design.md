# Intake cards show every field, blanks included

Date: 2026-08-03
Status: APPROVED (Cameron, 2026-08-03) - ready for implementation
Branch: feat/intake-cards-show-all-fields (worktree w:/tmp/intake-cards, cut from main 16ff056f)

## 1. Context and the decision

The contact Details pane carries two structured-intake cards, one per contact type:

- **"Landlord onboarding"** (`dashboard/src/routes/contact/LandlordOnboardingCard.tsx`) -
  the checklist a navigator works through on the ~10-minute landlord onboarding call:
  contract status plus four Yes/No approval criteria.
- **"Eligibility intake"** (`dashboard/src/routes/contact/EligibilityIntakeCard.tsx`) -
  the tenant sibling: pets, evictions, time at current address, LIF eligibility,
  voucher expiration.

Both cards today render **only the fields that hold a recorded value**, and render
**nothing at all** when none do. That was a deliberate anti-clutter choice at build
time (2026-07-01), and for a card of incidental facts it would be defensible.

It is the wrong default for these two cards, because both are **checklists a human
works through on a call**. When a row is missing, staff cannot tell the difference
between:

- the question was asked and the answer is recorded elsewhere / not applicable, and
- **nobody has asked this yet.**

A half-finished onboarding call renders identically to a complete one. The absence of
an answer is real, actionable information, and hiding it makes the gap invisible at
exactly the moment it is most useful.

**Decision: both cards always render, with every field always present. A field with
no recorded value shows the em dash placeholder.**

### Placeholder character

The dashboard-wide placeholder for a missing value is the **em dash, U+2014**. This is
not a new convention - it is what the Details card on the very same page already uses
for a missing company, phone list, or status (`LandlordFile.tsx`, `TenantFile.tsx`,
`UnknownFile.tsx`), and what the listing detail page uses for every unset unit field.

The single documented exception is the Settings numbers table, which uses an ASCII
`-` under spec adjudication A10 and carries an explicit source comment saying the
em-dash placeholder is deliberately not used there. That exception stays untouched.

Note that the em dash is the **placeholder** convention only. Inline **separators**
(the ` - ` between phone numbers, or before the "Manage" action) are ASCII everywhere
in the contact files and stay ASCII.

## 2. Changes

### 2.1 LandlordOnboardingCard

Always renders on a landlord file. Return type goes
`React.JSX.Element | null` -> `React.JSX.Element`. Rows, in order:

| Row | Recorded | Not recorded |
| --- | --- | --- |
| Contract status | `Signed` / `Unsigned` | em dash |
| Registered landlord (info hint) | `Yes` / `No` | em dash |
| Submits RTA within 48h (info hint) | `Yes` / `No` | em dash |
| Passes inspection first try (info hint) | `Yes` / `No` | em dash |
| Voucher counts as income (info hint) | `Yes` / `No` | em dash |
| Park reason | the stored reason | em dash |

The info hints (`LANDLORD_ONBOARDING_HINTS`) stay attached to the four criteria rows
whether or not a value is recorded - an unanswered question is precisely when a
navigator most needs to know what it means.

**Park reason keeps its status condition.** The row appears only when
`status === 'parked'`. It is not a checklist item; it is status-scoped, and a permanent
blank "Park reason" on an active landlord would be noise rather than a gap. But
**within** the parked state it follows the new rule: a landlord who is parked with no
reason recorded is itself a gap, so the row appears reading the em dash instead of
vanishing. (Today a stale `park_reason` on a non-parked landlord is correctly hidden;
that behavior is unchanged.)

### 2.2 EligibilityIntakeCard

Always renders on a tenant file. Return type goes
`React.JSX.Element | null` -> `React.JSX.Element`. Rows, in order:

| Row | Recorded | Not recorded |
| --- | --- | --- |
| Pets | the stored text | em dash |
| Evictions | the stored text | em dash |
| Time at current address | the stored text | em dash |
| LIF eligible | `Yes` / `No` | em dash |
| Voucher expires | e.g. `Aug 15, 2026` | em dash |

An empty-string field stays "not recorded" and reads as the em dash - the existing
falsy check is retained, only its consequence changes from "omit the row" to "show the
placeholder". An **unparseable** `voucher_expiration_date` also reads as the em dash;
today it silently drops the row, which is the same information-hiding bug in miniature.

AutoBadge provenance stamps and suggestion chips are unaffected in their own logic:
a badge still renders only where an AI-sourced value exists, and a chip still renders
only where a pending suggestion targets that field.

### 2.3 Bug closed: intake-card-hides-pending-suggestions

`docs/issues/intake-card-hides-pending-suggestions.md` (bug, low, open, filed
2026-07-21) reports that a pending AI suggestion on an otherwise-empty tenant is
invisible inline: the suggestion exists in the store and counts on the Today page, but
the contact page shows no card and no chip.

The mechanism is exactly the one this spec removes. Chips are rendered **per row**
(`r.field ? chipFor(r.field) : null`), and rows exist only for recorded fields - so a
suggestion for `evictions` on a tenant with no intake data has no row to attach to.

Always-present rows fix this structurally, and more completely than the fix shape the
issue proposed ("render the card when EITHER intake content exists OR a pending
suggestion targets one of its fields") - that shape would surface the card but would
still need per-row special-casing for the suggested field. **Close the issue as
resolved as part of this change,** noting that the fix landed as the general
always-render rule rather than the narrower conditional.

### 2.4 PartnerFile placeholder drift

`dashboard/src/routes/contact/PartnerFile.tsx` renders an ASCII `-` for a missing phone
list (line 57) and a missing status (line 69), where every other contact file uses the
em dash. This is unintentional drift, not a Settings-style deliberate exception - the
Partner file is a contact file and sits beside the others. Change both placeholders to
the em dash.

Scope note: **only those two placeholder values change.** The ` - ` phone-list join
(line 36) and the ` - ` separator before the "Manage" action (line 60) are separators,
match `LandlordFile.tsx` exactly, and stay ASCII. The file's ASCII prose comments are
left alone.

## 3. Call sites

Neither card needs a caller change: `LandlordFile.tsx` and `TenantFile.tsx` already
render them unconditionally. Narrowing the return type from
`React.JSX.Element | null` is source-compatible for both.

## 4. Testing

**Unit tests.** In each card's spec, the cases that pin today's hide-when-empty
behavior invert rather than disappear - they keep testing the same inputs and assert
the new output:

`LandlordOnboardingCard.test.tsx`
- `omits fields that are unset` -> asserts that with only `registered_landlord` set,
  the other four labels are all present and their values read as the em dash.
- `renders nothing when no onboarding data is recorded` -> asserts the card renders
  with all five checklist rows present, every value an em dash, and no Park reason row.
- New: a `parked` landlord with no `park_reason` shows the Park reason row as an
  em dash.
- Unchanged: the recorded-values case, the `Unsigned` case, and both Park-reason
  status cases.

`EligibilityIntakeCard.test.tsx`
- `omits fields that are empty/undefined` -> asserts the other labels are present with
  em-dash values.
- `renders nothing when no intake is recorded` -> asserts all five rows render as
  em dashes.
- `treats an empty-string field as not recorded` -> asserts empty strings render as
  em dashes (still "not recorded", now visible).
- `omits the "Voucher expires" row when unset or unparseable` -> renamed; asserts the
  row renders as an em dash for an unparseable date.
- New (regression pin for the closed issue): a contact with **no** intake fields but a
  pending `evictions` suggestion renders the card, the Evictions row, and its
  suggestion chip.

**E2E.** Sweep `e2e/tests/scenarios/landlord-onboarding.spec.ts` and the
fact-extraction specs for assertions that depend on a card or row being **absent**
(`not.toBeVisible`, `toHaveCount(0)`, negative `getByText` on an intake label). Any
such assertion that was passing only because the row was hidden must be re-pinned
against the em-dash value.

**Gates.** `npm run typecheck` plus the dashboard unit suite per the small-fix lane,
then live self-QA in the Playwright harness on all three contact types - a landlord
with partial onboarding data, a fresh tenant with none, and a partner - confirming the
cards appear, the blanks read as em dashes, and the layout does not break with five
placeholder rows. Full `npm run e2e` at the checkpoint.

## 5. Out of scope

- The `landlord-onboarding-record-fields` schema decision (resolved 2026-07-01); no
  new fields, no API or validation change. This is a rendering-policy change only.
- Any styling change to the placeholder (no muting, no dedicated class) - it renders as
  plain text in the `KV` value slot, exactly like the Details card's placeholders.
- The Settings numbers table's ASCII-dash exception.
- `PartnerFile.tsx` beyond the two placeholder characters.
