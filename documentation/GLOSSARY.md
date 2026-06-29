# Glossary & Naming Conventions

The shared vocabulary for HousingChoice. When code, UI copy, docs, or (later) AI
prompts name a domain concept, they use the words defined here. The point is that
every party — tenants, landlords, staff, and the engineers/agents building the
system — hears a consistent, accurate term for the same thing.

**Contributors & agents:** if you introduce a new domain noun, add it here in the
same change. If you find drift (a synonym creeping in for an entity that already
has a blessed word), fix it toward this table.

**See also:** [STATUS-MODEL.md](STATUS-MODEL.md) — the living reference for how the
three core entities (tenant, **placement**, property/`unit`) move through the process:
their phases, stages, and how they derive from one another.

---

## The unit / home / property entity

There is **one** entity for "a single dwelling a single household (a family,
couple, or individual) can lease and move into." In code and data it is always
called a **`unit`**. What a *human* is shown depends on who they are:

| Audience | Word they see | Singular / plural | Example copy |
|---|---|---|---|
| **Tenant** (voucher holder) | **home** | home / homes | "3 homes match your voucher" |
| **Landlord** | **property** | property / properties | "Your property is now live" |
| **Staff / navigator** (dashboard) | **property** | property / properties | "Properties", "New property" |
| **Code / data / internal** | **unit** | unit / units | `unitId`, `unitsRepo`, `UnitItem` |

One entity, three labels by audience. Pick the label by **who is reading**, not by
which surface the code lives in.

### Why `unit` is the internal term (and not "apartment-specific")

"Unit" can sound apartment-y in everyday speech, but in the Housing Choice Voucher
(Section 8) program it is the **regulatorily correct, structure-agnostic** word: a
single-family home, townhome, duplex half, or apartment is all a *dwelling unit* on
the Request for Tenancy Approval and the Housing Quality Standards inspection. So a
unit is **not** "an apartment" — it is "the one dwelling a household leases,"
whatever its structure. That is why the code keeps `unit` and the tenant-facing
copy softens it to **home**.

### Why "property" (the blessed landlord/staff word)

Landlords and staff see **property** because it is the most natural, everyday word
for "the place" — a landlord thinks of their **property**, and a navigator scanning
the dashboard reads **Properties**. It carries no Zillow-style "advertisement"
connotation (that sense is reserved for the *external* listing — see below), and it
reads cleanly in copy ("Your property is now live", "Properties", "New property").

This is a deliberate choice, not a hard constraint — if we later decide landlords
should hear "home" (it is, after all, the tenant's future home), this table is the
single place to change it.

> **Reserved for a future parent layer: "building" / "parcel".** In some
> property-management systems (Yardi, AppFolio, Buildium) "property" names the
> *parent* that contains multiple units — a duplex as one property with two units.
> We don't model that parent layer today (each `unit` is a flat record with its own
> address; a duplex is two `unit` records). If we ever introduce a multi-unit parent,
> name it **"building"** or **"parcel"** — *not* "property" — so the leaf-entity word
> ("property" = one `unit` to landlords/staff) and the parent word never collide.
> The old "property = parent of units" worry is handled by reserving a different word
> for the parent, not by avoiding "property" for the leaf.

### What is genuinely a "listing" in code (keep these)

"Listing" is a blessed *human* label, but a few code uses of the word are about the
**external public listing** and are correct as-is — do not rewrite them to `unit`:

- `listing_link` — the field holding the unit's public/external listing URL.
- "public listing" in comments referring to that external URL.
- The shareable flyer is the public face of a unit; "listing" wording there is fine.

Likewise, "property" in its plain programming sense (an object property/attribute)
is unrelated to this entity and stays.

---

## The placement (workflow) entity

The **workflow record** that tracks getting one tenant into one specific unit — the
spine of the process — is a **`placement`** in code, data, and UI: the type is
`PlacementItem`, the repo `placementsRepo`, the DynamoDB table `placements` (PK
`placementId`), the API path `/api/placements`, and the dashboard surface is
"Placements". It was originally named `case`/`cases`; that has been **renamed to
`placement`/`placements` throughout** (no `case` entity term remains in current
code/data — see [STATUS-MODEL.md](STATUS-MODEL.md), the living reference for the
placement lifecycle). Unlike the unit/home/property entity, the placement has **one
label for every audience** ("placement") — there is no audience-specific synonym.

> Note: plain-English "case" (a `switch`/`case` keyword, "in this case", "edge
> case", "test case") and the unrelated tenant field `caseworker` are **not** this
> entity and are left as-is.

---

## Feature & label notes

- **"Share Properties"** — the staff dashboard feature that fans a filtered broadcast
  out to matched tenants. The human label is "Share Properties" (a prior rename had
  briefly flipped it to "Share Listings"; the property relabel returns it to "Share
  Properties"). Internal identifiers (the `broadcast` entity, routes, jobs) are
  unchanged — only the displayed name follows the audience rule.

---

## For the future AI layer

When AI augmentation/automation talks to a party, it must use that party's word
from the table above: **home** to tenants, **property** to landlords and staff,
and reason internally in terms of **units**. This document is the source of truth
for that mapping. (We are keeping it docs-only for now; if a runtime constant is
ever wanted so prompt-builders import one definition, mirror this table — do not
fork it.)
