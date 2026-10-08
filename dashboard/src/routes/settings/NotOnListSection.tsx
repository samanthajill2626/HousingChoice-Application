// NotOnListSection - "Not on the list" on Settings > Housing authorities &
// agencies (spec 2026-10-06 D10, D11). Every distinct stored value that is not
// exactly a list name for its field - contacts of every type and properties,
// deleted ones included - one row per value and field, with its record counts
// and what it resolves to (D4). Everyone sees the rows and, through "Show
// records", the records holding a value (per-record links - R5 ruling, never
// facet URLs). Admins settle a value with one rewrite (D11): in the detail
// panel (design review 2026-10-07 Option B) they pick what it becomes from
// one radio group, and the confirm under the pick repeats the action (S14
// L3-L6). The list of values itself is OrgListPane's NotOnListList.
import { useEffect, useId, useRef, useState } from 'react';
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
import { PanelBack } from './OrgDetailPanel.js';
import { valueKey } from './orgSelection.js';
import styles from './OrgListSection.module.css';
import layout from './OrgSettings.module.css';

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

/** "a", "a or b", "a, b or c". */
function orList(values: readonly string[]): string {
  if (values.length <= 1) return values.join('');
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1] ?? ''}`;
}

/**
 * Which stored values one settle rewrites together - the server's own
 * equality (app/src/services/orgRecords.ts, the value actions' matching): a
 * value is matched by its NORMALIZED text, unless that normalizes to '' (a
 * placeholder such as "-" or "()"), which is matched by its TRIMMED EXACT
 * text instead (code review R2-FE-4). The two key forms cannot collide: a
 * normalized text never holds the punctuation every placeholder is made of.
 */
function rewriteKey(value: string): string {
  const normalized = normalizeOrgText(value);
  return normalized !== '' ? normalized : `exact:${value.trim()}`;
}

/**
 * The records a settle of `row` reaches, for its confirm: "3 records (+1
 * deleted)". A rewrite matches NORMALIZED text (spec D11), so settling one
 * row also rewrites the holders of every other row of the same field whose
 * value is written the same way ("AHA", "aha", "A.H.A."): those are counted
 * too, and named - "6 records (+1 deleted), written as AHA, aha or A.H.A."
 * (code review R1-ADV-FE-9). Placeholder values group only by their trimmed
 * text, as the server matches them (rewriteKey).
 */
function recordsText(row: NotOnListRow, rows: readonly NotOnListRow[]): string {
  const key = rewriteKey(row.value);
  const siblings = rows.filter((r) => r.field === row.field && rewriteKey(r.value) === key);
  const group = siblings.some((r) => r.value === row.value) ? siblings : [row, ...siblings];
  const count = group.reduce((n, r) => n + r.count, 0);
  const deleted = group.reduce((n, r) => n + r.deletedCount, 0);
  const records = `${count} ${count === 1 ? 'record' : 'records'}`;
  const reach = deleted > 0 ? `${records} (+${deleted} deleted)` : records;
  return group.length > 1 ? `${reach}, written as ${orList(group.map((r) => r.value))}` : reach;
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

/**
 * The page's ONE in-flight settle (code review r1 F1). A settle request is
 * owned by the page, not by the panel that sent it: while it is out, every
 * settle group locks, so no second request can go out - not from another
 * pick (which remounts the confirm) and not from another value's panel.
 */
export interface SettleGate {
  /** The value whose request is out (orgSelection.valueKey), or null. */
  pendingKey: string | null;
  /** Claim the one slot, synchronously; false while a request is out. */
  begin: (key: string) => boolean;
  /** The request answered, either way: release the slot. */
  end: () => void;
}

interface SettleConfirmProps {
  settle: Settle;
  entries: readonly OrgEntry[];
  /** Every "Not on the list" row: the confirm counts the settled row's
   *  siblings (recordsText). */
  rows: readonly NotOnListRow[];
  gate: SettleGate;
  onDone: (result: OrgRewriteStarted) => void;
  /** The request failed after this confirm left the screen: the page says so. */
  onFailedAway: (message: string) => void;
  /** Clear the pick (Cancel). */
  onCancel: () => void;
}

/** The confirm under the picked choice in "Settle this value": one rewrite of
 *  every record holding the value in the row's field (spec D10, D11). It says
 *  what will change and its button repeats the action. */
function SettleConfirm({
  settle,
  entries,
  rows,
  gate,
  onDone,
  onFailedAway,
  onCancel,
}: SettleConfirmProps): React.JSX.Element {
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
  // Still on screen? A failure that lands after the admin moved on (another
  // row, Close, the browser's Back) is handed to the page instead of being
  // set on a confirm nobody can see. Set in the effect, so StrictMode's
  // mount-cleanup-mount ends mounted.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
  const records = recordsText(row, rows);
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
    if (busy || request === null || !gate.begin(valueKey(row.field, row.value))) return;
    setBusy(true);
    setError(null);
    try {
      const result = await resolveNotOnList(request);
      gate.end();
      onDone(result);
    } catch (err) {
      gate.end();
      const message = orgErrorCopy(err);
      if (mounted.current) {
        setError(message);
        setBusy(false);
      } else {
        onFailedAway(message);
      }
    }
  }

  return (
    <div className={layout.confirm}>
      <div className={styles.dialogBody}>
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
      <div className={layout.confirmActions}>
        <Button
          variant={settle.action === 'clear' ? 'danger' : 'primary'}
          size="sm"
          type="button"
          onClick={() => void confirm()}
          disabled={busy || request === null}
        >
          {confirmLabel}
        </Button>
        <Button variant="secondary" size="sm" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Why settling waits - visible text, never a title (review P11). */
export const SETTLE_WAIT_REASON = 'Another update is still running. Settling waits until it finishes.';
/** This value's own request is out (code review r1 F1). */
export const SETTLE_SENDING = 'Settling this value - waiting for the answer.';
/** Another value's request is out: one settle at a time. */
export const SETTLE_OTHER_PENDING = 'Another value is still being settled. Settling waits until it answers.';

export interface NotOnListPanelProps {
  row: NotOnListRow;
  /** Every "Not on the list" row: the confirm counts the value's siblings. */
  rows: readonly NotOnListRow[];
  /** Both lists: the pickers in "Use another name" and Split. */
  entries: readonly OrgEntry[];
  isAdmin: boolean;
  /** True while a rewrite runs: settling waits (one at a time, spec D11). */
  rewriteLive: boolean;
  /** One pane at a time (the two-pane shell's narrow width). */
  narrow: boolean;
  headingRef: React.Ref<HTMLHeadingElement>;
  /** The page's one in-flight settle: locks every settle group while out. */
  settleGate: SettleGate;
  /** A settle started (202): the page re-reads and names skipped spellings. */
  onSettled: (result: OrgRewriteStarted) => void;
  /** A settle failed after this panel left the screen. */
  onSettleFailedAway: (message: string) => void;
}

/**
 * One "Not on the list" value in the detail panel (design review 2026-10-07
 * Option B): its field, its records and what it resolves to, and "Show
 * records" for everyone. An admin settles it in ONE pick-and-confirm step: the
 * choices settleChoices() allows, as one radio group (Clear last, set apart),
 * and under the picked one its confirm. Absent for a VA (spec D10).
 */
export function NotOnListPanel({
  row,
  rows,
  entries,
  isAdmin,
  rewriteLive,
  narrow,
  headingRef,
  settleGate,
  onSettled,
  onSettleFailedAway,
}: NotOnListPanelProps): React.JSX.Element {
  const headingId = useId();
  const recordsId = useId();
  const choiceName = useId();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const radios = useRef(new Map<string, HTMLInputElement>());
  const choices = isAdmin ? settleChoices(row) : [];
  const chosen = choices.find((c) => c.label === picked);
  // Settling waits while a rewrite runs (D11) and while ANY settle request is
  // out (F1): the pick cannot change under a request, and no second one goes.
  const pendingKey = settleGate.pendingKey;
  const reason = rewriteLive
    ? SETTLE_WAIT_REASON
    : pendingKey === null
      ? null
      : pendingKey === valueKey(row.field, row.value)
        ? SETTLE_SENDING
        : SETTLE_OTHER_PENDING;
  // Cancel clears the pick; focus stays on the choice it cleared.
  const cancel = (): void => {
    if (picked !== null) radios.current.get(picked)?.focus();
    setPicked(null);
  };
  return (
    <section className={layout.panel} aria-labelledby={headingId}>
      <div className={layout.panelTop}>
        <PanelBack segment="not-on-list" narrow={narrow} />
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className={layout.panelHeading}>
          {row.value}
        </h2>
        <p className={layout.panelKind}>Not on the list</p>
      </div>
      <dl className={layout.facts}>
        <dt className={layout.factLabel}>Field</dt>
        <dd className={layout.factValue}>{FIELD_LABEL[row.field]}</dd>
        <dt className={layout.factLabel}>Records</dt>
        <dd className={layout.factValue}>
          {row.deletedCount > 0 ? `${row.count} (+${row.deletedCount} deleted)` : String(row.count)}
        </dd>
        <dt className={layout.factLabel}>What it is</dt>
        <dd className={layout.factValue}>{resolutionText(row.resolution, row.field)}</dd>
      </dl>
      <div className={layout.recordsBlock}>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          aria-expanded={open}
          aria-controls={open ? recordsId : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide records' : 'Show records'}
        </Button>
        {open ? (
          <div id={recordsId}>
            <HolderList field={row.field} value={row.value} />
          </div>
        ) : null}
      </div>
      {isAdmin ? (
        <fieldset
          className={layout.settle}
          disabled={reason !== null}
          aria-describedby={reason !== null ? reasonId : undefined}
        >
          <legend className={layout.settleLegend}>Settle this value</legend>
          {reason !== null ? (
            <p id={reasonId} className={layout.reason}>
              {reason}
            </p>
          ) : null}
          <div className={layout.choices}>
            {choices.map(({ label, settle }) => (
              <label
                key={label}
                className={`${layout.choice} ${settle.action === 'clear' ? layout.choiceDanger : ''}`.trim()}
              >
                <input
                  ref={(el) => {
                    if (el !== null) radios.current.set(label, el);
                    else radios.current.delete(label);
                  }}
                  type="radio"
                  name={choiceName}
                  value={label}
                  checked={picked === label}
                  onChange={() => setPicked(label)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {chosen !== undefined ? (
            <SettleConfirm
              key={chosen.label}
              settle={chosen.settle}
              entries={entries}
              rows={rows}
              gate={settleGate}
              onDone={onSettled}
              onFailedAway={onSettleFailedAway}
              onCancel={cancel}
            />
          ) : (
            <p className={styles.dialogMuted}>Pick what the value should become, then confirm it.</p>
          )}
        </fieldset>
      ) : null}
    </section>
  );
}
