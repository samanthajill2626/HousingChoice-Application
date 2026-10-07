// NotOnListSection - "Not on the list" on Settings > Housing authorities &
// agencies (spec 2026-10-06 D10, D11). Every distinct stored value that is not
// exactly a list name for its field - contacts of every type and properties,
// deleted ones included - one row per value and field, with its record counts
// and what it resolves to (D4). Everyone sees the rows and, through "Show
// records", the records holding a value (per-record links - R5 ruling, never
// facet URLs). Admins settle a value with one rewrite (D11) through "Settle
// <value>", whose confirm repeats the row's action (S14 L3-L6).
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  checkOrgText,
  getNotOnListRecords,
  resolveNotOnList,
  type HolderRecord,
  type NotOnListResolveBody,
  type NotOnListRow,
  type OrgEntry,
  type OrgRecordField,
  type OrgRewriteStarted,
  type OrgSpellingProblem,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { OrgPicker } from '../orgs/OrgPicker.js';
import {
  AGENCY_KINDS,
  FIELD_LABEL,
  HOUSING_AUTHORITY_KINDS,
  KIND_PLURAL_TITLE,
  holderHref,
  holderKindLabel,
  holderLabel,
  kindForField,
  normalizeOrgText,
  orgErrorCopy,
  resolutionText,
  spellingProblemCopy,
} from '../orgs/orgCopy.js';
import styles from './OrgListSection.module.css';

/** One admin action on one row (spec D10), as its button names it. */
type Settle =
  | { action: 'use'; row: NotOnListRow; name?: string }
  | { action: 'move_to_agency' | 'move_to_housing_authority'; row: NotOnListRow; name: string }
  | { action: 'split'; row: NotOnListRow; name: string; agencyName: string }
  | { action: 'add'; row: NotOnListRow }
  | { action: 'clear'; row: NotOnListRow };

/**
 * The buttons a row offers an admin, in order: "Use <name>" for each name the
 * value resolves to (its match, its candidates, a compound value's halves of
 * the field's kind, its close names); Split for a compound housing authority
 * value on contacts naming one entry of each kind (D10: Split applies only
 * there); Move for the other kind's name (contacts only - a property list
 * takes housing authorities only); "Use another name"; "Add as new" for an
 * unknown value; Clear. A NAME VARIANT - a value that normalizes equal to the
 * matched entry's NAME, e.g. "atlanta housing authority" - offers ONLY "Use
 * <that entry>" (spec D10): a rewrite matches normalized text, so any other
 * action would also rewrite every record holding the exact name, and the
 * server refuses it (409 org_value_is_name_variant).
 */
function settleChoices(row: NotOnListRow): { label: string; settle: Settle }[] {
  const res = row.resolution;
  const kind = kindForField(row.field);
  if (
    res.status === 'match' &&
    res.match !== undefined &&
    normalizeOrgText(row.value) === normalizeOrgText(res.match.name)
  ) {
    return [{ label: `Use ${res.match.name}`, settle: { action: 'use', row, name: res.match.name } }];
  }
  const choices: { label: string; settle: Settle }[] = [];
  const offered = new Set<string>();
  const offerUse = (name: string): void => {
    if (offered.has(name)) return;
    offered.add(name);
    choices.push({ label: `Use ${name}`, settle: { action: 'use', row, name } });
  };
  if (res.match !== undefined) offerUse(res.match.name);
  for (const ref of res.candidates ?? []) offerUse(ref.name);
  const spans = (res.compound ?? []).flat();
  for (const ref of spans) if (ref.kind === kind) offerUse(ref.name);
  const ha = spans.find((r) => r.kind === 'housing_authority');
  const agency = spans.find((r) => r.kind === 'agency');
  if (row.field === 'housingAuthority' && ha !== undefined && agency !== undefined) {
    choices.push({
      label: `Split into ${ha.name} + ${agency.name}`,
      settle: { action: 'split', row, name: ha.name, agencyName: agency.name },
    });
  }
  for (const ref of res.otherKind ?? []) {
    if (row.field === 'housingAuthority' && ref.kind === 'agency') {
      choices.push({ label: `Move to Agency as ${ref.name}`, settle: { action: 'move_to_agency', row, name: ref.name } });
    } else if (row.field === 'agency' && ref.kind === 'housing_authority') {
      choices.push({
        label: `Move to Housing authority as ${ref.name}`,
        settle: { action: 'move_to_housing_authority', row, name: ref.name },
      });
    }
  }
  for (const ref of res.close ?? []) offerUse(ref.name);
  choices.push({ label: 'Use another name', settle: { action: 'use', row } });
  if (res.status === 'unknown') choices.push({ label: 'Add as new', settle: { action: 'add', row } });
  choices.push({ label: 'Clear', settle: { action: 'clear', row } });
  return choices;
}

