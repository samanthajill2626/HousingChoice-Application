// CaseworkerDialog - the caseworker conversion's ONE confirm dialog (spec
// 2026-10-06 D16, D19, D22; plan 3.9). Every entry point opens it: the contact
// header's More actions > "Make caseworker", the Unknown card's "Mark as
// Caseworker" and a Possible caseworkers row. Its host mounts it ONLY while it
// is open, so the read-only preview (GET .../caseworker-review/preview) is read
// only when it opens - nothing loads at the contact page's mount (ruling
// R4-13). It shows what the conversion removes and keeps, every refusal with a
// link to the record to resolve first (Confirm stays disabled while one shows;
// the server re-checks anyway), and an Organization picker over BOTH lists.
// Confirm sends `organization` ONLY when staff changed the picker, so an
// untouched carried value never meets D5. Server codes map to this file's copy
// - ApiError.message is the raw code and is never rendered (A's convention).
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  makeCaseworker,
  previewCaseworker,
  type CaseworkerPreview,
  type CaseworkerRefusal,
  type Contact,
  type OrgRef,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { NewOrgDialog } from '../orgs/NewOrgDialog.js';
import { OrgPicker, type OrgPickerHandle } from '../orgs/OrgPicker.js';
import {
  ORGANIZATION_KINDS,
  notOnListMessage,
  orgListLoadError,
  orgListUnknown,
  orgNotOnListBody,
  refusesSave,
} from '../orgs/orgCopy.js';
import { useOrgList } from '../orgs/useOrgList.js';
import { useTypedOrgText } from '../orgs/useTypedOrgText.js';
import { Modal } from './Modal.js';
import styles from './CaseworkerDialog.module.css';

// isCaseworkerContact is NOT here: it lives in ./caseworkerRole.ts (assembly
// ruling S8-7), so a page that only needs the predicate never imports the dialog.

export const ALREADY_CASEWORKER = 'This contact is already a caseworker. Confirming re-runs the cleanup.';
export const CASEWORKER_STAYS =
  'Past tours, closed placements, properties sent and other details stay on the record.';
export const CONTACT_CHANGED_COPY = 'This contact changed while this was open. Review and try again.';
export const MAKE_CASEWORKER_FAILED = "Couldn't make this contact a caseworker - please try again.";
export const PREVIEW_FAILED = "Couldn't check this contact - please try again.";

/** One refusal's staff sentence and the link to the record that blocks it (plan 3.9). */
export function refusalCopy(refusal: CaseworkerRefusal): { sentence: string; linkText: string; to: string } {
  switch (refusal.code) {
    case 'caseworker_open_placement':
      return {
        sentence: "Finish or close this contact's placement first.",
        linkText: 'View placement',
        to: `/placements/${encodeURIComponent(refusal.placementId)}`,
      };
    case 'caseworker_open_tour':
      return {
        sentence: "Cancel or close this contact's open tour first.",
        linkText: 'View tour',
        to: `/tours/${encodeURIComponent(refusal.tourId)}`,
      };
    case 'caseworker_landlord_of_record':
      return {
        sentence: "This contact is the landlord of record for a property. Change that property's landlord first.",
        linkText: 'View property',
        to: `/listings/${encodeURIComponent(refusal.unitId)}`,
      };
    case 'caseworker_on_roster':
      return {
        sentence: "This contact is on a property's contact list. Remove them from it first.",
        linkText: 'View property',
        to: `/listings/${encodeURIComponent(refusal.unitId)}`,
      };
  }
}

function isRefusal(value: unknown): value is CaseworkerRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v['code']) {
    case 'caseworker_open_placement':
      return typeof v['placementId'] === 'string';
    case 'caseworker_open_tour':
      return typeof v['tourId'] === 'string';
    case 'caseworker_landlord_of_record':
    case 'caseworker_on_roster':
      return typeof v['unitId'] === 'string';
    default:
      return false;
  }
}

const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'caseworker_open_placement',
  'caseworker_open_tour',
  'caseworker_landlord_of_record',
  'caseworker_on_roster',
]);

/** The refusals a 409 `make` carries (plan 3.5: the first refusal's code plus
 *  `refusals`), or null for any other failure. */
