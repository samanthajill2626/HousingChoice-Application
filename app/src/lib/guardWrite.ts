// app/src/lib/guardWrite.ts
// Spec D7a: a write made from a FAILURE arm must never throw out of the
// recipient unit - a throw there is the anchor bug in its most likely form
// (a DB blip under the run-once marker). The attempt record's fence decides
// what the recipient's state is; a lost write is logged at ERROR and left to
// the stale-claim takeover.
//
// `true` means the write RESOLVED, not that a conditional write's fence won:
// a caller that needs the fence's answer captures it inside `fn` (worklist
// G5). The error is logged only under the wired `err` key (the safe
// serializer), never spread into the line.

/** The one method guardWrite needs; a pino Logger satisfies it. */
type ErrorLogger = { error: (obj: Record<string, unknown>, msg: string) => void };

export async function guardWrite(
  log: ErrorLogger,
  ctx: Record<string, unknown>,
  label: string,
  fn: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    log.error({ err, ...ctx, label }, 'failure-arm write failed (best-effort); the attempt record decides');
    return false;
  }
}
