// EligibilityIntakeCard — the tenant-only "Eligibility intake" section of the
// Details pane: the structured intake recorded during onboarding (pets, evictions,
// time at current address, LIF eligibility). Renders only the fields that were
// actually recorded, and renders nothing at all when none are — so Team can SEE the
// intake without reopening the editor, without cluttering a fresh tenant's file.
//
// AI review (conversation-fact-extraction): a field written from an extraction
// carries an AutoBadge; a pending suggestion for pets/evictions/tenure renders a
// SuggestionChip on the line below its row.
import type { Contact, FieldSource, SuggestionItem } from '../../api/index.js';
import { Card, KV } from './Card.js';
import { AutoBadge } from './AutoBadge.js';
import { SuggestionChip } from './SuggestionChip.js';
import { SUGGESTION_TARGET_LABEL, suggestionFor } from './suggestionTargets.js';

export interface EligibilityIntakeCardProps {
  contact: Pick<
    Contact,
    | 'pets'
    | 'evictions'
    | 'tenure'
    | 'lifEligible'
    | 'voucher_expiration_date'
    | 'pets_source'
    | 'evictions_source'
    | 'tenure_source'
  >;
  /** Pending AI suggestions for this contact (chips for pets/evictions/tenure). */
  suggestions?: SuggestionItem[];
  onAcceptSuggestion?: (target: string) => void;
  onDismissSuggestion?: (target: string) => void;
  suggestionBusy?: string | null;
  suggestionError?: { target: string; message: string } | null;
}

/** The AI provenance stamp for a field, when its value came from an extraction. */
function aiSource(src: FieldSource | undefined): FieldSource | undefined {
  return src?.source === 'ai' ? src : undefined;
}

/** An ISO instant → a friendly "Mon D, YYYY" date, or '' when unparseable. The
 *  voucher expiration is a calendar DATE canonicalized to UTC midnight, so format
 *  in UTC to recover that exact date (a local-TZ format would shift it a day in
 *  negative-offset zones). */
function friendlyDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function EligibilityIntakeCard({
  contact,
  suggestions = [],
  onAcceptSuggestion,
  onDismissSuggestion,
  suggestionBusy,
  suggestionError,
}: EligibilityIntakeCardProps): React.JSX.Element | null {
  // Extractable intake rows carry a `field` + its AI provenance stamp so we can
  // attach an AutoBadge + a review chip; the derived rows (LIF, voucher expiry) do
  // not.
  const rows: Array<{ k: string; v: string; field?: string; src?: FieldSource }> = [];
  if (contact.pets)
    rows.push({ k: 'Pets', v: contact.pets, field: 'pets', ...(aiSource(contact.pets_source) && { src: aiSource(contact.pets_source) }) });
  if (contact.evictions)
    rows.push({ k: 'Evictions', v: contact.evictions, field: 'evictions', ...(aiSource(contact.evictions_source) && { src: aiSource(contact.evictions_source) }) });
  if (contact.tenure)
    rows.push({ k: 'Time at current address', v: contact.tenure, field: 'tenure', ...(aiSource(contact.tenure_source) && { src: aiSource(contact.tenure_source) }) });
  if (typeof contact.lifEligible === 'boolean') {
    rows.push({ k: 'LIF eligible', v: contact.lifEligible ? 'Yes' : 'No' });
  }
  const voucherExpires = contact.voucher_expiration_date
    ? friendlyDate(contact.voucher_expiration_date)
    : '';
  if (voucherExpires) rows.push({ k: 'Voucher expires', v: voucherExpires });

  if (rows.length === 0) return null;

  const chipFor = (target: string): React.JSX.Element | null => {
    const s = suggestionFor(suggestions, target);
    if (!s) return null;
    return (
      <SuggestionChip
        label={SUGGESTION_TARGET_LABEL[target] ?? target}
        suggestion={s}
        onAccept={() => onAcceptSuggestion?.(target)}
        onDismiss={() => onDismissSuggestion?.(target)}
        busy={suggestionBusy === target}
        error={suggestionError?.target === target ? suggestionError.message : null}
      />
    );
  };

  return (
    <Card title="Eligibility intake">
      {rows.map((r) => (
        <div key={r.k}>
          <KV k={r.k} v={<>{r.v}{r.src ? <AutoBadge {...(r.src.at !== undefined && { at: r.src.at })} /> : null}</>} />
          {r.field ? chipFor(r.field) : null}
        </div>
      ))}
    </Card>
  );
}
