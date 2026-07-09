// Shared seed-row typing. Seed rows are flexible documents on purpose (the
// repos store any key), but fields with an app-wide CONTRACT must be typed so
// tsc catches shape drift at the literal. `participants` is the first such
// field: a roster of bare contactId strings (or a forgotten []) type-checks as
// Record<string, unknown>, seeds fine, then breaks every roster consumer — the
// inbox group label falls back to the raw pool number, the group Members panel
// renders empty, and a relay fan-out has no phones to send to (see
// app/test/seedRosterShape.test.ts for the runtime guard on the same contract).
import type { ConversationParticipant } from '../../repos/conversationsRepo.js';

/** A seeded conversation-table row: any keys, but the roster (when present)
 *  MUST be ConversationParticipant objects — never bare contactId strings. */
export type SeedConversationRow = Record<string, unknown> & {
  participants?: ConversationParticipant[];
};
