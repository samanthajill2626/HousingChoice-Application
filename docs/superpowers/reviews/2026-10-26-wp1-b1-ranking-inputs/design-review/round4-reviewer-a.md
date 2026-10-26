# WP1 B1 Ranking inputs - design review round 4 (final), reviewer A

Spec: docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md rev 5
(00ad8354). Charter as amended at 50254ac9 (section 20 items 4-6) is treated
as decided. Read-only review; nothing run.

Leftover check: the spec has no dangling references to the withdrawn design.
A grep for handle, appendReactions, shares_op and remove control hits only
the withdrawal statements (spec lines 6, 259, 290, 347, 481, 562).
Surfaces (section 4), tests (section 5), e2e and docs all describe reaction
lines only. `buildExtractionHandles` and the window-handle hash change are
gone everywhere. Round-3 fixes check out: the retry guard runs before the cap
(D4), additive accessibility needs are allowed as lines (D4), the
default-suite rule is now numeric (D7), and the floor is plumbed into
ApplyDeps and coerceField is exported (D4).

---

## 1. [HIGH] The address guard only covers lines that match the exact reaction shape, so "no other address reaches the Notes box" is not delivered

What is wrong. D5.3 drops a reaction line whose property part matches no
block entry "so no address that is not a sent property's reaches the Notes
box". But the check runs only on lines matching
`^(.+) - (interested|maybe|not interested|question): (.+)$`, which is
case-sensitive with exact separators. Any line that carries an address in
another shape is an ORDINARY line and passes. Examples:

- "123 Main St, Decatur - Maybe: ..."
- "123 Main St, Decatur: not interested, too far"
- "Not interested in 45 Oak Ave - too far"
- a line naming the tenant's own street

The only address filter on ordinary lines is today's postal filter, which
drops a line only if it starts with "current address" and contains a digit
(apply.ts:720-722). Rev 5 also REVERSES the prompt's blanket ban, "Addresses
NEVER go in noteLines" (prompt.ts:132-133), into "the only address a line
may carry is a sent property's" (D5.2). The model is therefore now invited to
write addresses, and only one exact spelling of one shape is checked.

Implies. The stated guarantee holds for well-formed output only, which is
not the output that needs guarding. Make the reaction-word match
case-insensitive and tolerant of separator variants, and rewrite the word to
its canonical lowercase form so B2 and Sam read one shape. Then add a
street-address check to EVERY model line: a number followed by a street
word, or any block address string. A line carrying an address that is not a
matched reaction line is dropped and counted. Test both shapes.

## 2. [MEDIUM] Demoting "better form" writes brings suggestion churn back on rewordings, against D3's own claim

