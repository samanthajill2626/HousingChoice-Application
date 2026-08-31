---
id: message-interpolate-token-reexpansion
title: interpolate() substitutes declared tokens SEQUENTIALLY, so a substituted value containing another declared token is re-expanded into the outbound message
type: bug
severity: med
status: open
area: app/messages
created: 2026-08-31
refs: app/src/messages/resolve.ts:24, app/src/messages/catalog.ts:99, app/src/lib/tourContacts.ts, app/src/routes/public.ts
---

**Problem.** `interpolate` in `app/src/messages/resolve.ts` walks `def.vars` in
DECLARATION ORDER and does one `split(needle).join(value)` pass per token. The
output of an earlier pass is the input to every later pass, so a VALUE
substituted early that itself contains `{anotherDeclaredToken}` is expanded
again by that later token's pass. Any catalog entry whose value for one token
can be attacker- or user-supplied, and which declares at least one OTHER token,
can therefore be made to render a value the call site never passed for that
slot.

Reachability is real, not theoretical: `POST /public/housing-fair`
(`app/src/routes/public.ts`) is UNAUTHENTICATED and accepts `firstName` as an
arbitrary string, trimmed and length-capped only, then creates or dedupes a
tenant contact from it. AI extraction and staff free text reach the same field.

**IT IS ALREADY LIVE IN RELAY - this is not only a tour-path hazard.** An
earlier revision of this issue claimed the only other contact-name entries
"declare exactly ONE token each, so there is no second token to leak into". A
re-review disproved that:

- `relay.member_added` (`'Hey! {joined} {members}'`, `catalog.ts:299-306`)
  declares TWO tokens, `['joined', 'members']`, and BOTH are fed from contact
  display names. A group member named `{members}` therefore has that token
  expanded by the later pass, into an SMS sent to the WHOLE GROUP. That is
  reachable today, with no tour involved, and it is `editable: false` so no
  override is needed. It is the strongest argument for the single-pass fix.
- `welcome.sms` declares `['firstName']` - genuinely single-token.
- `relay.media_only` (`'{name} sent an attachment.'`) declares `['name']` -
  genuinely single-token. The adversarial review that found the original issue
  called it `notification.attachment`; that id does not exist.

The tour entries are what changed the picture: `TOUR_NAME_VARS` plus
`where` / `addressLine` means every `tour.*` entry declares six to eight tokens,
with the name tokens ahead of `where` / `addressLine` in the list. A tenant
named `{propertyContactFirstName}` is texted the landlord's first name; a tenant
named `{where}` or `{addressLine}` is texted the unit's street.

**RESIDUE on the tour path after the stopgap.** `lib/tourContacts.ts` strips
braces from resolved NAMES, which closes the re-expansion vector there. It does
NOT sanitize the unit ADDRESS, which lands in the same sentence as
`{addressLine}` / `{where}`. That one is order-SAFE - the address is substituted
after every name token, so nothing re-expands it - so it is not a disclosure
vector; the residue is only that a braced address would emit a literal `{token}`
into a tenant SMS. Fix it with the single-pass change rather than by bolting a
second sanitizer onto address rendering.

**Stopgap already in place - do not read it as the fix.** The tour path is
sanitized AT ITS SOURCE: `firstNameOf` / `fullNameOf` in
`app/src/lib/tourContacts.ts` strip `{` and `}` from every resolved name
(`inertName`), so nothing the tour composer hands to `interpolate` carries a
brace. That closes the tour entries and NOTHING else. Any future entry that
declares more than one token and interpolates user-supplied text reopens the
hole, and it will not be obvious to whoever writes it.

**Suggested fix.** Make interpolation SINGLE-PASS, so no substituted value is
ever re-scanned:

```ts
out = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (m, token) =>
  allowed.includes(token) ? (vars?.[token] ?? throwOrEmpty(token)) : m);
```

Both current behaviours must be preserved: an UNDECLARED token is left literal
in the template, and a DECLARED-but-missing var throws in a catalog default
(strict) while degrading to empty in an operator override (non-strict) - see
the docblock on `interpolate`.

This is deliberately NOT a drive-by. It changes the rendering path of EVERY
message in the app - operational SMS, compliance-locked keyword replies, voice
`<Say>` copy - so it needs its own change, its own catalog-wide test pass, and
its own review. When it lands, the `inertName` stopgap in `tourContacts.ts` can
be revisited (it is harmless to keep, and a brace in a human name is still not
a name).
