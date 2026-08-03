// LandlordOnboardingCard — the landlord-only "Landlord onboarding" section of the
// Details pane: the structured deal terms + approval criteria recorded during the
// onboarding call (contract status and the four Yes/No criteria), plus a Park
// reason row shown only when the lead is `parked`. EVERY field always renders -
// an unrecorded one reads as BLANK - because this is a checklist worked through on
// a call, so "nobody has asked yet" must be visible rather than indistinguishable
// from "not applicable". Mirrors EligibilityIntakeCard (the tenant sibling).
// (Expected rent moved to the UNIT 2026-07-10 — it is the property's rent range.)
import type { Contact } from '../../api/index.js';
import { BLANK, Card, KV } from './Card.js';
import { LANDLORD_ONBOARDING_HINTS } from './landlordOnboarding.js';

export interface LandlordOnboardingCardProps {
  contact: Pick<
    Contact,
    | 'status'
    | 'park_reason'
    | 'contract_status'
    | 'registered_landlord'
    | 'rta_within_48h'
    | 'pass_inspection_first_try'
    | 'income_includes_voucher'
  >;
}

const yesNo = (v: boolean | undefined): string =>
  typeof v === 'boolean' ? (v ? 'Yes' : 'No') : BLANK;

export function LandlordOnboardingCard({
  contact,
}: LandlordOnboardingCardProps): React.JSX.Element {
  // Every checklist row ALWAYS renders. An unanswered question reads as BLANK
  // rather than vanishing, so a half-finished onboarding call is visibly
  // different from a complete one.
  const rows: Array<{ k: string; v: string; hint?: string }> = [
    {
      k: 'Contract status',
      v: contact.contract_status
        ? contact.contract_status === 'signed'
          ? 'Signed'
          : 'Unsigned'
        : BLANK,
    },
    {
      k: 'Registered landlord',
      v: yesNo(contact.registered_landlord),
      hint: LANDLORD_ONBOARDING_HINTS.registered_landlord,
    },
    {
      k: 'Submits RTA within 48h',
      v: yesNo(contact.rta_within_48h),
      hint: LANDLORD_ONBOARDING_HINTS.rta_within_48h,
    },
    {
      k: 'Passes inspection first try',
      v: yesNo(contact.pass_inspection_first_try),
      hint: LANDLORD_ONBOARDING_HINTS.pass_inspection_first_try,
    },
    {
      k: 'Voucher counts as income',
      v: yesNo(contact.income_includes_voucher),
      hint: LANDLORD_ONBOARDING_HINTS.income_includes_voucher,
    },
  ];
  // The park reason is status-scoped, not a checklist item: it appears only when the
  // lead is actually parked. But a parked lead with no reason recorded IS a gap, so
  // within that state it follows the same rule and reads BLANK.
  if (contact.status === 'parked') {
    rows.push({ k: 'Park reason', v: contact.park_reason || BLANK });
  }

  return (
    <Card title="Landlord onboarding">
      {rows.map((r) => (
        <KV key={r.k} k={r.k} v={r.v} {...(r.hint !== undefined && { hint: r.hint })} />
      ))}
    </Card>
  );
}
