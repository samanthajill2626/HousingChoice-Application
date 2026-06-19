# Glossary & Naming Conventions

The shared vocabulary for HousingChoice. When code, UI copy, docs, or (later) AI
prompts name a domain concept, they use the words defined here. The point is that
every party — tenants, landlords, staff, and the engineers/agents building the
system — hears a consistent, accurate term for the same thing.

**Contributors & agents:** if you introduce a new domain noun, add it here in the
same change. If you find drift (a synonym creeping in for an entity that already
has a blessed word), fix it toward this table.

**See also:** [STATUS-MODEL.md](STATUS-MODEL.md) — the living reference for how the
three core entities (tenant, **placement**, listing/`unit`) move through the process:
their phases, stages, and how they derive from one another.

---

## The unit / home / listing entity

There is **one** entity for "a single dwelling a single household (a family,
couple, or individual) can lease and move into." In code and data it is always
called a **`unit`**. What a *human* is shown depends on who they are:

| Audience | Word they see | Singular / plural | Example copy |
|---|---|---|---|
| **Tenant** (voucher holder) | **home** | home / homes | "3 homes match your voucher" |
| **Landlord** | **listing** | listing / listings | "Your listing is now live" |
| **Staff / navigator** (dashboard) | **listing** | listing / listings | "Listings", "New listing" |
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

### Why not "property"

In every property-management system (Yardi, AppFolio, Buildium), a **property** is
the *parent* that can contain multiple units — a duplex is one property with two
units. Using "property" for the leaf entity would collide the day we ever model
buildings. We do not model a building/parcel layer today (each `unit` is a flat
record with its own address; a duplex is two `unit` records), and we are not
introducing a "property" concept. Treat any lingering "property" wording that means
a single dwelling as drift to be normalized to `unit`.

### Why "listing" for landlords (an easy flip)

Landlords see **listing** because it matches the inventory/business framing of the
thing they are putting on the market. This is a deliberate choice, not a hard
constraint — if we later decide landlords should hear "home" (it is, after all, the
tenant's future home), this is the single place to change it.

### What is genuinely a "listing" in code (keep these)

"Listing" is a blessed *human* label, but a few code uses of the word are about the
**external public listing** and are correct as-is — do not rewrite them to `unit`:

- `listing_link` — the field holding the unit's public/external listing URL.
- "public listing" in comments referring to that external URL.
- The shareable flyer is the public face of a unit; "listing" wording there is fine.

Likewise, "property" in its plain programming sense (an object property/attribute)
is unrelated to this entity and stays.

---

## Feature & label notes

- **"Share Listings"** — the staff dashboard feature that fans a filtered broadcast
  out to matched tenants. It was previously labeled **"Share Properties"**; the
  human label is "Share Listings". Internal identifiers (the `broadcast` entity,
  routes, jobs) are unchanged — only the displayed name follows the audience rule.

---

## For the future AI layer

When AI augmentation/automation talks to a party, it must use that party's word
from the table above: **home** to tenants, **listing** to landlords and staff,
and reason internally in terms of **units**. This document is the source of truth
for that mapping. (We are keeping it docs-only for now; if a runtime constant is
ever wanted so prompt-builders import one definition, mirror this table — do not
fork it.)
