// System + user prompt builders for conversation fact extraction.
//
// The system prompt is the model contract; keep it verbatim and ASCII-only.
// The user content lays out the CURRENT PROFILE (what we already know), then
// the ORGANIZATION LIST block (spec 2026-10-06 D8), then the PROPERTIES SENT
// block (WP1 B1 spec D5.1), then a chronological TRANSCRIPT, so the model can
// reconcile new facts against known ones per the reconciliation rules below.
import { createHash } from 'node:crypto';
import type { ExtractionInput, TranscriptUtterance } from '../../adapters/extraction.js';
import { EXTRACTABLE_FIELDS, EXTRACTION_SCHEMA } from './schema.js';
import { TENANT_MATCHING_INPUTS } from '../../lib/tenantMatchingInputs.js';

/** B1 spec D3: the text-kind tenant matching inputs, which collect facts over time. */
const MATCHING_TEXT_KEYS = TENANT_MATCHING_INPUTS
  .filter((input) => input.kind === 'text')
  .map((input) => input.key);
/** B1 spec D3: the dollars-kind tenant matching inputs. */
const MATCHING_DOLLAR_KEYS = TENANT_MATCHING_INPUTS
  .filter((input) => input.kind === 'dollars')
  .map((input) => input.key);

export function buildExtractionSystemPrompt(): string {
  return [
    'You extract facts about the CURRENT external contact from a conversation',
    'transcript of text messages and phone calls between housing navigation staff',
    'and that contact. The existing wire label "client" means the CURRENT external',
    'contact; it does not assign the contact a housing-related role.',
    'Output ONLY a JSON object matching the provided schema. Do not add any prose.',
    '',
    'The user message contains a CURRENT PROFILE JSON block (what we already know',
    'about this contact), an ORGANIZATION LIST block (the housing authorities and',
    'agencies we already know), a PROPERTIES SENT block (the properties staff sent',
    'this contact, or that the contact signed up for through a flyer, one per line',
    'as "- <label> - sent <date>" or "- <label> - signed up <date>", or',
    '"PROPERTIES SENT: none"), and a TRANSCRIPT of the conversation in chronological',
    'order. Each transcript line is "<timestamp> [<speaker>/<channel>] <text>"',
    'where <speaker> is staff, client, or unknown and <channel> is sms, email, or voice.',
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
    `of the ${EXTRACTABLE_FIELDS.length} field entries (use { "op": "none", "value": "", "reason": "" }`,
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
    '- voucherSize is the bedroom size the client\'s voucher is issued for, as a',
    '  string integer (for example "2"):',
    '  - A home\'s bedrooms are never the voucher size: not a home the client asks',
    '    for, wants, tours, or applies to. A voucher holder may look at homes',
    '    bigger or smaller than their voucher.',
    '  - "I have a 2-bedroom voucher" -> voucherSize "2".',
    '  - "I have a 1-bedroom voucher and want a two-bedroom home" -> voucherSize "1".',
    '  - "Do you have any 3-bedroom homes?" -> voucherSize op "none".',
    '  - "My voucher was reissued as a 3-bedroom" -> voucherSize "3".',
    '- housingAuthority is the organization that runs the client\'s voucher.',
    '  The ORGANIZATION LIST block names the housing authorities we know, each',
    '  with its other spellings, then agencies, which are not housing authorities:',
    '  - Return the full name from the list, exactly as the list writes it.',
    '  - When an abbreviation belongs to more than one name on the list, return',
    '    the one the conversation supports, or return the text as said.',
    '  - Agency names are never housing authorities - never return one here.',
    '  - Where the client lives or wants to live is not a housing authority:',
    '    a county or city name counts only when the client says it runs the voucher.',
    '  - A name that is not on the list is still a real answer -',
    '    record what they said (op "write"). Never answer op "none" merely',
    '    because an authority is missing from the list; a human confirms it.',
    '- porting value is the string "true" or "false".',
    '- The tenant matching fields record what the client says about the home',
    '  they want. Record only what the client states:',
    ...TENANT_MATCHING_INPUTS.map((input) => `  - ${input.key}: ${input.promptGuidance}`),
    `- ${MATCHING_TEXT_KEYS.join(', ')} collect several facts over time:`,
    '  - When the field is empty, op "write" fills it.',
    '  - When the field already holds a value, a new fact that ADDS to it without',
    '    contradicting it (a second neighborhood, another constraint) is not a',
    '    field op: write it as a noteLine instead.',
    '  - Use op "suggest" only when the new fact CONTRADICTS the stored value (for',
    '    example "now wants Decatur, not Marietta"), with the FULL replacement',
    '    value, never only the new part.',
    '  - Never use op "write" on one of these fields when it already holds a value.',
    '    For these fields this replaces the "same fact in a better form" write.',
    `- ${MATCHING_DOLLAR_KEYS.join(', ')} value is whole dollars per month as a digit string (for example "1200").`,
    '- statusAdvance.suggest is true ONLY when the client clearly states that their',
    '  voucher or RTA (request for tenancy approval) is now in hand or approved.',
    '- typeSuggestion is about the CURRENT external contact whose transcript lines',
    '  use the existing "client" speaker label. Use it only when CURRENT PROFILE',
    '  contactType is "unknown" and the current transcript clearly establishes',
    '  exactly one kind.',
    '- Tenant: seeks housing for themselves or their household.',
    '- Landlord: owns or personally offers housing they control.',
    '- Property Manager: manages, leases, lists, or coordinates properties for an',
    '  owner or landlord; working for a landlord is not Partner and does not make',
    '  the contact Landlord.',
    '- Partner: works in an outside service, program, agency, inspection, or',
    '  navigation role and is not the housing seeker, owner, or property manager.',
    '- A represented or mentioned person never determines this contact kind and',
    '  their facts never belong on this profile. Do not guess from an organization',
    '  name or one ambiguous word such as "manager", "agent", or "client"; never infer an organization.',
    '  When evidence overlaps or is unclear, emit value "none".',
    '- A clear Partner or Property Manager identification also adds one concise',
    '  role or organization noteLine, using only stated facts and the existing note',
    '  reconciliation rules.',
    '- Classification examples from the current external contact:',
    '  "I am looking for a two-bedroom home for my family" -> Tenant.',
    '  "I own three rental properties" -> Landlord.',
    '  "I manage three properties for the owner" -> Property Manager (not Landlord and not Partner).',
    '  "I am her caseworker at Hope Atlanta" -> Partner; add "Identified as a caseworker at Hope Atlanta".',
    '  "My caseworker at Hope Atlanta told me to call" -> Tenant only when other current-transcript evidence establishes the caller seeks housing for themselves or their household; mentioned caseworker is not the contact. This sentence alone -> none.',
    '  "I am calling about a client" -> none unless other current-transcript evidence clearly establishes an outside service, program, or navigation role.',
    '  A clear property manager identification can add "Identified as property manager for Example Homes" when stated.',
    '- phoneAddition ONLY when the client states that another phone number is also',
    '  theirs.',
    '- noteLines are facts that might matter to matching this client with a home,',
    '  or to staff understanding their situation, that no field or other output',
    '  covers (for example: when they last moved, household size, work hours,',
    '  utility debt, other useful screening facts). A fact that adds to an',
    '  already-filled tenant matching text field is also a noteLine (see above).',
    '  Profile notes lines beginning "[Auto - <date>]" are your own notes from',
    '  earlier runs.',
    '- Each noteLine is an object: "text" is the line, "confidence" is a number',
    '  from 0 to 1 for how sure you are that the client stated the fact. Lines with',
    '  low confidence are not written, so never inflate it.',
    '- NEVER write a noteLine stating any of these, even when the client says it:',
    '  race, color, religion, sex (including sexual orientation and gender',
    '  identity), national origin; familial facts beyond',
    '  household size (no pregnancy, marital status, children\'s ages or custody);',
    '  disability or medical facts, other than the accessibility need (its field,',
    '  or a noteLine when it adds to the filled field) and an assistance animal.',
    '  Write a need as a feature of the home ("needs a ground floor"), never as a',
    '  diagnosis. Household size, the client\'s own rent portion and an assistance',
    '  animal are allowed. This is the never-written list.',
    '- RECONCILE every noteLine against the profile notes, the same way you',
    '  reconcile a field against its current value. If the notes already express',
    '  the fact and you have nothing to add, omit the line. A fact learned again',
    '  from a later message or call is not a new fact.',
    '- You CANNOT revise or replace a notes line - appending is the only thing a',
    '  noteLine does. So when the notes already cover a fact and you now know',
    '  something MORE about it (a date, a detail, a later confirmation, a change',
    '  of mind), append ONLY what is new and NEVER repeat wording already in the',
    '  notes. Given a note "Toured a 5-bedroom duplex and liked it, wants to move',
    '  forward with application", a correct follow-up line is "Tour was 8/16, unit',
    '  is 5 bed 2 bath" or "Confirmed interest again on 8/17 call" - never a fuller',
    '  retelling of the tour and the application intent.',
    '- Keep every noteLine SHORT: a phrase, not a paragraph. Do not re-establish',
    '  context the notes above it already give.',
    '- FEEDBACK ON A SENT PROPERTY: when the client says anything about a',
    '  property listed in PROPERTIES SENT (likes it, does not, is unsure, asks',
    '  about it, toured it), write a noteLine that NAMES that property by',
    '  copying its label exactly as PROPERTIES SENT writes it (the text after',
    '  "- " and before " - sent" or " - signed up"), then says what the client',
    '  thought in a short phrase, in the client\'s own sense, with the reason',
    '  when one is given. Example: "123 Main St, Decatur: on the fence - likes',
    '  the yard, worried about the commute, wants to see other homes first".',
    '  The wording is yours; no fixed shape, no fixed set of reaction words.',
    '- Say plainly when the client is unsure ("on the fence", "maybe").',
    '  Never turn a maybe into a no.',
    '- Feedback about a place rather than one home ("doesn\'t like that part of',
    '  town") is an ordinary noteLine. Name a sent property only when the',
    '  client tied the feedback to it.',
    '- Feedback the notes already record is not repeated; a CHANGE of mind is',
    '  a new noteLine that SAYS the view changed, e.g. "now likes it" or',
    '  "back on the fence" - a line identical to an earlier notes line is',
    '  never written again, so a change back worded as before is lost.',
    '- Every other noteLine rule applies to feedback, the never-written list',
    '  included.',
    '- address is the client\'s OWN CURRENT residential address ONLY - a place',
    '  the client states they live at NOW. It is NEVER the address of a unit or',
    '  property they are asking about, touring, applying to, or that staff sent',
    '  or mentioned to them; NEVER a previous address; NEVER a prospective or',
    '  future address. When unsure, use op "none". Put each component in its',
    '  part (line1, line2, city, state, zip); leave unknown parts "".',
  ].join('\n');
}

