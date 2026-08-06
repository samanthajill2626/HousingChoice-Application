// Deterministic id derivation — the mechanism that makes re-running the import
// the delta (spec §3.2).
//
// Every write is an upsert on a key derived from the source data, so importing
// the 2026-08-09 cutover export over the top of the 2026-08-05 export converges
// to the same state: no watermark, no delta computation, no duplicate detection,
// and no requirement to wipe the database first. It is also what lets a bug found
// AFTER the number ports be fixed by re-running, when real inbound traffic is
// already landing in the same tables.
//
// Contacts and conversations key on DERIVED identity (phone, participant set)
// rather than the Quo id, because our GSIs force those merges: byPhone is one
// contact per number (828 Quo rows -> 543 people) and byParticipantPhone is one
// 1:1 thread per phone (133 phones appear in >1 Quo conversation). Messages and
// calls keep the Quo id verbatim, so those merges cost no dedupe safety.

import { createHash } from 'node:crypto';

/**
 * Our import namespace UUID (RFC 4122 §4.3). A fixed, arbitrary constant — it
 * only has to never change, because changing it would re-mint every id and turn
 * the next import into a full duplicate of the last one.
 */
const NAMESPACE = 'b7c1f0e4-2a63-4d55-9f18-6e2a0c5d3a71';

/**
 * RFC 4122 version-5 (SHA-1, name-based) UUID.
 *
 * Implemented locally rather than adding a `uuid` dependency: it is ~15 lines,
 * and being able to see exactly what feeds the hash matters more than usual here
 * — the whole idempotency guarantee rests on it.
 */
export function uuidv5(name: string, namespace: string = NAMESPACE): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(nsBytes).update(Buffer.from(name, 'utf8')).digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * contactId for an imported person. Keyed on the E.164 phone — our byPhone GSI
 * is one contact per number, so this is what collapses 828 Quo rows into 543.
 */
export function contactIdForPhone(e164: string): string {
  return uuidv5(`contact:${e164}`);
}

/**
 * conversationId for a 1:1 thread. Keyed on the counterparty phone, NOT the Quo
 * conversationId: 133 phones appear in more than one Quo conversation and our
 * model has exactly one 1:1 thread per phone (byParticipantPhone).
 */
export function conversationIdFor1to1(e164: string): string {
  return uuidv5(`conv1to1:${e164}`);
}

/**
 * conversationId for a multi-party thread. Keyed on the SORTED participant set
 * (excluding our own number), so the same group is the same thread no matter
 * which order the export lists its members in, or which member happened to send
 * the first message we see.
 */
export function conversationIdForGroup(participantE164s: readonly string[]): string {
  const sorted = [...new Set(participantE164s)].sort();
  return uuidv5(`convGroup:${sorted.join(',')}`);
}

/**
 * unitId for an imported property. Keyed on the normalized address — the only
 * stable identity either source offers (Airtable rows have no exported record id
 * and mined addresses have none by construction).
 */
export function unitIdForAddress(normalizedAddress: string): string {
  return uuidv5(`unit:${normalizedAddress}`);
}

/**
 * The messages-table sort key: `<ISO ts>#<id>` (lib/tables.ts calls this
 * `tsMsgId`, "SK ts#msgId").
 *
 * Passing the Quo message/call id straight through is what makes message import
 * free of dedupe logic — the same source row always lands on the same key and
 * simply overwrites itself. Both Quo ids (`AC...`) and our own uuids are opaque
 * here.
 */
export function tsMsgId(isoTimestamp: string, id: string): string {
  return `${isoTimestamp}#${id}`;
}

/**
 * Stable, human-facing workbook row keys (`HC-0001`, `GRP-0007`, `UNIT-0003`).
 *
 * These are the join column the founder must not edit. They are opaque on
 * purpose: Excel reads a leading `+` in an E.164 cell as a formula and hands
 * back a bare integer, which would silently destroy a phone-keyed join on every
 * row she touches (spec §3.3).
 */
export function rowKey(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(4, '0')}`;
}
