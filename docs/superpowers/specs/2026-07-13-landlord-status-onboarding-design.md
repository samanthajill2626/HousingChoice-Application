<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-13).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Landlord lead lifecycle: add 'onboarding'; tag-as-landlord lands 'interested'

Date: 2026-07-13
Status: APPROVED (Cameron, 2026-07-13) - ready for implementation
Branch: feat/landlord-status-onboarding (worktree w:/tmp/landlord-status, cut from main 2884016)

## 1. Context and decisions

Today, resolving a contact's identity to landlord (inbox triage, or a plain
re-type) auto-sets their landlord status to 'active'. Under the sales reality
that is wrong twice over: a freshly identified landlord is a LEAD, and
'active' is supposed to mean "their properties are onboarded".

Cameron's decisions (2026-07-13):
- D1: Tagging/triaging a contact as landlord lands them at 'interested', not
  'active'.
- D2: NEW landlord status 'onboarding', between 'interested' and 'active':
  the landlord has been sold to and SIGNED a contract, and we are working to
  onboard their properties. 'active' keeps meaning onboarded.
- D3: Manual landlord CREATE also defaults to 'interested' (day-to-day manual
  creates are leads; an explicit status in the create body still wins; the
  M1.6 import will set statuses explicitly).
- D4: The re-type fallback branch (a PATCH type change with no conversation
  attached, where the stored status is invalid for the new type) also lands
  landlords at 'interested'.
- D5: Transitions stay MANUAL via the existing status menu - no enforced
  transition graph, no derivation from contract_status. Explicitly rejected
  alternatives: ordered graph (fights mis-set-status fixes), deriving
  'onboarding' from contract_status=signed (magic flip, optional data).

New lifecycle: needs_review -> interested -> onboarding -> active, with
terminal 'parked' reachable from ANY state (a signed landlord can still back
out; park_reason stays required on the move to parked - unchanged).

Naming note: 'onboarding' already exists as a TENANT status and as the
landlord vocabulary (LandlordOnboardingCard = the recorded deal terms), so
the name is consistent, and type-scoped allowlists mean zero collision.

## 2. Goals

- G1: LANDLORD_STATUSES = ['needs_review', 'interested', 'onboarding',
  'active', 'parked'] with label 'Onboarding'; settable everywhere landlord
  statuses are set today (generic contact PATCH + the transition route).
- G2: All three auto-status write sites produce the new defaults (section 4).
- G3: Dashboard renders/edits the new status wherever landlord statuses
  appear (menu, edit form, badges, labels).
- G4: Seeds showcase the new status; docs updated; gates green.

## 3. Non-goals

- NO enforced transition ordering for landlord statuses (D5).
- NO automation coupling 'onboarding' to contract_status or to units added;
  no nudges/deadlines for landlord onboarding (future features if ever).
- NO change to the tenant lifecycle, the 'parked' semantics/park_reason
  contract, the public capture front door (needs_review), or the
  LandlordOnboardingCard's fields.
- NO data migration: existing dev landlords keep their statuses (Cameron can
  hand-move any 'active' landlord that is really still a lead).
- No schema/GSI/infra (statuses are strings behind type-scoped allowlists).

## 4. Design

### S1. Model (app/src/lib/statusModel.ts)

- LANDLORD_STATUSES gains 'onboarding' between 'interested' and 'active';
  LANDLORD_STATUS_LABELS gains onboarding: 'Onboarding'.
- Update the lifecycle docstring (~lines 164-172): needs_review is the
  capture/triage front door; a lead worth pursuing is 'interested'; a SIGNED
  landlord whose properties we are bringing in is 'onboarding'; a landlord
  with onboarded properties is 'active'; 'parked' stays the terminal branch
  with park_reason.
- Landlord statuses take no part in derivation (unchanged); no override-set
  changes.

### S2. The three write sites (app/src/routes/contacts.ts)

- CREATE default (~line 709): `item.status = type==='tenant' ? 'onboarding'
  : type==='landlord' ? 'interested' : 'active'` (explicit status in the
  body still wins - unchanged behavior). Update the ~line 576 comment.
- AUTO-ADVANCE on conversation-driven triage (~line 1153): tenant ->
  'onboarding' (unchanged); landlord -> 'interested'. Update the comment
  block (~1141-1151), keeping the no-status_source-stamp rationale.
