// Staff copy shared by the property page's contact-list writes (ListingDetail
// runRosterWrite) and the restore landlord dialog (RestoreLandlordDialog), so
// the two sites show ONE sentence for the same 409 and cannot drift apart.

/** A 409 unit_roster_conflict: the property's contacts or its landlord of
 *  record changed under the request - nothing was written; try again. */
export const ROSTER_RETRY_COPY = 'The property contacts changed - try that change again.';
