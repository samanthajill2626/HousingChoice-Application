export interface Relationship { role: string; name: string; contactId?: string }
export interface CustomField { label: string; value: string }

export function parseRole(v: unknown): string | { error: string } {
  if (typeof v !== 'string') return { error: 'role must be a string' };
  return v.trim();
}

export function parseRelationships(v: unknown): Relationship[] | { error: string } {
  if (!Array.isArray(v)) return { error: 'relationships must be an array' };
  const out: Relationship[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) return { error: 'each relationship must be an object' };
    const r = raw as Record<string, unknown>;
    const role = typeof r['role'] === 'string' ? r['role'].trim() : '';
    const name = typeof r['name'] === 'string' ? r['name'].trim() : '';
    if (role.length === 0 || name.length === 0) return { error: 'each relationship needs a role and a name' };
    if (r['contactId'] !== undefined && typeof r['contactId'] !== 'string') return { error: 'relationship contactId must be a string' };
    const item: Relationship = { role, name };
    if (typeof r['contactId'] === 'string' && r['contactId'].length > 0) item.contactId = r['contactId'];
    out.push(item);
  }
  return out;
}

export function parseCustomFields(v: unknown): CustomField[] | { error: string } {
  if (!Array.isArray(v)) return { error: 'customFields must be an array' };
  const out: CustomField[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) return { error: 'each custom field must be an object' };
    const c = raw as Record<string, unknown>;
    if (c['value'] !== undefined && typeof c['value'] !== 'string') return { error: 'custom field value must be a string' };
    const label = typeof c['label'] === 'string' ? c['label'].trim() : '';
    if (label.length === 0) continue; // drop empty-label rows
    out.push({ label, value: typeof c['value'] === 'string' ? c['value'] : '' });
  }
  return out;
}