- RE-TYPE FALLBACK (~line 1169): make the default fully type-correct:
  unknown -> 'needs_review', tenant -> 'onboarding', landlord ->
  'interested', team_member -> 'active'.
  CORRECTION (review, 2026-07-13): the spec originally claimed this fixes a
  latent bug (the old else-arm could persist (tenant, 'active')). That claim
  was WRONG - convType is derived from the TARGET type, so a re-type to
  tenant/landlord always takes the auto-advance branch and the fallback's
  tenant/landlord arms are unreachable in old and new code alike (and an
  explicit invalid pair is rejected by parseTriageBody). The type-correct
  rewrite is DEFENSIVE hardening only; comments and tests state that
  honestly rather than claiming a regression fix.

### S3. Transition route (app/src/routes/statusTransition.ts)

- No code change expected: it validates against statusAllowlistFor(type), so
  'onboarding' becomes accepted automatically. VERIFY + add a test (landlord
  interested -> onboarding via the route; parked still requires park_reason).

### S4. Dashboard

- api/types.ts: mirror the LandlordStatus union + label map wherever they
  are declared (keep the hand-mirror sync comments).
- Status menu on the contact page (ContactDetail's landlord status control)
  and ContactEditForm's status select: pick up 'Onboarding' (if they build
  from the mirrored labels map, verify ordering shows onboarding between
  Interested and Active).
- StatusBadge / format.ts: label + tone for landlord 'onboarding' (reuse the
  existing tenant 'onboarding' tone for visual consistency).
- LandlordOnboardingCard: UNTOUCHED (its park_reason row keys off 'parked',
  which is unchanged).

### S5. Seeds

- history.ts landlord progression becomes needs_review -> interested ->
  onboarding -> active (parked branch unchanged from 'interested').
- One cast or matrix landlord parks at status 'onboarding' so the full
  profile showcases the status without hand-setting. Lean seed unchanged.
- Seed-coherence tests updated as needed.

### S6. Docs

- STATUS-MODEL.md landlord lifecycle section updated in the same change
  (living doc the model file cites). docs/issues/landlord-lead-status-and-
  park.md is HISTORICAL - do not retrofit it.

## 5. Edge notes

- E1: Explicit status ALWAYS wins over every auto-default (create body,
  PATCH with status, triage with status) - pin per site.
- E2: 'parked' from 'onboarding' must work (route + menu) with park_reason
  required - one test.
- E3: The tenant-side fallback fix (S2) must not disturb the
  conversation-driven tenant auto-advance (convType defined path) - the two
  branches are mutually exclusive; keep it that way.
- E4: Sweep for any hardcoded landlord status enumerations outside the two
  mirrored declarations (e.g. filter chips on a landlords list, e2e
  fixtures): rg -n "interested.*active|'parked'" over dashboard/src e2e -
  every enumeration must include 'onboarding' or derive from the labels map.
- E5: ASCII only in every touched line (incl. the 'Onboarding' label and all
  comments).

## 6. Testing and gates

- Unit (app): model allowlist/labels/order; the three write sites (triage
  lands interested; create defaults interested; explicit status wins; the
  re-type fallback maps all four types correctly incl. the (tenant,'active')
  regression pin); transition route accepts onboarding + park_reason still
  enforced from onboarding.
- Unit (dashboard): menu/select show Onboarding in lifecycle order; badge
  renders label+tone; mirrored types compile.
- E2E: landlord-onboarding.spec.ts - update the triage assertion (tagging a
  contact as landlord now shows 'Interested', not 'Active') and extend:
  move the landlord interested -> onboarding -> active via the UI status
  menu; verify the badge each step.
- Gates (bare, real exit codes, from the worktree): npm run typecheck +
  npm test + `timeout 1500 npm run e2e`, green on a base freshly merged
  with main (ONE sync at the end - the one-main-sync rule) before handback.
- Self-QA (live stack + Playwright MCP, full seed): triage an unknown
  contact to landlord in the inbox -> lands Interested; walk one landlord
  Interested -> Onboarding -> Active in the status menu; park an Onboarding
  landlord (reason prompt appears).

## 7. Post-merge

Nothing required (no deps, no schema, no infra). Dev-stack restart picks it
up; existing dev landlord statuses untouched (hand-move any that should be
re-staged under the new semantics).
