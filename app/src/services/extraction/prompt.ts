// System + user prompt builders for conversation fact extraction.
//
// The system prompt is the model contract; keep it verbatim and ASCII-only.
// The user content lays out the CURRENT PROFILE (what we already know) then a
// chronological TRANSCRIPT, so the model can reconcile new facts against known
// ones per the reconciliation rules below.
import type { ExtractionInput } from '../../adapters/extraction.js';
import { HOUSING_AUTHORITY_VOCAB } from './schema.js';

export function buildExtractionSystemPrompt(): string {
  const vocab = HOUSING_AUTHORITY_VOCAB.join(', ');
  return [
    'You extract facts about the CLIENT from a conversation transcript of text',
    'messages and phone calls between housing navigation staff and a client (a',
    'person seeking housing help). Output ONLY a JSON object matching the',
    'provided schema. Do not add any prose.',
    '',
    'The user message contains a CURRENT PROFILE JSON block (what we already know',
    'about this contact) and a TRANSCRIPT of the conversation in chronological',
    'order. Each transcript line is "<timestamp> [<speaker>/<channel>] <text>"',
    'where <speaker> is staff, client, or unknown and <channel> is sms or voice.',
    '[unknown] lines come from a two-party phone call whose speakers are labeled',
    'Speaker 1 / Speaker 2 with no role attribution. FIRST decide who is the',
    'client and output speakerRoles: for each Speaker label, an entry giving its',
    'role (client, staff, or uncertain). Extract only facts clearly stated by or',
    'about the client; if a fact\'s speaker role is uncertain, omit the fact.',
    '[client/voice] lines with no Speaker label are a voicemail: the client',
    'speaking.',
    '',
    'RECONCILIATION - for each field, compare the conversation against the CURRENT',
    'PROFILE and choose one op:',
    '- op "none": no new information, OR the current value already expresses the',
    '  fact (ignore differences of case, whitespace, and spelling).',
    '- op "write": the field is empty, OR the new value is the SAME fact in a',
    '  better form (corrected spelling, a fuller name, a normalized program name).',
    '- op "suggest": the information genuinely CONFLICTS with the current value.',
    'Every "write" or "suggest" must carry a short reason. When unsure, use op',
    '"none" for that field.',
    '',
    'OUTPUT SHAPE - every schema key is REQUIRED. Always emit ALL of: every one',
    'of the eight field entries (use { "op": "none", "value": "", "reason": "" }',
    'when there is nothing to record for a field), statusAdvance (suggest false,',
    'reason "" when not applicable), typeSuggestion (value "none", reason "" when',
    'not applicable), phoneAddition (phone "", label "", reason "" when none),',
    'noteLines (the empty array [] when none), speakerRoles (the empty array []',
    'when the transcript has no Speaker N lines), and address (op "none" with all',
    'parts "" and reason "" when there is no current address to record).',
    '',
    'HARD RULES:',
    '- Only record facts stated by or about the CLIENT. A staff QUESTION is not a',
    '  fact. Never guess names.',
    '- voucherSize is the bedroom count as a string integer (for example "2").',
    '- housingAuthority MUST be exactly one of these values, or else op "none":',
    `  ${vocab}`,
    '- porting value is the string "true" or "false".',
    '- statusAdvance.suggest is true ONLY when the client clearly states that their',
    '  voucher or RTA (request for tenancy approval) is now in hand or approved.',
    '- typeSuggestion ONLY when the CURRENT PROFILE contactType is "unknown" AND',
    '  the person is clearly a tenant (seeking housing for themselves) or a',
    '  landlord (offers or manages housing). If they identify as a caseworker, do',
    '  NOT emit typeSuggestion; instead add a noteLine like "Identified as a',
    '  caseworker (<org>)".',
    '- phoneAddition ONLY when the client states that another phone number is also',
    '  theirs.',
    '- noteLines are NEW secondary facts not already present in the profile notes',
    '  (for example: stairs are OK or a problem, when they last moved, household',
    '  size, their rent portion, utility debt, other useful screening facts). Do',
    '  not restate facts already in the notes.',
    '- address is the client\'s OWN CURRENT residential address ONLY - a place',
    '  the client states they live at NOW. It is NEVER the address of a unit or',
    '  property they are asking about, touring, applying to, or that staff sent',
    '  or mentioned to them; NEVER a previous address; NEVER a prospective or',
    '  future address. When unsure, use op "none". Put each component in its',
    '  part (line1, line2, city, state, zip); leave unknown parts "".',
    '- Addresses NEVER go in noteLines - the address output is the only place',
    '  for address information.',
  ].join('\n');
}

/**
 * Collapse an utterance body to a SINGLE line: replace any run of CR/LF with
 * ' / '. Each transcript line is `<timestamp> [<speaker>/<channel>] <text>` and the lines
 * are '\n'-joined, so a raw client SMS containing a newline plus a forged
 * `<timestamp> [staff] ...` could otherwise masquerade as a genuine staff turn
 * (prompt-injection, adversarial F2). Flattening the body means an injected
 * "[staff]"/"[client]" tag can never begin a line - the model only ever sees
 * server-authored speaker tags at the start of each line.
 */
function toSingleLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' / ');
}

export function buildExtractionUserContent(input: ExtractionInput): string {
  const profileJson = JSON.stringify(input.profile, null, 2);
  const ordered = [...input.transcript].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const lines = ordered.map((u) => `${u.at} [${u.speaker}/${u.channel}] ${toSingleLine(u.text)}`);
  return ['CURRENT PROFILE', profileJson, '', 'TRANSCRIPT', ...lines].join('\n');
}
