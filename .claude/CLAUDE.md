## Claude Code

## Terminology (read before naming domain concepts)

One entity, three labels by audience. The "single dwelling a single household can
lease and move into" is **always `unit` in code/data**. Human-facing copy uses:

- **Tenant →** "home"
- **Landlord →** "listing"
- **Staff / navigator (dashboard) →** "listing"
- **Code / data / internal →** "unit" (`unitId`, `unitsRepo`, `UnitItem`)

`unit` is the HUD/Section 8 term and is **structure-agnostic** (a house, townhome,
or apartment is all a "dwelling unit") — it is not apartment-specific. Do **not**
use "property" for this entity (in PM systems a property is the *parent* of units);
normalize stray "property" wording that means a single dwelling back to `unit`.
Keep `listing_link` / "public listing" (the external listing URL) and the
JS object-property sense of "property" as-is.

Full rationale, the audience→noun table, and the future-AI mapping:
[documentation/GLOSSARY.md](../documentation/GLOSSARY.md). Update it in the same
change whenever you add a domain noun or fix drift.
