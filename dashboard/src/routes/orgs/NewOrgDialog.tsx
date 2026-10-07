// NewOrgDialog - "Is this really new?" (spec 2026-10-06 D6, D8, D13). Opened by
// a form picker's "Add <text> as a new ..." option, by Accept on an AI housing
// authority suggestion whose text is not exactly a list name, and by Settings >
// Housing authorities & agencies "Add housing authority" / "Add agency".
// POST /api/organizations/check runs for the CURRENT name, 250 ms after it last
// changed (a caller-held answer for the starting text skips the first), and
// decides what is offered: the name's own match and the closest names first
// ("Use <name>"), the other kind ("<name> is an agency"), a compound name
// pointing to Split, and "Yes, add it" - DISABLED with the reason when the name
// cannot be added (`nameProblem`, D13). The HOST renders this OUTSIDE any
// <form>, and every button carries an explicit type, so nothing here can
// submit an edit form behind it.
import { useEffect, useId, useState } from 'react';
import {
  addOrg,
  checkOrgText,
  type OrgCheckResult,
  type OrgEntry,
  type OrgKind,
  type OrgRef,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import {
  KIND_FIELD_LABEL,
  KIND_NOUN,
  nameProblemCopy,
  orgErrorCopy,
  otherKindOf,
  withArticle,
} from './orgCopy.js';
import styles from './OrgPicker.module.css';

/** How long the dialog waits after the name last changed before checking it. */
export const NEW_ORG_CHECK_DELAY_MS = 250;

/** Spec D13: a name is at most 120 characters (the server's ORG_NAME_MAX). */
const ORG_NAME_MAX = 120;

export type NewOrgDialogMode = 'field' | 'suggestion' | 'settings';

export interface NewOrgDialogProps {
  kind: OrgKind;
  /** The would-be name: what staff typed, what the AI heard, or '' (the
   *  Settings add). Editable (the `Name` textbox) in the 'field' and
   *  'settings' modes; fixed in 'suggestion' - a corrected name is not the
   *  AI's text, and its accept would be refused 422 value_not_from_suggestion. */
  text: string;
  /**
   * 'field': a form picker - every "Use <name>" commits that name.
   * 'suggestion': the AI accept - the text's own resolution and its ambiguity
   *   candidates accept WITH that value; a close (different) name is a normal
   *   contact edit; the other kind offers Dismiss (spec D8).
   * 'settings': the Settings add - names already on the list are listed,
   *   never "used".
   */
  mode: NewOrgDialogMode;
  /** A /check answer the caller already holds for `text`. Absent = the dialog checks. */
  initialCheck?: OrgCheckResult;
  onUse?: (ref: OrgRef, via: 'resolution' | 'close') => void;
  /** Tenant form only: the text is the other kind - put it in that field. */
  onUseOtherField?: (ref: OrgRef) => void;
  /** Suggestion mode: the text is the other kind - dismiss the suggestion. */
  onDismissSuggestion?: () => void;
  onAdded: (entry: OrgEntry) => void;
  onClose: () => void;
}

export function NewOrgDialog({
  kind,
  text,
  mode,
  initialCheck,
  onUse,
  onUseOtherField,
  onDismissSuggestion,
  onAdded,
  onClose,
}: NewOrgDialogProps): React.JSX.Element {
  const nameId = useId();
  const notesId = useId();
  const problemId = useId();
  const nameEditable = mode !== 'suggestion';
  const [name, setName] = useState(text);
  const [notes, setNotes] = useState('');
  const trimmed = name.trim();
  // A check answer belongs to ONE name: an answer for an earlier version of the
  // name is never shown against the current one.
  const [checked, setChecked] = useState<{ name: string; result: OrgCheckResult } | null>(
    initialCheck !== undefined ? { name: text.trim(), result: initialCheck } : null,
  );
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (trimmed === '' || trimmed.length > ORG_NAME_MAX) return undefined;
    // Skip ONLY when the answer held belongs to this very name (the caller's
    // initialCheck for the starting text, or an earlier check): an edit's
    // check replaces the caller's answer, so a name edited back to the
    // starting text is checked again - never left on "Checking the list..."
    // (code review R1-ADV-FE-8).
    if (checked?.name === trimmed) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void checkOrgText({ kind, text: trimmed }, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) setChecked({ name: trimmed, result });
        },
        () => {
          if (!controller.signal.aborted) setFailedFor(trimmed);
        },
      );
    }, NEW_ORG_CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `attempt` re-runs a failed check (Try again).
  }, [kind, trimmed, checked, attempt]);

  const check = checked !== null && checked.name === trimmed ? checked.result : null;
  const checkFailed = failedFor === trimmed;
  // A name over the D13 cap can never be added: say so at once and never send
  // it to POST /check, which refuses a text over 200 characters with a 400 - a
  // check would only dead-end on "Couldn't check the list" (the server stays
  // the authority on the add itself).
  const tooLong = trimmed.length > ORG_NAME_MAX;
  const checking = trimmed !== '' && !tooLong && check === null && !checkFailed;
  const problem = tooLong ? 'org_name_too_long' : check?.nameProblem;
  const addDisabled = busy || trimmed === '' || checking || problem !== undefined;

  const resolution: OrgRef[] =
    check === null ? [] : [...(check.match !== undefined ? [check.match] : []), ...check.candidates];
  const firstResolution = resolution[0];
  const close: OrgRef[] = check === null || resolution.length > 0 ? [] : check.close;
  const other: OrgRef[] = check?.otherKind ?? [];
  const compound: OrgRef[][] = check?.compound ?? [];
  const useButtons = mode !== 'settings' && onUse !== undefined;

  async function add(): Promise<void> {
    if (addDisabled) return;
    setBusy(true);
    setError(null);
    try {
      const entry = await addOrg({ kind, name: trimmed, ...(notes.trim() !== '' && { notes: notes.trim() }) });
      onAdded(entry);
    } catch (err) {
      setError(orgErrorCopy(err));
      setBusy(false);
    }
  }

  function retryCheck(): void {
    setFailedFor(null);
    setAttempt((n) => n + 1);
  }

  function renderNames(refs: readonly OrgRef[], via: 'resolution' | 'close'): React.JSX.Element {
    if (!useButtons) {
      return (
        <ul className={styles.nameList}>
          {refs.map((ref) => (
            <li key={ref.orgId}>{ref.name}</li>
          ))}
        </ul>
      );
    }
    return (
      <div className={styles.choiceButtons}>
        {refs.map((ref) => (
          <Button key={ref.orgId} variant="secondary" size="sm" type="button" disabled={busy} onClick={() => onUse?.(ref, via)}>
            {`Use ${ref.name}`}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <Modal
      title="Is this really new?"
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
            onClick={() => void add()}
            disabled={addDisabled}
            {...(problem !== undefined && { 'aria-describedby': problemId })}
          >
            {busy ? 'Adding...' : 'Yes, add it'}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.dialogText}>
          {`Check that this ${KIND_NOUN[kind]} is not already on the list under another name.`}
        </p>
        {nameEditable ? (
          <div className={styles.dialogField}>
            <label htmlFor={nameId} className={styles.dialogLabel}>
              Name
            </label>
            <input
              id={nameId}
              className={styles.dialogInput}
              type="text"
              value={name}
              maxLength={ORG_NAME_MAX}
              autoComplete="off"
              disabled={busy}
              autoFocus={mode === 'settings'}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
          </div>
        ) : (
          <p className={styles.dialogText}>
            {`${KIND_FIELD_LABEL[kind]}: `}
            <strong>{trimmed}</strong>
          </p>
        )}
        {checking ? <p className={styles.dialogMuted}>Checking the list...</p> : null}
        {checkFailed ? (
          <div role="alert" className={styles.dialogAlert}>
            <p className={styles.dialogText}>
              {"Couldn't check the list - you can still add the name; the list refuses one it already has."}
            </p>
            <Button variant="secondary" size="sm" type="button" onClick={retryCheck} disabled={busy}>
              Try again
            </Button>
          </div>
        ) : null}
        {resolution.length > 0 ? (
          <div className={styles.choiceGroup}>
            <p className={styles.dialogText}>
              {resolution.length === 1 && firstResolution !== undefined
                ? `It is already on the list as ${firstResolution.name}.`
                : `It is a spelling of more than one ${KIND_NOUN[kind]}:`}
            </p>
            {renderNames(resolution, 'resolution')}
          </div>
        ) : null}
        {close.length > 0 ? (
          <div className={styles.choiceGroup}>
            <p className={styles.dialogText}>Close names already on the list:</p>
            {renderNames(close, 'close')}
          </div>
        ) : null}
        {other.length > 0 ? (
          <div className={styles.choiceGroup}>
            <p className={styles.dialogText}>
              {`${trimmed} is ${withArticle(otherKindOf(kind))}, not ${withArticle(kind)}.`}
            </p>
            {onUseOtherField !== undefined ? (
              <div className={styles.choiceButtons}>
                {other.map((ref) => (
                  <Button
                    key={ref.orgId}
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={busy}
                    onClick={() => onUseOtherField(ref)}
                  >
                    {other.length === 1
                      ? `Put it in ${KIND_FIELD_LABEL[ref.kind]}`
                      : `Put ${ref.name} in ${KIND_FIELD_LABEL[ref.kind]}`}
                  </Button>
                ))}
              </div>
            ) : null}
            {mode === 'suggestion' && onDismissSuggestion !== undefined ? (
              <div className={styles.choiceButtons}>
                <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={onDismissSuggestion}>
                  Dismiss suggestion
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {compound.length > 0 ? (
          <p className={styles.dialogText}>
            {`${trimmed} names more than one organization (${compound
              .map((span) => span.map((ref) => ref.name).join(' or '))
              .join(' and ')}). Pick each one in its own field; for a value already stored, use Split on Settings > Housing authorities & agencies.`}
          </p>
        ) : null}
        <div className={styles.dialogField}>
          <label htmlFor={notesId} className={styles.dialogLabel}>
            Notes
          </label>
          <textarea
            id={notesId}
            className={styles.dialogTextarea}
            value={notes}
            rows={2}
            maxLength={500}
            disabled={busy}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        {problem !== undefined ? (
          <p id={problemId} className={styles.problem}>
            {`Cannot add it: ${nameProblemCopy(problem, check ?? undefined)}`}
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
