// authorityPrefill - matching-blast-rules D3: which of a property's accepted
// housing authorities the blast composer puts in its housing authority filter.
// Each is mapped the way the server maps a filter member (app/src/lib/orgNames.ts
// checkScalarWrite): its exact list name, the name written differently, or a
// spelling exactly ONE housing authority entry carries - through
// settleTypedOrgText, the client mirror the contact and property forms' Save
// already use. Property order, de-duplicated. A name that maps to no entry (or
// to more than one, or to an agency) is `unused`: the composer shows it as
// "Not used (not on the organization list): ...". While the list is unknown
// (still loading, or failed with nothing in hand) nothing can be mapped, and
// both lists are empty - the composer says the list failed instead.
import { HOUSING_AUTHORITY_KINDS, orgListUnknown, settleTypedOrgText, type OrgListView } from '../orgs/orgCopy.js';

export function prefillAuthorities(
  propertyAuthorities: readonly string[],
  list: OrgListView,
): { names: string[]; unused: string[] } {
  if (orgListUnknown(list)) return { names: [], unused: [] };
  const names: string[] = [];
  const unused: string[] = [];
  for (const raw of propertyAuthorities) {
    const text = raw.trim();
    if (text === '') continue;
    const verdict = settleTypedOrgText(list, HOUSING_AUTHORITY_KINDS, text);
    if (verdict.status === 'resolved') {
      if (!names.includes(verdict.name)) names.push(verdict.name);
    } else if (!unused.includes(text)) {
      unused.push(text);
    }
  }
  return { names, unused };
}
