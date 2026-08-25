// The copy for a System Status block that came back { available: false }.
//
// WHY THIS EXISTS: every block used to render the single string "Available in
// deployed environments." for ANY degraded result. That sentence is only true
// for `unavailable_local` - the hermetic/local stack with no AWS at all. On a
// DEPLOYED environment whose CloudWatch read failed or timed out, it actively
// misdirects: an operator reads it as "this environment is not deployed" and
// goes looking at environment detection instead of at the query. That happened
// on dev on 2026-08-25, where the alarms block was reading successfully from
// the same account with the same credentials while the errors block printed
// the not-deployed sentence.
//
// The server already sends `reason` on both degraded shapes, so nothing new is
// needed on the wire - the UI simply has to stop discarding it.

/** Degraded copy for a `reason`, defaulting to the local/hermetic sentence. */
export function degradedNotice(reason: string | undefined): string {
  switch (reason) {
    case 'unavailable_local':
      // The genuine "there is no AWS here" case: local dev and the e2e lane.
      return 'Available in deployed environments.';
    case 'cloudwatch_error':
      return 'Could not read CloudWatch. This environment IS deployed - the query failed or timed out. Check the app logs for "system status".';
    case 'invalid_ref':
      return 'That log pointer was not valid, so the record could not be fetched.';
    case 'invalid_id':
      return 'That correlation id was not valid, so the trace could not be run.';
    case 'out_of_scope':
      return 'That record belongs to a different environment and was refused.';
    default:
      // An unrecognised reason is still a real degradation; say so plainly
      // rather than guessing at the local case.
      return 'Unavailable right now.';
  }
}
