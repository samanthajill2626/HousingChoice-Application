# Prod pool count - 2026-10-24 (read-only)

Purpose: size the candidate pools the WP1 ranking would send to the model,
on real data, before the charter fixes the call shape and cost rule.
Approved by Cameron 2026-10-24 ("Go ahead and run the test so that we at
least have anchorable evidence to talk through").

Method: two `aws dynamodb scan` reads with CLI profile `housingchoice`
(account 938565869261, us-east-1) against `hc-prod-contacts` (projection:
type, status, voucherSize, housingAuthority, last_heard_from_at; filter
type = tenant) and `hc-prod-units` (full items). No writes. Aggregation by
a scratchpad script applying the blast resolver's eligibility semantics:
voucher size any-of with 4 meaning 4 or more and an empty list matching
every size, a tenant with no voucher size never matching a non-empty list;
housing authority any-of, compared trimmed and case-insensitive, same
empty-list and blank-tenant rules. Status searching only (Cameron, round
2). Soft-deleted units (deleted_at set) excluded from "live available".
Point-in-time numbers; they are not recomputable from git.

## Tenants (878 tenant contacts of 983 total)

| status | count |
|---|---|
| searching | 670 |
| inactive | 76 |
| onboarding | 54 |
| placing | 31 |
| placed | 29 |
| on_hold | 9 |
| needs_review | 9 |

Searching tenants by voucher size: 2 -> 185, 3 -> 176, 1 -> 113, 4 -> 105,
blank -> 45, 10 -> 29, 5 -> 16, 7 -> 1. (The 10s are likely data errors or
a code; worth asking Sam.)

Searching tenants by housing authority: Atlanta Housing Authority 486,
blank 45, DeKalb County 37, Jonesboro 32, "Market" 28, Georgia DCA 17,
Fulton County 7, Georgia Housing Voucher Program (DBHDD) 7, East Point 3,
Decatur 2, Augusta 2, Marietta 2, Macon-Bibb 1, College Park 1.

Searching tenants with BOTH a voucher size and an authority: 621 of 670.

Searching tenants by last heard from: more than 90 days 319, 31-90 days
140, 8-30 days 103, never 66, 0-7 days 42. Nearly half of the searching
list has not been heard from in a quarter.

## Units (138)

By status: setup 46, available 34, occupied 26, off_market 19,
under_application 10, finalizing 2, on_hold 1. Of the 34 available, 12
carry deleted_at, so LIVE available = 22.

Attributes carried by the 34 available units (non-empty): address,
accepted_authorities, status 34; beds, baths 32; media 21; status_source
21; landlordId 19; tour_type 17; imported_* 15-16; voucher_size_accepted
14; tour_process 10; same_day_rta 9; pets 6; utilities 6;
application_process 5; notes 5; application_fee 4; accessibility 2;
deposit_one_month 2; requirement_sources 2; deposit, credit_requirements,
no_evictions_on_program, no_pets, qualifications 1 each.

NOT carried by ANY available unit: rent_min, rent_max, final_rent,
payment_standard, subzone, priority. The contract's "rent against the
payment standard" input has NO data behind it in prod today, and priority
has no values to migrate.

Live available units: beds 1 -> 1, 2 -> 9, 3 -> 5, 4 -> 6, 5 -> 1.
Authorities: Atlanta Housing 14, Atlanta Housing + GHVP 3, Georgia DCA 2,
Marietta 1, DeKalb 1, GHVP 1. 12 of 22 have a voucher size list; all 22
have beds.

## Pool sizes (live available x searching)

| scenario | per property: median / p75 / max | per tenant: median / max / zero |
|---|---|---|
| A. as recorded | 104 / 486 / 493 | 8 / 10 / 121 of 670 |
| B. A + tenants heard from within 90 days (285 tenants) | 57 / 197 / 199 | 9 / 10 / 46 of 285 |
| C. A + within 30 days (145 tenants) | 30 / 110 / 112 | 9 / 10 / 18 of 145 |
| D. A, with beds standing in where no voucher size is recorded | 104 / 127 / 158 | 3 / 5 / 166 of 670 |
| E. D + 90-day cutoff | 50 / 57 / 64 | 3 / 5 / 76 of 285 |

Reading: the property-side pool is large (hundreds) because 10 of the 22
live available units record no voucher size, so they match every size,
and 14 of 22 accept Atlanta Housing, which 486 searching tenants hold. The
tenant-side pool is small (at most 10 live available properties). Filling
voucher sizes on properties (D) and a staleness rule on tenants (B/C) are
the two levers that bring the property-side pool under about 60. One
property matches nobody (zero) in every scenario - a size or authority
with no searching tenant.

## Other observations

- `hc-prod-matches` exists in prod with 0 items and no repository in the
  code (only `unmatchedEmailRepo`, a different thing). Origin to confirm
  before the ranking record store picks a table name.
- 121 searching tenants match no live available property as recorded; 45
  of them have a blank voucher size or authority and can never match a
  property that lists either.

Correction (same day): `matches` IS in the code's table spec
(app/src/lib/tables.ts: hash tenantId, range unitId, GSI byUnit, TTL
expires_at, "volatile engine output; bulk-regenerated") - a Phase 0 design
for pairwise match rows that no repository writes yet. It exists in every
environment, so a per-pair ranking record needs no new infrastructure if
it fits that shape.
