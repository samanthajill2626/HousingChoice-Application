---
id: number-input-unparseable-entry-silently-ignored
title: Property and contact number inputs silently ignore an entry the browser cannot parse
type: bug
severity: low
status: open
area: dashboard
created: 2026-10-27
refs: dashboard/src/routes/listing/ListingEditForm.tsx:161, dashboard/src/routes/listing/UnitCreateForm.tsx:487, dashboard/src/routes/contact/ContactEditForm.tsx:435
---

**Problem.** A `type="number"` input reports an entry it cannot parse as an
empty value (HTML value sanitization: `validity.badInput` is true and `value`
is `""`). Firefox lets staff type any text into such an input, and every
engine sanitizes a pasted "1,200" or "1.2.3" the same way. The forms read
that `""` as "nothing typed": the property forms' `addNumber`
(ListingEditForm.tsx:161-177, and the New form's twin) skip the field, and
the contact form leaves Voucher size untouched (ContactEditForm.tsx:435-446).
So Save succeeds, the entry is dropped without a message, and the record
keeps its old value - staff believe they changed Beds, Baths, Rent min, Rent
max, Payment standard or Voucher size when they did not.

Found by the WP1 B1 conformance review (CONF-1, 2026-10-27), which fixed the
same pattern on B1's new Maximum tenant portion input, where the empty value
meant CLEAR and removed a stored portion (B1 fix wave FW1, item FW-11: the
input refuses an unparseable entry at Save with the server's message). The
pre-existing inputs were left alone as out of B1's scope.

**Suggested fix.** Read `e.target.validity.badInput` in each onChange (or at
Save) and refuse with the field's existing "must be a number" message, as
FW-11 does for the portion; one shared helper for the property and contact
forms.
