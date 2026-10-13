// Staff copy shared by the property page's contact-list writes (ListingDetail
// runRosterWrite) and the restore landlord dialog (RestoreLandlordDialog), so
// the two sites show ONE sentence per shared answer - the 409
// unit_roster_conflict and the 503 roster_read_failed - and cannot drift apart.

/** A 409 unit_roster_conflict: the property's contacts or its landlord of
 *  record changed under the request - nothing was written; try again. */
export const ROSTER_RETRY_COPY = 'The property contacts changed - try that change again.';

/** A 503 roster_read_failed (primary-contact-integrity spec 4.6 / 7.3): the
 *  server could not read the contacts it needs to pick the next primary, so
 *  nothing was written - removing the primary, or a landlord restore. */
export const ROSTER_READ_FAILED_COPY = "Couldn't check the other contacts - try again.";