function refusalsFrom(err: unknown): CaseworkerRefusal[] | null {
  if (!(err instanceof ApiError) || err.status !== 409 || !REFUSAL_CODES.has(err.code)) return null;
  const body = typeof err.body === 'object' && err.body !== null ? (err.body as Record<string, unknown>) : {};
  const list = Array.isArray(body['refusals']) ? body['refusals'].filter(isRefusal) : [];
  return list.length > 0 ? list : null;
}

function removedLines(preview: CaseworkerPreview): string[] {
  const lines: string[] = [];
  if (preview.removes.housingAuthority !== undefined && preview.removes.housingAuthority !== '') {
    lines.push(`Housing authority: ${preview.removes.housingAuthority}`);
  }
  if (preview.removes.agency !== undefined && preview.removes.agency !== '') {
    lines.push(`Agency: ${preview.removes.agency}`);
  }
  const n = preview.removes.pendingSuggestions;
  if (n > 0) lines.push(n === 1 ? '1 pending AI suggestion' : `${n} pending AI suggestions`);
  return lines;
}

function threadLines(preview: CaseworkerPreview): string[] {
  const { retype, leftShared, leftOther } = preview.threads;
  const lines: string[] = [];
  if (retype > 0) {
    lines.push(
      retype === 1
        ? '1 conversation will become a partner conversation.'
        : `${retype} conversations will become partner conversations.`,
    );
  }
  if (leftShared > 0) {
    lines.push(
      leftShared === 1
        ? '1 shared conversation stays as it is.'
        : `${leftShared} shared conversations stay as they are.`,
    );
  }
  if (leftOther > 0) {
    // Type-less rows only (plan 3.2, R1-F15) - plan 3.9 verbatim.
    lines.push(
      leftOther === 1
        ? '1 conversation without a type stays as it is.'
        : `${leftOther} conversations without a type stay as they are.`,
    );
  }
  return lines;
}

export interface CaseworkerDialogProps {
  contactId: string;
  /** The contact's display name: the dialog is "Make <name> a caseworker". */
  name: string;
  /** The converted contact the server answered with ({ contact }). */
  onConverted: (contact: Contact) => void;
  onClose: () => void;
}

/** One preview read's outcome, tagged with the attempt it answers. */
type Loaded = { attempt: number; preview: CaseworkerPreview } | { attempt: number; failed: true };

