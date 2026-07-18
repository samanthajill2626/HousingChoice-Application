# Group text numbers - admin visibility page (design)

Date: 2026-07-18
Branch: feat/pool-numbers-admin (cut from main @b4d0e8d)
Status: DRAFT for human review

## 1. Problem

The relay number pool has no operator surface. Pool-number records carry
everything an operator needs (lifecycle_state, burned_phones,
last_group_closed_at, released_at) and the byPoolNumber GSI gives each
number's full group history - but the only way to see any of it is the
DynamoDB console. Approaching launch, the operator cannot answer: how many
numbers do we hold, which are idle, which are approaching the 180-day
retire-eligibility, how burned is each number, what has each number been
used for.

## 2. Decisions (human, 2026-07-18)

1. Admin-only page (role admin; VAs never see it).
2. Table + expandable per-number group history (each group links to its
   existing thread).
3. Released numbers stay visible behind a filter (compliance provenance
   survives release); default view = active + releasing.

Adjudicated by the planner:

4. Staff-facing noun: "group text numbers" (code stays pool_number).
   GLOSSARY.md gains the noun in the same change.
5. Placement: an admin section of Settings (the established AdminRoute
   idiom used by Team/System), route /settings/numbers, nav entry
   "Group text numbers" beside the other admin sections.
6. Read-only page. No purchase/release actions - retirement remains the
   gated CLI sweep (npm run pool:retire). The page SHOWS eligibility so it
   never disagrees with the sweep.

## 3. API

`GET /api/pool-numbers` - admin-gated exactly like the adminUsers router
(`router.use(requireRole('admin'))`), mounted in routes/api.ts alongside
it. Read-only assembly:

1. Pool records: `poolNumbers.listByState(state)` for each of active,
   releasing, released - a NEW repo method generalizing the existing
   `listActive()` paged Query on the byLifecycleState GSI (listActive
   delegates to it; never a scan). Sparse-GSI note: rows keep the retained
   sentinel RANGE attribute, so releasing/released rows must remain
   queryable - a repo test proves a released row is returned.
2. Per number, groups via the existing `conversations.getAllByPoolNumber`
   (byPoolNumber GSI). Launch-scale numbers are few (well under 100);
   the N+1 GSI queries are accepted and stated.

Response shape (wire contract, camelCase like other dashboards routes):

    interface PoolNumberGroupRow {
      conversationId: string;
      label: string;        // groupLabel idiom: member names > tag > "Group text"
      memberCount: number;
      status: 'open' | 'closed';
      createdAt?: string;   // when the model records it
      closedAt?: string;    // when the model records it
      lastActivityAt?: string;
    }
    interface PoolNumberRow {
      number: string;       // E.164 - display data for the admin, never logged
      state: 'active' | 'releasing' | 'released';
      openGroups: number;
      totalGroups: number;  // groups ever hosted on this number
      burnedCount: number;  // burned_phones size (0 when attr absent)
      lastActivityAt?: string;   // max of the groups' last-activity stamps
      lastGroupClosedAt?: string;
      releasedAt?: string;
      retire: {
        eligible: boolean;       // mirrors retireEligible EXACTLY
        daysRemaining?: number;  // present when counting down (zero open
                                 // groups, hosted >= 1, grace not yet elapsed)
      };
      groups: PoolNumberGroupRow[];  // newest first
    }
    GET /api/pool-numbers -> { numbers: PoolNumberRow[] }  // active,
                                 // releasing, released - client filters

Retire mirror: eligible = state active AND openGroups === 0 AND
totalGroups >= 1 AND last_group_closed_at older than the SAME grace
constant the sweep uses - IMPORT the service's existing constant, never a
second 180-day literal. daysRemaining = whole days until that instant
(ceil), only when the number is idle (zero open groups) and not yet
eligible. The page does not consult RELAY_NUMBER_RELEASE_ENABLED - it
shows what the sweep WOULD consider; actual release stays flag-gated.

Group timestamps: use the fields the conversation model actually records
(created / last-activity stamps exist today; a per-group closed timestamp
is used only if the model records one - research confirms the exact field
names; absent data renders as an em-dash-free "-" placeholder, never a
fabricated date).

## 4. Page

`/settings/numbers`, AdminRoute-wrapped, nav entry "Group text numbers"
in Settings beside the existing admin sections (VA sees neither the nav
entry nor the route; direct navigation bounces exactly as other admin
sections do; the API 403s).

- One table, columns: Number, State, Open groups, Total groups, People
  burned, Last activity, Last closed, Retirement. The Retirement cell:
  "Eligible" when eligible; "NNd remaining" while counting down; "-" when
  the number has open groups; "Released <date>" for released rows.
- Filter chips above the table: "Active" (default - active + releasing),
  "Released", "All". Releasing rows show state "releasing" in the State
  column under the Active filter.
- Row expansion: the number's groups, newest first - label, member count,
  status, opened date, closed date - each row linking to the group thread
  (the existing conversation route). Collapsed by default.
- Empty states: no numbers at all ("No group text numbers yet - a number
  is provisioned with the first group text."); filter with no matches.
- Read-only: no buttons, no mutations.

## 5. Security and PII

- Route behind requireRole('admin'); page behind AdminRoute. A va-role
  request gets the same 403 the adminUsers routes return.
- Phone numbers and member names in the RESPONSE are display data for an
  authenticated admin (same class as existing roster surfaces). LOGS stay
  PII-free: counts and states only, never a number.
- burned_phones contents are NEVER returned - only the count. The burn
  set is an internal invariant record; the page has no reason to list
  strangers' phone numbers.

## 6. Non-goals

- No purchase/release/retire actions from the page.
- No per-message history (group threads already show transcripts).
- No VA visibility or read-only VA variant.
- No pagination UI (launch scale; the API returns all rows).

Schema/GSI posture (human, 2026-07-18): none is ANTICIPATED - the existing
byLifecycleState + byPoolNumber GSIs cover both access patterns and one
additive repo method suffices. But we are dev-only with no live data, so a
schema/GSI change IS allowed if the build finds a genuine need or a
clearly better-practice shape - it must be called out in the handback
with the terraform plan/apply recorded as an owed post-merge op.

## 7. Testing

App (route + repo):
- listByState returns rows for each state; a RELEASED row is returned
  (sparse-GSI proof); listActive still returns exactly active rows.
- GET /api/pool-numbers: 403 for va role; joins pool records to groups
  correctly (a number with one open + one closed group -> openGroups 1,
  totalGroups 2, groups newest-first); burnedCount 0 when attr absent;
  retire.eligible true only past the grace with zero open groups and
  hosted >= 1 (boundary: exactly-at-grace, one-day-short with
  daysRemaining, open-group -> no countdown, never-hosted -> not
  eligible); released row carries releasedAt and eligible false.
- No log line in the route carries a phone (PII sweep).

Dashboard:
- Admin sees nav entry + table rows from a mocked response; VA sees no
  nav entry and the route bounces (AdminRoute test idiom).
- Filter chips switch the visible states; expansion renders group rows
  with links; retirement cell renders all four variants.

E2E (one spec):
- Admin session: create a relay group via the existing flow idioms (the
  relay specs already do this), open /settings/numbers, assert the pool
  number appears with an open group and expansion shows the group linking
  to its thread. VA/default session: nav entry absent; direct navigation
  does not render the page.

## 8. Rollout

Expected pure app+dashboard code: no deps, flags, or seeds, and no
schema/infra unless the build exercises the section-6 allowance (then the
tf plan/apply is an owed post-merge op in the handback). GLOSSARY.md
updated with the staff noun in the same change.
