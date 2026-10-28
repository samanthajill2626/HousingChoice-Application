// EligibilityIntakeCard - the tenant-only "Eligibility intake" section of the
// Details pane: the structured intake recorded during onboarding (pets, evictions,
// time at current address, LIF eligibility), then the tenant matching inputs
// (WP1 B1 spec D2: one row per entry of the list in tenantMatchingInputs.ts).
// EVERY field always renders - an unrecorded one reads as BLANK - so Team can SEE
// both what was captured and what is still missing, and so a pending suggestion
// always has a row to hang its chip on.
//
// AI review (conversation-fact-extraction): a field written from an extraction
// carries an AutoBadge; a pending suggestion for an extractable row renders a
// SuggestionChip on the line below it (a portion shows as `$1,200 / month` in
// both the row and the chip).
import type { Contact, FieldSource, SuggestionItem, TenantMatchingInputSources } from '../../api/index.js';
import { BLANK, Card, KV, proseValueClass } from './Card.js';
import { AutoBadge } from './AutoBadge.js';
import { SuggestionChip } from './SuggestionChip.js';
import { SUGGESTION_TARGET_LABEL, suggestionFor } from './suggestionTargets.js';
import {
  TENANT_MATCHING_INPUTS,
  formatTenantMatchingValue,
  type TenantMatchingInputValues,
} from './tenantMatchingInputs.js';

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
  > &
    TenantMatchingInputValues &
    TenantMatchingInputSources;
  /** Pending AI suggestions for this contact (a chip for every extractable row: pets, evictions, tenure and the tenant matching inputs). */
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
}: EligibilityIntakeCardProps): React.JSX.Element {
  // Extractable intake rows carry a `field` + its AI provenance stamp so we can
  // attach an AutoBadge + a review chip; the derived rows (LIF, voucher expiry) do
  // not. EVERY row always renders - an unrecorded field reads as BLANK - so a gap in
  // the intake is visible, and so a pending suggestion always has a row to hang its
  // chip on (see intake-card-hides-pending-suggestions).
  const voucherExpires = contact.voucher_expiration_date
    ? friendlyDate(contact.voucher_expiration_date)
    : '';
  // WP1 B1 (spec D2): one row per tenant matching input, in list order; an
  // entry's `formatSuggested` shows its chip's value as the row shows it, and
  // a free-text entry renders as prose (its line breaks kept, a long value
  // wrapped - E2-readers-2).
  const matchingRows = TENANT_MATCHING_INPUTS.map((input) => {
    const sourceKey = `${input.key}_source` as const;
    const src = aiSource(contact[sourceKey]);
    return {
      k: input.label,
      v: formatTenantMatchingValue(input, contact[input.key]) || BLANK,
      field: input.key,
      ...(src && { src }),
      prose: input.kind === 'text',
      formatSuggested: (raw: string): string => formatTenantMatchingValue(input, raw) || raw,
    };
  });
  const rows: Array<{
    k: string;
    v: string;
    field?: string;
    src?: FieldSource;
    prose?: boolean;
    formatSuggested?: (raw: string) => string;
  }> = [
    {
      k: 'Pets',
      v: contact.pets || BLANK,
      field: 'pets',
      ...(aiSource(contact.pets_source) && { src: aiSource(contact.pets_source) }),
    },
    {
      k: 'Evictions',
      v: contact.evictions || BLANK,
      field: 'evictions',
      ...(aiSource(contact.evictions_source) && { src: aiSource(contact.evictions_source) }),
    },
    {
      k: 'Time at current address',
      v: contact.tenure || BLANK,
      field: 'tenure',
      ...(aiSource(contact.tenure_source) && { src: aiSource(contact.tenure_source) }),
    },
    {
      k: 'LIF eligible',
      v: typeof contact.lifEligible === 'boolean' ? (contact.lifEligible ? 'Yes' : 'No') : BLANK,
    },
    { k: 'Voucher expires', v: voucherExpires || BLANK },
    ...matchingRows,
  ];

  const chipFor = (target: string, format?: (raw: string) => string): React.JSX.Element | null => {
    const s = suggestionFor(suggestions, target);
    if (!s) return null;
    return (
      <SuggestionChip
        label={SUGGESTION_TARGET_LABEL[target] ?? target}
        suggestion={s}
        {...(format && { value: format(s.suggestedValue) })}
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
          <KV k={r.k} v={<>{r.prose ? <span className={proseValueClass}>{r.v}</span> : r.v}{r.src ? <AutoBadge {...(r.src.at !== undefined && { at: r.src.at })} /> : null}</>} />
          {r.field ? chipFor(r.field, r.formatSuggested) : null}
        </div>
      ))}
    </Card>
  );
}