export function CaseworkerDialog({ contactId, name, onConverted, onClose }: CaseworkerDialogProps): React.JSX.Element {
  const refusalsId = useId();
  // The two lists behind the Organization picker (spec D17: either kind).
  const orgList = useOrgList();
  const organizationPicker = useRef<OrgPickerHandle>(null);
  const organizationText = useTypedOrgText(orgList, ORGANIZATION_KINDS, organizationPicker);
  // `attempt` re-reads the preview (Try again, contact_changed).
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // What the picker started from (the preview's organization) and what it
  // holds now: `organization` is sent only when the two differ.
  const [baseline, setBaseline] = useState('');
  const [organization, setOrganization] = useState('');
  // Refusals a `make` answered with - they replace the preview's.
  const [serverRefusals, setServerRefusals] = useState<CaseworkerRefusal[] | null>(null);
  // "Is this really new?" (organization mode), opened by the picker's add option.
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    previewCaseworker(contactId, controller.signal).then(
      (preview) => {
        if (controller.signal.aborted) return;
        const start = preview.organization.value ?? '';
        setBaseline(start);
        setOrganization(start);
        setServerRefusals(null);
        setLoaded({ attempt, preview });
      },
      () => {
        if (!controller.signal.aborted) setLoaded({ attempt, failed: true });
      },
    );
    return () => controller.abort();
  }, [contactId, attempt]);

  // A read for an earlier attempt is never shown as this one's.
  const current = loaded !== null && loaded.attempt === attempt ? loaded : null;
  const preview = current !== null && 'preview' in current ? current.preview : null;
  const failed = current !== null && 'failed' in current;
  const refusals = serverRefusals ?? preview?.refusals ?? [];
  const canConfirm = preview !== null && refusals.length === 0 && !busy;

  // Not `use*`: the React Compiler lint would read that name as a hook.
  function applyOrg(ref: OrgRef): void {
    // The server's own answer counts as on the list at once (A's noteAdded).
    orgList.noteAdded(ref);
    setOrganization(ref.name);
    setOrgError(null);
    setAdding(null);
  }

  async function onConfirm(): Promise<void> {
    if (!canConfirm) return;
    // An existing caseworker (B8): the picker is hidden and the server ignores
    // a request organization, so nothing is settled and none is sent.
    const already = preview !== null && preview.alreadyCaseworker;
    // Typed text is never dropped silently (R4-08): text naming one entry is
    // committed as a pick would be; any other text stops Confirm and says why.
    const typed = already ? null : organizationText.settle();
    if (typed !== null && refusesSave(typed)) {
      organizationText.focus();
      return;
    }
    let next = organization;
    if (typed !== null && typed.status === 'resolved') {
      next = typed.name;
      setOrganization(typed.name);
    }
    setBusy(true);
    setError(null);
    setOrgError(null);
    try {
      const contact = await makeCaseworker(contactId, !already && next !== baseline ? { organization: next } : {});
      onConverted(contact);
    } catch (err) {
      const refused = refusalsFrom(err);
      const notOnList = orgNotOnListBody(err);
      if (refused !== null) {
        setServerRefusals(refused);
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'contact_changed') {
        setError(CONTACT_CHANGED_COPY);
        organizationPicker.current?.clearText();
        setAttempt((n) => n + 1);
      } else if (notOnList !== null && notOnList.field === 'organization') {
        setOrgError(notOnListMessage(notOnList));
      } else {
        setError(MAKE_CASEWORKER_FAILED);
      }
      setBusy(false);
    }
  }

  const removed = preview !== null ? removedLines(preview) : [];

  return (
    <>
      <Modal
        title={`Make ${name} a caseworker`}
        onClose={busy ? () => {} : onClose}
        footer={
          <>
            <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="button"
              disabled={!canConfirm}
              aria-describedby={refusals.length > 0 ? refusalsId : undefined}
              onClick={() => void onConfirm()}
            >
              Make caseworker
            </Button>
          </>
        }
      >
        {failed ? (
          <div className={styles.failed}>
            <p className={styles.error} role="alert">
              {PREVIEW_FAILED}
            </p>
            <Button variant="secondary" size="sm" type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : preview === null ? (
          <Spinner center />
        ) : (
          <div className={styles.body}>
            {refusals.length > 0 ? (
              <ul className={styles.refusals} id={refusalsId}>
                {refusals.map((refusal, index) => {
                  const copy = refusalCopy(refusal);
                  return (
                    <li key={`${refusal.code}-${index}`}>
                      {copy.sentence} <Link to={copy.to}>{copy.linkText}</Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {removed.length > 0 ? (
              <>
                <p className={styles.lead}>This removes</p>
                <ul className={styles.list}>
                  {removed.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {threadLines(preview).map((line) => (
              <p key={line} className={styles.note}>
                {line}
              </p>
            ))}
            <p className={styles.note}>{CASEWORKER_STAYS}</p>
            {preview.alreadyCaseworker ? (
              <p className={styles.note}>{ALREADY_CASEWORKER}</p>
            ) : (
              <OrgPicker
                ref={organizationPicker}
                label="Organization"
                kinds={ORGANIZATION_KINDS}
                entries={orgList.entries}
                loading={orgListUnknown(orgList)}
                disabled={organizationText.disabled || busy}
                value={organization}
                onChange={(next) => {
                  setOrganization(next);
                  setOrgError(null);
                }}
                onPendingTextChange={organizationText.onPendingTextChange}
                pendingNote={organizationText.note}
                onRequestAdd={(text) => setAdding(text)}
                error={
                  organizationText.refusal ??
                  orgError ??
                  (orgList.error ? orgListLoadError(ORGANIZATION_KINDS) : null)
                }
                errorAttempt={organizationText.refusalAttempt}
              />
            )}
          </div>
        )}
        {error !== null ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </Modal>
      {/* Stacked on top (Modal's mountedDialogs stack gives it Escape); the
          host never renders this dialog inside a <form>. */}
      {adding !== null ? (
        <NewOrgDialog
          kind="organization"
          mode="field"
          text={adding}
          onUse={(ref) => applyOrg(ref)}
          onAdded={(entry) => applyOrg(entry)}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </>
  );
}