function rowKey(row: NotOnListRow): string {
  return JSON.stringify([row.field, row.value]);
}

function recordsText(row: NotOnListRow): string {
  const records = `${row.count} ${row.count === 1 ? 'record' : 'records'}`;
  return row.deletedCount > 0 ? `${records} (+${row.deletedCount} deleted)` : records;
}

/** "Show records": every record holding the value, linked to its own page. */
function HolderList({ field, value }: { field: OrgRecordField; value: string }): React.JSX.Element {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; records: HolderRecord[] }>({
    status: 'loading',
    records: [],
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void getNotOnListRecords(field, value, controller.signal).then(
      (records) => {
        if (!controller.signal.aborted) setState({ status: 'ready', records });
      },
      () => {
        if (!controller.signal.aborted) setState({ status: 'error', records: [] });
      },
    );
    return () => controller.abort();
  }, [field, value, attempt]);

  if (state.status === 'loading') return <Spinner size="sm" />;
  if (state.status === 'error') {
    return (
      <div className={styles.errorBlock}>
        <p>{"Couldn't load the records."}</p>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => {
            setState({ status: 'loading', records: [] });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (state.records.length === 0) return <p className={styles.empty}>No record holds this value any more.</p>;
  return (
    <ul className={styles.holders} aria-label={`Records holding ${value}`}>
      {state.records.map((record) => (
        <li
          key={record.kind === 'contact' ? `contact-${record.contactId}` : `unit-${record.unitId}`}
          className={styles.holder}
        >
          <Link className={styles.holderLink} to={holderHref(record)}>
            {holderLabel(record)}
          </Link>
          <span className={styles.holderMeta}>
            {` - ${holderKindLabel(record)}${record.deleted ? ' - deleted' : ''}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface SettleDialogProps {
  settle: Settle;
  entries: readonly OrgEntry[];
  onDone: (result: OrgRewriteStarted) => void;
  onClose: () => void;
}

/** "Settle <value>": one rewrite of every record holding the value in the
 *  row's field (spec D10, D11). The confirm repeats the action. */
function SettleDialog({ settle, entries, onDone, onClose }: SettleDialogProps): React.JSX.Element {
  const { row } = settle;
  const kind = kindForField(row.field);
  const nameId = useId();
  const rememberId = useId();
  const [useName, setUseName] = useState(settle.action === 'use' ? (settle.name ?? '') : '');
  const [splitHa, setSplitHa] = useState(settle.action === 'split' ? settle.name : '');
  const [splitAgency, setSplitAgency] = useState(settle.action === 'split' ? settle.agencyName : '');
  const [addName, setAddName] = useState(row.value.trim());
  const [remember, setRemember] = useState(true);
  const [spellingCheck, setSpellingCheck] = useState<{ forId: string; problem: OrgSpellingProblem | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Remember this spelling" (spec D10, D12): on by default, off - with the
  // reason - when the value cannot become a spelling of the chosen entry. A
  // value that IS the name in other letters or punctuation is known without
  // asking; otherwise POST /check with `spellingFor` (the target entry's
  // orgId) asks. A failed check leaves it on: the server SKIPS a spelling it
  // cannot keep (it never fails the action) and the result names it.
  const target =
    settle.action === 'use' && useName !== ''
      ? entries.find((e) => e.kind === kind && e.name === useName)
      : undefined;
  const sameAsName = target !== undefined && normalizeOrgText(row.value) === normalizeOrgText(target.name);
  const checkForId = target !== undefined && !sameAsName ? target.orgId : undefined;
  useEffect(() => {
    if (checkForId === undefined) return undefined;
    const controller = new AbortController();
    void checkOrgText({ kind, text: row.value, spellingFor: checkForId }, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setSpellingCheck({ forId: checkForId, problem: result.spellingProblem ?? null });
        }
      },
      () => {
        // Unchecked: see above.
      },
    );
    return () => controller.abort();
  }, [kind, row.value, checkForId]);
  const checkedProblem =
    spellingCheck !== null && spellingCheck.forId === checkForId ? spellingCheck.problem : null;
  const rememberProblem: string | null = sameAsName
    ? 'it is the name itself, written another way'
    : checkedProblem !== null
      ? spellingProblemCopy(checkedProblem)
      : null;
  const rememberApplies =
    settle.action === 'use'
      ? target !== undefined
      : settle.action === 'add'
        ? addName.trim() !== '' && normalizeOrgText(addName) !== normalizeOrgText(row.value)
        : false;
  const rememberOn = rememberApplies && remember && rememberProblem === null;

  const field = FIELD_LABEL[row.field];
  const records = recordsText(row);
  let confirmLabel: string;
  let sentence: string;
  let body: NotOnListResolveBody | null;
  switch (settle.action) {
    case 'use':
      confirmLabel = useName === '' ? 'Use' : `Use ${useName}`;
      sentence =
        useName === ''
          ? `Pick the name every record holding this value in ${field} should hold instead (${records}).`
          : `Every record holding this value in ${field} changes to ${useName} (${records}).`;
      body =
        useName === ''
          ? null
          : { field: row.field, value: row.value, action: 'use', name: useName, rememberSpelling: rememberOn };
      break;
    case 'move_to_agency':
      confirmLabel = `Move to Agency as ${settle.name}`;
      sentence = `The value leaves Housing authority and goes into Agency as ${settle.name} on every record that holds it (${records}). A record whose Agency already holds another name is left as it is and counted.`;
      body = { field: row.field, value: row.value, action: 'move_to_agency', name: settle.name };
      break;
    case 'move_to_housing_authority':
      confirmLabel = `Move to Housing authority as ${settle.name}`;
      sentence = `The value leaves Agency and goes into Housing authority as ${settle.name} on every record that holds it (${records}). A record whose Housing authority already holds another name is left as it is and counted.`;
      body = { field: row.field, value: row.value, action: 'move_to_housing_authority', name: settle.name };
      break;
    case 'split':
      confirmLabel = 'Split';
      sentence = `Every record holding this value gets the housing authority below, and the agency below where its Agency is empty; a record whose Agency holds another name keeps it and is counted (${records}).`;
      body =
        splitHa === '' || splitAgency === ''
          ? null
          : { field: row.field, value: row.value, action: 'split', name: splitHa, agencyName: splitAgency };
      break;
    case 'add':
      confirmLabel = 'Add as new';
      sentence = `The name below is added to ${KIND_PLURAL_TITLE[kind]}, then every record holding this value changes to it (${records}).`;
      body =
        addName.trim() === ''
          ? null
          : {
              field: row.field,
              value: row.value,
              action: 'add',
              name: addName.trim(),
              ...(rememberApplies && { rememberSpelling: rememberOn }),
            };
      break;
    default:
      confirmLabel = 'Clear';
      sentence = `The value is removed from ${field} on every record that holds it (${records}).`;
      body = { field: row.field, value: row.value, action: 'clear' };
  }
  const request = body;

  async function confirm(): Promise<void> {
    if (busy || request === null) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await resolveNotOnList(request));
    } catch (err) {
      setError(orgErrorCopy(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Settle ${row.value}`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={settle.action === 'clear' ? 'danger' : 'primary'}
            size="sm"
            type="button"
            onClick={() => void confirm()}
            disabled={busy || request === null}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.dialogText}>
          {`${field}: `}
          <strong>{row.value}</strong>
        </p>
        <p className={styles.dialogText}>{sentence}</p>
        {settle.action === 'use' && settle.name === undefined ? (
          <OrgPicker
            label="Name to use"
            kinds={kind === 'agency' ? AGENCY_KINDS : HOUSING_AUTHORITY_KINDS}
            entries={entries}
            value={useName}
            onChange={setUseName}
            disabled={busy}
          />
        ) : null}
        {settle.action === 'split' ? (
          <>
            <OrgPicker
              label="Housing authority"
              kinds={HOUSING_AUTHORITY_KINDS}
              entries={entries}
              value={splitHa}
              onChange={setSplitHa}
              disabled={busy}
            />
            <OrgPicker
              label="Agency"
              kinds={AGENCY_KINDS}
              entries={entries}
              value={splitAgency}
              onChange={setSplitAgency}
              disabled={busy}
            />
          </>
        ) : null}
        {settle.action === 'add' ? (
          <div className={styles.field}>
            <label htmlFor={nameId} className={styles.label}>
              Name
            </label>
            <input
              id={nameId}
              className={styles.input}
              value={addName}
              maxLength={120}
              disabled={busy}
              autoComplete="off"
              onChange={(e) => setAddName(e.target.value)}
            />
          </div>
        ) : null}
        {rememberApplies ? (
          <div className={styles.checkboxRow}>
            <input
              id={rememberId}
              type="checkbox"
              checked={rememberOn}
              disabled={busy || rememberProblem !== null}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <label htmlFor={rememberId}>Remember this spelling</label>
          </div>
        ) : null}
        {rememberApplies && rememberProblem !== null ? (
          <p className={styles.dialogMuted}>{`Not remembered: ${rememberProblem}.`}</p>
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

function NotOnListTableRow({
  row,
  isAdmin,
  rewriteLive,
  onSettle,
}: {
  row: NotOnListRow;
  isAdmin: boolean;
  rewriteLive: boolean;
  onSettle: (settle: Settle) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const recordsId = useId();
  return (
    <>
      <tr>
        <th scope="row" className={`${styles.cell} ${styles.nameCell}`}>
          {row.value}
        </th>
        <td className={styles.cell}>{FIELD_LABEL[row.field]}</td>
        <td className={styles.cell}>
          {row.deletedCount > 0 ? `${row.count} (+${row.deletedCount} deleted)` : String(row.count)}
        </td>
        <td className={styles.cell}>{resolutionText(row.resolution, row.field)}</td>
        <td className={styles.cell}>
          <div className={styles.actions}>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-expanded={open}
              aria-controls={open ? recordsId : undefined}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Hide records' : 'Show records'}
            </Button>
            {isAdmin
              ? settleChoices(row).map(({ label, settle }) => (
                  <Button
                    key={label}
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={rewriteLive}
                    title={rewriteLive ? 'Another update is still running' : undefined}
                    onClick={() => onSettle(settle)}
                  >
                    {label}
                  </Button>
                ))
              : null}
          </div>
        </td>
      </tr>
      {open ? (
        <tr id={recordsId}>
          <td colSpan={5} className={styles.detailCell}>
            <HolderList field={row.field} value={row.value} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export interface NotOnListSectionProps {
  /** null until the first read. */
  rows: NotOnListRow[] | null;
  error: boolean;
  /** Both lists: the pickers in "Use another name" and Split. */
  entries: readonly OrgEntry[];
  isAdmin: boolean;
  /** True while a rewrite runs: settling waits (one at a time, spec D11). */
  rewriteLive: boolean;
  onRetry: () => void;
  /** A settle started (202): the parent re-reads and names skipped spellings. */
  onSettled: (result: OrgRewriteStarted) => void;
}

export function NotOnListSection({
  rows,
  error,
  entries,
  isAdmin,
  rewriteLive,
  onRetry,
  onSettled,
}: NotOnListSectionProps): React.JSX.Element {
  const headingId = useId();
  const [settling, setSettling] = useState<Settle | null>(null);
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <div className={styles.sectionHead}>
        <h2 id={headingId} className={styles.heading}>
          Not on the list
        </h2>
      </div>
      <p className={styles.lede}>
        Values stored on contacts and properties, deleted ones included, that are not exactly a name on the
        lists. A tenant or a property can also be fixed one at a time on its own page.
      </p>
      {rows === null ? (
        error ? (
          <div className={styles.errorBlock} role="alert">
            <p>{"Couldn't load the values that are not on the list."}</p>
            <Button variant="secondary" size="sm" type="button" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : (
          <div className={styles.center}>
            <Spinner />
          </div>
        )
      ) : rows.length === 0 ? (
        <p className={styles.empty}>Every stored value is on the lists.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.th}>
                  Value
                </th>
                <th scope="col" className={styles.th}>
                  Field
                </th>
                <th scope="col" className={styles.th}>
                  Records
                </th>
                <th scope="col" className={styles.th}>
                  What it is
                </th>
                <th scope="col" className={styles.th}>
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <NotOnListTableRow
                  key={rowKey(row)}
                  row={row}
                  isAdmin={isAdmin}
                  rewriteLive={rewriteLive}
                  onSettle={setSettling}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {settling !== null ? (
        <SettleDialog
          settle={settling}
          entries={entries}
          onDone={(result) => {
            setSettling(null);
            onSettled(result);
          }}
          onClose={() => setSettling(null)}
        />
      ) : null}
    </section>
  );
}