/**
 * sha256 of the assembled system prompt CONCATENATED with the serialized
 * EXTRACTION_SCHEMA, first 12 hex (design 2026-08-06 section 6). Both are sent
 * on the same messages.create call and both define the model contract, so
 * fingerprinting the prompt alone would miss half of it.
 *
 * Memoized: both inputs are module constants, and this is read on every run and
 * on every System Status flags request.
 */
let promptFingerprintCache: string | undefined;
export function extractionPromptFingerprint(): string {
  promptFingerprintCache ??= createHash('sha256')
    .update(buildExtractionSystemPrompt(), 'utf8')
    .update(JSON.stringify(EXTRACTION_SCHEMA), 'utf8')
    .digest('hex')
    .slice(0, 12);
  return promptFingerprintCache;
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

/**
 * Render ONE utterance to its transcript line. THE single renderer: the
 * extraction request is built from it (below) and the run log hashes its output
 * (services/extraction/runWindow.ts), so the recorded hash and the sent bytes
 * can never diverge. Reconstructing this format anywhere else would guarantee a
 * permanent false hash mismatch (design 2026-08-06 section 6.1).
 *
 * Deliberately does NOT render tsMsgId - the wire format is fixed by the system
 * prompt's transcript-line sentence ("<timestamp> [<speaker>/<channel>] <text>").
 */
export function renderUtteranceLine(u: TranscriptUtterance): string {
  return `${u.at} [${u.speaker}/${u.channel}] ${toSingleLine(u.text)}`;
}

export function buildExtractionUserContent(input: ExtractionInput): string {
  const profileJson = JSON.stringify(input.profile, null, 2);
  // GLOBAL sort by timestamp. All utterances of ONE message share that
  // message's timestamp (toUtterances stamps a call's lines with the call row's
  // created_at), and Array.prototype.sort is stable, so per-message order is
  // preserved - which is what makes the per-message hash in runWindow.ts match.
  const ordered = [...input.transcript].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const lines = ordered.map(renderUtteranceLine);
  // Spec 2026-10-06 D8: the organization list sits BEFORE the TRANSCRIPT
  // header - every line after that header must be a rendered transcript line
  // (the run log hashes them), and the block never contains the word.
  const listBlock = input.orgListBlock.length > 0 ? [input.orgListBlock, ''] : [];
  // WP1 B1 spec D5.1: the PROPERTIES SENT block follows, still BEFORE the
  // TRANSCRIPT header, for the same reason; it never holds the word either
  // (sentPropertiesBlock.ts leaves such a line out). The transcript lines and
  // so the run log's per-message hash are untouched.
  const sentBlock = input.sentPropertiesBlock.length > 0 ? [input.sentPropertiesBlock, ''] : [];
  return ['CURRENT PROFILE', profileJson, '', ...listBlock, ...sentBlock, 'TRANSCRIPT', ...lines].join('\n');
}
