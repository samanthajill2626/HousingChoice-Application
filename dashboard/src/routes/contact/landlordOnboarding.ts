// Shared help text for the landlord-onboarding CRITERIA (the four Yes/No fields
// captured on the ~10-minute onboarding call). One source of truth so the
// read-only "Landlord onboarding" card and the edit-form inputs never drift.
// Wording grounded in documentation/landlord-onboarding-sequence-writeup.md and
// the GLOSSARY (RTA = Request for Tenancy Approval; HQS = Housing Quality Standards).

export const LANDLORD_ONBOARDING_HINTS = {
  registered_landlord:
    'Holds the registration required to rent under the program (e.g. local rental registration / business license).',
  rta_within_48h:
    'Commits to returning the signed Request for Tenancy Approval (RTA) within 48 hours.',
  pass_inspection_first_try:
    'Expects the unit to pass the Housing Quality Standards (HQS) inspection on the first try.',
  income_includes_voucher:
    "Counts the voucher subsidy toward the tenant's income requirement — i.e. voucher-friendly.",
} as const;
