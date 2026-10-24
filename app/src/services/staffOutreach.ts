// Staff outreach - the ONE path a live send uses to move a contact's
// last_reached_out_at (spec docs/superpowers/specs/2026-10-23-today-checklist-design.md
// section 7; plan ruling PR5).
//
// THE RULE: every outbound writer decides, explicitly, whether its send is
// staff follow-up (stamp) or not (no stamp). The writer table - which send
// paths stamp (W1-W8) and which never do - lives in the spec, section 7.3.
// Shares, broadcasts, automated sends and machine resends never stamp. A NEW
// send path, including a future agent that sends AS STAFF, either calls this
// helper or is added to the spec's no-stamp table - it never writes the
// attribute itself and never calls touchLastReachedOut directly (the one-time
// backfill script is the only other caller).
//
// Best-effort: awaited, but it never throws and never retries, so a failed
// stamp never fails or retries the send it follows. It emits NO event: the
// caller emits its own ONE event per send operation (contact.updated for a
// one-to-one send, email or call; one conversation.updated for a relay or
// group post), and only when this returned a contact as written. Logs carry
// the contactId only - never a name, phone, body or instant.
import type { Logger } from '../lib/logger.js';
import type { ContactsRepo } from '../repos/contactsRepo.js';

/** One contact an outbound reached, and when. */
export interface StaffOutreachStamp {
  contactId: string;
  /** ISO. The outbound row's own timestamp (a call: the dial instant). */
  at: string;
}

/** Date.parse, with an unparseable instant ordered before every real one. */
function instantMs(at: string): number {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Stamp last_reached_out_at for every contact in `stamps`. A stamp with an
 * empty contactId is dropped; each remaining contact is touched ONCE (one
 * call at a time - at most a relay roster) at its LATEST instant, compared as
 * time, in first-seen order. Returns the contactIds whose touch answered
 * 'written' - the caller's cue to emit. 'skipped' (no row, already as late,
 * unparseable) is silent; 'failed', or a touch that throws or rejects, logs
 * ERROR { contactId } and is not returned. Never throws.
 */
export async function recordStaffOutreach(
  deps: { contacts: Pick<ContactsRepo, 'touchLastReachedOut'>; log: Logger },
  stamps: readonly StaffOutreachStamp[],
): Promise<string[]> {
  const latest = new Map<string, string>();
  for (const { contactId, at } of stamps) {
    if (typeof contactId !== 'string' || contactId.length === 0) continue;
    const held = latest.get(contactId);
    if (held === undefined || instantMs(at) > instantMs(held)) latest.set(contactId, at);
  }
  const written: string[] = [];
  for (const [contactId, at] of latest) {
    let outcome: 'written' | 'skipped' | 'failed';
    try {
      outcome = await deps.contacts.touchLastReachedOut(contactId, at);
    } catch {
      outcome = 'failed';
    }
    if (outcome === 'written') {
      written.push(contactId);
    } else if (outcome === 'failed') {
      deps.log.error({ contactId }, 'staff outreach: last_reached_out_at stamp failed (best-effort; the send stands)');
    }
  }
  return written;
}