What is wrong. D3 bullet 1 keeps the pets rule for all four fields: op
`write` "when the field is empty OR the value is the same fact in a better
form". Bullet 2 now ENFORCES in apply that a `write` on a non-empty text
field "is demoted to a suggestion". So every better-form restatement the
model offers on a filled text field becomes a pending chip, for example
"Decatur or Tucker" for stored "decatur/tucker". The model is still told to
do this by the unchanged reconciliation text (prompt.ts:37-38: "the SAME
fact in a better form").

Each new rewording is a new string. Dismissal tombstones fold only case and
whitespace (schema.ts:301-304), so a dismissed rewording returns reworded on
the next run while the source message is in the 30-day window. That is the
exact churn D3 says it removes ("suggestions do not churn on rewordings").

Implies. For text fields on a non-empty value, apply should DROP a `write`,
not demote it, recording it as a drop. A real contradiction arrives as
`suggest`. Also tell the model, in the text-field guidance, that
better-form rewrites do not apply to a filled text field. Separately, this
new demotion must not be pushed into `demotedFields`. That list feeds the
Layer-3 `ai_extraction_demoted` audit only (apply.ts:321-327 explains the
same rule for the housing-authority demotion). Say so.

## 3. [MEDIUM] When the block is "unavailable", the prompt turns reactions into anonymous lines permanently

What is wrong. D5.1: a failed `listByContact` or units read renders
`PROPERTIES SENT: unavailable` and the run continues. D5.2's prompt rule
says a reaction to a home "NOT in the block" is an ordinary line WITHOUT an
address. With an unavailable block, every reaction is to a home not in the
block. So the model correctly writes "not interested in a home: too far from
work", and it is appended for good.

On the next run the block is back and the source message is still in the
window. But the reconcile rule ("If the notes already express the fact ...
omit the line", prompt.ts:112-115) tells the model the fact is already
recorded, so the proper reaction line naming the property is likely never
written. A transient DynamoDB error thus permanently strips which property a
reaction was about. The same happens for a sent property cut from the block
by the newest-20 limit or the 4,000-character budget.

Implies. For `unavailable`, either fail the run so it retries (the org-list
read already fails the run, jobs/extraction.ts:563-568), or render a prompt
line telling the model to write NO line about a sent or offered home this
run. For the cut-off case, a line saying more properties were sent than are
listed lets the model hold back instead of writing an anonymous line.

## 4. [MEDIUM] Sent property addresses are not unique by "address line 1, city"

What is wrong. The block entry and the match key are
`<address line 1>, <city>` (D5.1, D5.3; the shape is charter-fixed). Unit
addresses also carry `line2` (lib/address.ts:24). Units of one building
share line1 and city and differ only in line2. The data model has a
building/property grouping for exactly this (unitsRepo.ts:567-569,
`propertyId`, `same_property`). Two sent units of one building therefore
render two identical block lines. A reaction line matches "one block entry",
but nothing says which. B2 and Sam cannot tell which unit a "maybe" was
about.

UNVERIFIED: how many production units share line1 and city. The schema
allows it and the grouping feature exists for it.

Implies. The spec must define collisions. Either render line2 into the
address part when two entries would collide, or drop both entries (with a
warn), so an ambiguous reaction becomes an ordinary line. Because the shape
is fixed by the charter, the choice may need to go to Cameron.

## 5. [MEDIUM] Flyer sign-ups are included in the block, but the block is built for tenants only, and most flyer leads are unknown contacts

What is wrong. D5.1 includes flyer rows ("the tenant may react to a flyer
property too"), but builds the block "For a TENANT contact" only. Every
non-tenant gets `PROPERTIES SENT: none`. A flyer sign-up from a new number
creates an `unknown` contact ("an `unknown` contact a flyer sign-up puts on
the card is never renamed", listingSendsRepo.ts:141-142), and extraction
runs on unknown contacts (jobs/extraction.ts:457).

So the population whose ONLY property is a flyer property gets no list. Their
"I'm interested in the house on Oak" becomes an anonymous line under D5.2's
not-in-block rule. When staff later type them as tenant, the anonymous lines
stay and reconciliation suppresses a proper line (finding 3). The flyer
inclusion only works for flyer sign-ups from an existing tenant's number.

Implies. Build the block for unknown contacts too. Reaction lines are Notes
lines, which extraction already writes for unknown contacts, and the amended
charter 6.4 does not restrict reaction lines to tenants. Or state that flyer
leads get no reaction lines until typed tenant and drop the "flyer property
too" rationale.

## 6. [LOW] Reaction-line regex details

- An ordinary line that happens to contain " - question: " or
  " - interested: " ("Bus routes - question: do they run late") is
  classified as a reaction line, matches no block entry, and is dropped.
  Count those separately, or require the property part to look like a block
  address before classifying.
- A model that copies the whole block line ("123 Main St, Decatur - sent
  Oct 3 - maybe: ...") fails the match. The prompt should give the exact
  copy span, or the block should render the address on its own.
- The order has unmatched lines counted before the floor. A below-floor
  unmatched line is counted as unmatched, not as below-floor. Pick one and
  say it.

## 7. [LOW] D7's "must produce no address" control has no detection rule

"A reaction to a home not in the block must produce no address" (D7). The
case's banned list must carry that home's address string (and its street
number) as a term, or the check is a reading. Reaction controls should also
assert the canonical line shape (word lowercase, block address verbatim),
not just "right property, right word".

## 8. [LOW] The reaction line's date has no year

Lines are prefixed `[Auto - Oct 12]` with month and day only, UTC
(apply.ts:144-149). Charter 4 (amended) says a `maybe` should "bubble back
up" with time. If B2 reads the reaction's age from the line, a line older
than a year is ambiguous. B2 may instead use the pair's send dates. Worth a
sentence handing this to B2 so it does not discover it late.

---

## Adjudications

None rejected; I contest none.
