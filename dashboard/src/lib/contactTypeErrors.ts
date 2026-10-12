// contactTypeErrorMessage - the dashboard copy for the contact-type refusals
// (caseworker integrity, spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 4
// "Dashboard copy"; plan section 1 copy table). ONE helper, used at every
// tour, placement and property site that can meet these codes. It returns
// null for anything else, so each site keeps its own fallback copy (plan
// watch item W7). Staff audience: "property", never "listing" (GLOSSARY).
import { ApiError } from '../api/client.js';

/** contactKind (the server's `caseworker`, else the stored type) -> the phrase
 *  that ends the contact_not_tenant sentence (plan ruling P-1). A Map, so an
 *  inherited name such as `toString` never matches. */
const KIND_PHRASE: ReadonlyMap<string, string> = new Map([
  ['tenant', 'a tenant'],
  ['landlord', 'a landlord'],
  ['partner', 'a partner'],
  ['caseworker', 'a caseworker'],
  ['team_member', 'a team member'],
  ['unknown', 'not classified yet'],
]);

/** A missing or unrecognized contactKind (the server sends none today). */
const OTHER_KIND_PHRASE = 'not a tenant';

/** The sentence for a contact-type refusal, or null for any other failure. */
export function contactTypeErrorMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.code) {
    case 'contact_not_tenant': {
      const body = err.body;
      const kind =
        body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['contactKind'] : undefined;
      const phrase = (typeof kind === 'string' ? KIND_PHRASE.get(kind) : undefined) ?? OTHER_KIND_PHRASE;
      return `Tours and placements are for tenants. This contact is ${phrase}.`;
    }
    case 'tenant_not_found':
      return 'That contact no longer exists.';
    case 'landlord_not_landlord':
      return "Only a landlord can be a property's landlord of record.";
    case 'landlord_not_found':
      return 'That landlord no longer exists.';
    case 'contact_list_caseworker':
      return "Caseworkers can't be on a property's contact list.";
    default:
      return null;
  }
}
