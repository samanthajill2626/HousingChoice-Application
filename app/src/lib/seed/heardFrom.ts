// Seed derivation of contacts.last_heard_from_at (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// sections 5.1 and 14.2; invariant I4; D13). Runs in seedAll over the MERGED
// rows of whichever profile is loading, through the SAME attributeInbound rule
// the live paths and the backfill use, so a seeded contact's value is exactly
// what the backfill would compute from its seeded rows.
//
// Returns COPIES of every contact item: the SEED and cast item objects are
// module literals other code reads (seedData.test.ts, broadcastApi.test.ts,
// seedPersonaDrift.test.ts, matrix.ts) - an in-place stamp would leak.
import { splitTsMsgId } from '../../repos/messagesRepo.js';
import {
  attributeInbound,
  normalizeInstant,
  type HeardFromLookup,
  type HeardFromRow,
  type HeardFromThread,
} from '../heardFrom.js';

type Row = Record<string, unknown>;

/** Key-only claim/pointer conversation rows (phone#, email#, token#). */
const POINTER_CONVERSATION_PREFIXES = ['phone#', 'email#', 'token#'] as const;
/** Phone/email pointer CONTACT rows - never a stamp target. */
const POINTER_CONTACT_PREFIXES = ['phoneref#', 'emailref#'] as const;

const isPointerContact = (id: string): boolean => POINTER_CONTACT_PREFIXES.some((p) => id.startsWith(p));

/** findByPhone/findByEmail over the seed's own items, pointer rows hopping to
 *  their owner like the real reads (first holder wins, like the GSI). */
function seedLookup(contacts: Row[]): HeardFromLookup {
  const byPhone = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const claim = (map: Map<string, string>, key: unknown, owner: string): void => {
    if (typeof key === 'string' && key.length > 0 && !map.has(key)) map.set(key, owner);
  };
  for (const c of contacts) {
    const id = c['contactId'];
    if (typeof id !== 'string') continue;
    if (isPointerContact(id)) {
      const owner = c['phone_ref_owner'] ?? c['email_ref_owner'];
      if (typeof owner !== 'string') continue;
      claim(byPhone, c['phone'], owner);
      claim(byEmail, c['email'], owner);
      continue;
    }
    claim(byPhone, c['phone'], id);
    claim(byEmail, c['email'], id);
    for (const p of Array.isArray(c['phones']) ? (c['phones'] as Row[]) : []) claim(byPhone, p['phone'], id);
    for (const e of Array.isArray(c['emails']) ? (c['emails'] as Row[]) : []) claim(byEmail, e['email'], id);
  }
  const answer = (map: Map<string, string>, key: string) => {
    const contactId = map.get(key);
    return contactId === undefined ? undefined : { contactId };
  };
  return { byPhone: (e164) => answer(byPhone, e164), byEmail: (address) => answer(byEmail, address) };
}

export async function deriveSeedHeardFrom(messages: Row[], conversations: Row[], contacts: Row[]): Promise<Row[]> {
  const threads = new Map<string, HeardFromThread>();
  for (const c of conversations) {
    const id = c['conversationId'];
    if (typeof id !== 'string' || POINTER_CONVERSATION_PREFIXES.some((p) => id.startsWith(p))) continue;
    threads.set(id, c as unknown as HeardFromThread);
  }
  const lookup = seedLookup(contacts);
  const latest = new Map<string, string>();
  for (const m of messages) {
    // The sid# pointer row has no thread and no direction - skipped here.
    const thread = typeof m['conversationId'] === 'string' ? threads.get(m['conversationId']) : undefined;
    const tsMsgId = m['tsMsgId'];
    if (thread === undefined || typeof tsMsgId !== 'string') continue;
    const contactId = await attributeInbound(m as unknown as HeardFromRow, thread, lookup);
    // Seed rows carry `ts`, not provider_ts: the instant is the key's prefix.
    const at = normalizeInstant(splitTsMsgId(tsMsgId).providerTs);
    if (contactId === undefined || at === undefined) continue;
    const prior = latest.get(contactId);
    if (prior === undefined || at > prior) latest.set(contactId, at);
  }
  return contacts.map((c) => {
    const id = c['contactId'];
    const at = typeof id === 'string' && !isPointerContact(id) ? latest.get(id) : undefined;
    return at === undefined ? { ...c } : { ...c, last_heard_from_at: at };
  });
}
