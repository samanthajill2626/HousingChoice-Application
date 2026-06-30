// EligibilityIntakeCard — the tenant-only "Eligibility intake" section of the
// Details pane: the structured intake recorded during onboarding (pets, evictions,
// time at current address, LIF eligibility). Renders only the fields that were
// actually recorded, and renders nothing at all when none are — so Team can SEE the
// intake without reopening the editor, without cluttering a fresh tenant's file.
import type { Contact } from '../../api/index.js';
import { Card, KV } from './Card.js';

export interface EligibilityIntakeCardProps {
  contact: Pick<Contact, 'pets' | 'evictions' | 'tenure' | 'lifEligible'>;
}

export function EligibilityIntakeCard({
  contact,
}: EligibilityIntakeCardProps): React.JSX.Element | null {
  const rows: Array<{ k: string; v: string }> = [];
  if (contact.pets) rows.push({ k: 'Pets', v: contact.pets });
  if (contact.evictions) rows.push({ k: 'Evictions', v: contact.evictions });
  if (contact.tenure) rows.push({ k: 'Time at current address', v: contact.tenure });
  if (typeof contact.lifEligible === 'boolean') {
    rows.push({ k: 'LIF eligible', v: contact.lifEligible ? 'Yes' : 'No' });
  }

  if (rows.length === 0) return null;

  return (
    <Card title="Eligibility intake">
      {rows.map((r) => (
        <KV key={r.k} k={r.k} v={r.v} />
      ))}
    </Card>
  );
}
