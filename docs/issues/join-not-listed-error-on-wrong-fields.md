---
id: join-not-listed-error-on-wrong-fields
title: The /join "list was updated" error marks the person fields invalid and stays up after the authority is chosen
type: improvement
severity: low
status: open
area: dashboard/public
created: 2026-10-12
refs: dashboard/src/routes/public/IntakeForm.tsx:58, dashboard/src/routes/public/IntakeForm.tsx:69-76, dashboard/src/routes/public/IntakeForm.tsx:133, dashboard/src/routes/public/HousingAuthoritySelect.tsx:108-110, dashboard/src/routes/public/HousingFairIntake.tsx:135-142
---

**Problem.** On `housing_authority_not_listed` the /join form shows "The housing authority
list was updated. Choose the housing authority again." through IntakeForm's shared error
line. That line is attached to First name, Last name and Phone (each gets
`aria-invalid="true"` and `aria-describedby="intake-error"`), not to the "Housing authority"
select that needs the action (the select has no `aria-invalid` and is not described by the
alert). After the person picks an authority, the alert and the three invalid flags stay
until the next text edit or send, because a select change never reaches IntakeForm's error
state. A screen-reader user tabbing the fields hears three valid fields announced invalid
with a message about a different field. The "every field invalid" pattern predates this
change for generic failures; this message is field-specific. The plan's binding ruling
AR-7 accepted the clearing behavior (the spec never says when the message clears); the
accessibility angle was found by the join-housing-authority R2 review (R2-N1, 2026-10-12),
reproduced in a throwaway test.

**Suggested fix.** In IntakeForm, wrap the extra-field slot so a change inside it clears the
error like any field (React change events bubble: `onChange` on a wrapping element). While
the select shows "Choose one", give it `aria-invalid="true"` and add the alert's id to its
`aria-describedby` (HousingFairIntake can pass an `invalid` prop to HousingAuthoritySelect).
