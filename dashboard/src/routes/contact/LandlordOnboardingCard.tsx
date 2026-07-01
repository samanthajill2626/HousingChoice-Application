// LandlordOnboardingCard — the landlord-only "Landlord onboarding" section of the
// Details pane: the structured deal terms + approval criteria recorded during the
// onboarding call (contract status, expected rent, and the four Yes/No criteria),
// plus a Park reason row shown only when the lead is `parked`. Renders only the
// fields actually recorded, and renders nothing at all when none are — so Team can
// SEE the onboarding data without reopening the editor, without cluttering a fresh
// landlord's file. Mirrors EligibilityIntakeCard (the tenant sibling).
import type { Contact } from '../../api/index.js';
import { Card, KV } from './Card.js';

export interface LandlordOnboardingCardProps {
  contact: Pick<
    Contact,
    | 'status'
    | 'park_reason'
    | 'contract_status'
    | 'expected_rent'
    | 'registered_landlord'
    | 'rta_within_48h'
    | 'pass_inspection_first_try'
    | 'income_includes_voucher'
  >;
}

const yesNo = (v: boolean): string => (v ? 'Yes' : 'No');

export function LandlordOnboardingCard({
  contact,
}: LandlordOnboardingCardProps): React.JSX.Element | null {
  const rows: Array<{ k: string; v: string }> = [];

  if (contact.contract_status) {
    rows.push({
      k: 'Contract status',
      v: contact.contract_status === 'signed' ? 'Signed' : 'Unsigned',
    });
  }
  if (typeof contact.expected_rent === 'number') {
    rows.push({ k: 'Expected rent', v: String(contact.expected_rent) });
  }
  if (typeof contact.registered_landlord === 'boolean') {
    rows.push({ k: 'Registered landlord', v: yesNo(contact.registered_landlord) });
  }
  if (typeof contact.rta_within_48h === 'boolean') {
    rows.push({ k: 'Submits RTA within 48h', v: yesNo(contact.rta_within_48h) });
  }
  if (typeof contact.pass_inspection_first_try === 'boolean') {
    rows.push({ k: 'Passes inspection first try', v: yesNo(contact.pass_inspection_first_try) });
  }
  if (typeof contact.income_includes_voucher === 'boolean') {
    rows.push({ k: 'Voucher counts as income', v: yesNo(contact.income_includes_voucher) });
  }
  // The park reason is only meaningful when the lead is actually parked.
  if (contact.status === 'parked' && contact.park_reason) {
    rows.push({ k: 'Park reason', v: contact.park_reason });
  }

  if (rows.length === 0) return null;

  return (
    <Card title="Landlord onboarding">
      {rows.map((r) => (
        <KV key={r.k} k={r.k} v={r.v} />
      ))}
    </Card>
  );
}
