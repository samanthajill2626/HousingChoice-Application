// ApplyRequirementsDialog - "Apply to properties" (property requirements spec
// 2026-10-20, D8 dialog B). Opening it RE-READS the landlord contact and the
// landlord's properties (the landlord page may have been open for hours), with
// a loading state and, if either read fails, an error with Try again.
//
// LEFT, "What to copy": every item with the landlord's value; items with a
// value start checked, blank ones unchecked and marked "Clears" (checking one
// copies the blank, clearing that item). RIGHT, "Which properties": the
// landlord's properties, each listing - live - the checked items that would
// CHANGE on it, marking the ones that are an OWN VALUE there (D6). A row with
// no changes reads "Already matches" and cannot be checked; a row with an own
// value starts unchecked; any other starts checked. No Select all. The hand
// rules and every other rule live in applyRequirementsModel.ts.
//
// Update sends the checked rows in batches of 100, one after another. A first
// request answering 409 requirements_changed (or failing) re-reads and asks
// for another look; a LATER one that answers 409 or fails stops the run,
// re-reads and says how many landed. ANY request answering 409
// deposit_conflict (the landlord holds both deposit forms) stops the run,
// re-reads and says what to fix (worklist OR-31) - on a later batch after
// saying how many landed (code review R2D-3). When every batch lands the
// page gets the summary (onDone) and closes the dialog.
//
// Worklist OR-17, OR-32 and OR-34 (code review R3-1): EVERY re-read inside
// one open dialog - after a stopped run, or after a first request that failed
// in any way, a 409 requirements_changed or deposit_conflict included -
// continues the same Apply ("... press Update again"), so it keeps what staff
// chose. The left column keeps what staff had checked (carryCheckedItems,
// worklist OR-35): an item the re-read landlord holds a value for, or still
// holds the blank staff saw (a deliberate "Clears"), stays checked; an item
// the landlord has since blanked comes back unchecked; an item staff unchecked
// is never re-checked. The rows keep what staff UNCHECKED by hand
// (carryHandUnchecks), while a row staff CHECKED by hand goes back to its
// starting state (staff confirm a check again) - so no re-read writes more
// than staff chose. Only opening the dialog (its first read, and Try again
// after it failed) starts both columns from the defaults.
import { useEffect, useId, useRef, useState } from 'react';
import {
  ApiError,
  applyLandlordRequirements,
  getAllUnits,
  getContact,
  type ApplyRequirementsResult,
  type Contact,
  type UnitItem,
} from '../../api/index.js';
import { Button, StatusBadge } from '../../ui/index.js';
import {
  REQUIREMENT_ITEMS,
  formatItemValue,
  isItemBlank,
  landlordItemValue,
  type RequirementItemId,
} from '../listing/requirements.js';
import {
  APPLY_BATCH_SIZE,
  APPLY_FAILED_NOTICE,
  APPLY_LOAD_ERROR,
  APPLY_NO_PROPERTIES_REASON,
  DEPOSIT_CONFLICT_NOTICE,
  REQUIREMENTS_CHANGED_NOTICE,
  applyRequestBody,
  applyRows,
  carryCheckedItems,
  carryHandChoices,
  carryHandUnchecks,
  chunk,
  defaultCheckedItems,
  orderedItems,
  propertyRowLabel,
  rowIsChecked,
  stoppedNotice,
  summarizeApply,
  updateButtonLabel,
  type ApplyDoneSummary,
  type ApplyRow,
  type HandChoices,
} from './applyRequirementsModel.js';
import { Modal } from './Modal.js';
import styles from './ApplyRequirementsDialog.module.css';

export interface ApplyRequirementsDialogProps {
  contactId: string;
  /** Every landlord contact the dialog reads (open, Try again, a re-read after
   *  a 409 or a stop): the page takes it, so at close it holds the last one. */
  onLandlordRead: (contact: Contact) => void;
  /** Closed without finishing. `wrote` = an Update was sent from this dialog,
   *  so properties may have changed and the page re-reads them. */
  onClose: (wrote: boolean) => void;
  /** Every batch landed: the page re-reads its properties and shows the summary. */
  onDone: (summary: ApplyDoneSummary) => void;
}

type DialogLoad =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; landlord: Contact; units: UnitItem[] };

/** What staff chose when an Update failed or stopped (OR-17, OR-32, OR-34):
 *  the left column and the row hand choices, for the next successful read to
 *  carry - with the landlord as the dialog showed it at that click, so the
 *  left column can tell an unchanged blank from one that turned blank since
 *  (OR-35). */
interface ApplyCarry {
  checkedItems: ReadonlySet<RequirementItemId>;
  hand: HandChoices;
  landlord: Contact;
}

const ITEM_LABEL: ReadonlyMap<RequirementItemId, string> = new Map(REQUIREMENT_ITEMS.map((item) => [item.id, item.label]));

const isDeleted = (unit: UnitItem): boolean => typeof unit.deleted_at === 'string' && unit.deleted_at.length > 0;

export function ApplyRequirementsDialog({
  contactId,
  onLandlordRead,
  onClose,
  onDone,
}: ApplyRequirementsDialogProps): React.JSX.Element {
  const baseId = useId();
  const [load, setLoad] = useState<DialogLoad>({ phase: 'loading' });
  const [loadNonce, setLoadNonce] = useState(0);
  const [checkedItems, setCheckedItems] = useState<ReadonlySet<RequirementItemId>>(() => new Set());
  const [hand, setHand] = useState<HandChoices>(() => new Map());
  // The notice above the columns, one sentence per entry ([] = none): a LATER
  // batch's deposit_conflict says how many landed, then what to fix (R2D-3).
  const [notice, setNotice] = useState<readonly string[]>([]);
  const [sending, setSending] = useState(false);

  // The latest callbacks (the Modal.tsx onCloseRef precedent): the read effect
  // must not re-run because the page re-rendered with new inline handlers.
  const onLandlordReadRef = useRef(onLandlordRead);
  const onCloseRef = useRef(onClose);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onLandlordReadRef.current = onLandlordRead;
    onCloseRef.current = onClose;
    onDoneRef.current = onDone;
  }, [onLandlordRead, onClose, onDone]);
  // True once an Update was sent: the server may have written even when the
  // answer was lost, so a later close asks the page to re-read.
  const attemptedRef = useRef(false);
  // OR-17 + OR-32 + OR-34: the left column and the row hand choices staff had
  // when an Update failed or stopped (any failure, a first-request 409
  // requirements_changed included). Kept until the next SUCCESSFUL read
  // consumes it - so it survives a failed re-read and Try again; null = the
  // next read starts from the defaults (only the dialog's first read).
  const carryRef = useRef<ApplyCarry | null>(null);
  // False after unmount: an answer that lands later must not touch the page.
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [landlord, units] = await Promise.all([
          getContact(contactId, controller.signal),
          getAllUnits({ landlordId: contactId }, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        // The landlord of record only, never a deleted property (D8) - the
        // server read already narrows both; this keeps the rule here too.
        const listed = units.filter((u) => u.landlordId === contactId && !isDeleted(u));
        // OR-17 + OR-35: a carried left column is judged against this
        // landlord and the one staff saw at the click (and consumed);
        // otherwise the defaults (D8). OR-32: the rows staff unchecked stay
        // unchecked on the re-read rows; every other row starts from its
        // starting state.
        const carried = carryRef.current;
        carryRef.current = null;
        const checked =
          carried !== null
            ? carryCheckedItems(carried.checkedItems, landlord, carried.landlord)
            : defaultCheckedItems(landlord);
        setCheckedItems(checked);
        setHand(carried !== null ? carryHandUnchecks(carried.hand, applyRows(listed, landlord, checked)) : new Map());
        setLoad({ phase: 'ready', landlord, units: listed });
        onLandlordReadRef.current(landlord);
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setLoad({ phase: 'error' });
      }
    })();
    return () => controller.abort();
  }, [contactId, loadNonce]);

  /** Read both again (Try again, and after a 409 or a stopped run). */
  const reload = (): void => {
    setLoad({ phase: 'loading' });
    setLoadNonce((n) => n + 1);
  };

  const ready = load.phase === 'ready' ? load : null;
  const rows: ApplyRow[] = ready !== null ? applyRows(ready.units, ready.landlord, checkedItems) : [];
  const checkedRows = rows.filter((r) => rowIsChecked(r, hand));
  const unitsById = new Map((ready?.units ?? []).map((u) => [u.unitId, u]));

  const toggleItem = (id: RequirementItemId): void => {
    if (ready === null || sending) return;
    const next = new Set(checkedItems);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHand(carryHandChoices(hand, rows, applyRows(ready.units, ready.landlord, next)));
    setCheckedItems(next);
  };

  const toggleRow = (row: ApplyRow): void => {
    if (sending || row.alreadyMatches) return;
    const next = new Map(hand);
    next.set(row.unitId, !rowIsChecked(row, hand));
    setHand(next);
  };

  const close = (): void => {
    if (!sending) onCloseRef.current(attemptedRef.current);
  };

  const onUpdate = async (): Promise<void> => {
    if (ready === null || sending || checkedRows.length === 0) return;
    const { landlord, units } = ready;
    const items = orderedItems(checkedItems);
    const results: ApplyRequirementsResult[] = [];
    setSending(true);
    setNotice([]);
    attemptedRef.current = true;
    // By design (code review RD-10): an Update, once sent, is not cancelled by
    // leaving the page. Cancel is disabled while sending, and an unmount
    // (browser Back / Forward) stops only the UI updates (liveRef) - the
    // remaining batches still go out, one after another, for the landlord
    // this run started on; the landlord page re-reads its properties when it
    // is opened again. The requests carry no AbortSignal on purpose.
    for (const [index, batch] of chunk(checkedRows, APPLY_BATCH_SIZE).entries()) {
      try {
        results.push(await applyLandlordRequirements(contactId, applyRequestBody(batch, items, landlord)));
      } catch (err) {
        if (!liveRef.current) return;
        setSending(false);
        // OR-17 + OR-32 + OR-34 (code review R3-1): EVERY failure - a
        // first-request 409 requirements_changed included - continues the
        // same Apply, so the next read keeps what staff chose, on both sides.
        // OR-35: with the landlord this click was made against.
        carryRef.current = { checkedItems, hand, landlord };
        // D8: a LATER batch says how many properties the batches before it
        // updated.
        const stopped = index > 0 ? [stoppedNotice(summarizeApply(results, units).updated)] : [];
        if (err instanceof ApiError && err.status === 409 && err.code === 'deposit_conflict') {
          // OR-31: on ANY batch - the landlord holds both deposit forms, so
          // the next batch (and pressing Update alone) would be refused the
          // same way. Say what to fix; the re-read shows both forms. Code
          // review R2D-3: on a later batch D8's stop sentence comes first.
          setNotice([...stopped, DEPOSIT_CONFLICT_NOTICE]);
        } else if (index > 0) {
          setNotice(stopped);
        } else if (err instanceof ApiError && err.status === 409 && err.code === 'requirements_changed') {
          setNotice([REQUIREMENTS_CHANGED_NOTICE]);
        } else {
          setNotice([APPLY_FAILED_NOTICE]);
        }
        reload();
        return;
      }
    }
    if (!liveRef.current) return;
    setSending(false);
    onDoneRef.current(summarizeApply(results, units));
  };

  const whichHeadingId = `${baseId}-which`;

  return (
    <Modal
      title="Apply to properties"
      variant="wide"
      onClose={close}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={close} disabled={sending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => void onUpdate()}
            disabled={ready === null || sending || checkedRows.length === 0}
          >
            {updateButtonLabel(checkedRows.length)}
          </Button>
        </>
      }
    >
      {notice.length > 0 ? (
        <div role="alert" className={styles.notice}>
          {notice.map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
        </div>
      ) : null}
      {load.phase === 'loading' ? (
        <p className={styles.muted}>Loading...</p>
      ) : load.phase === 'error' ? (
        <div role="alert" className={styles.loadError}>
          <p>{APPLY_LOAD_ERROR}</p>
          <Button variant="secondary" size="sm" type="button" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : (
        <div className={styles.columns}>
          {/* Planner ruling (accessible names): the left column is a GROUP
              named "What to copy", one checkbox per item named by the item
              label; the right column is a LIST named "Which properties", one
              listitem per property holding exactly one checkbox named by the
              property's label as the landlord page's Properties card shows it. */}
          <fieldset className={styles.column}>
            <legend className={styles.columnHeading}>What to copy</legend>
            <ul className={styles.list}>
              {REQUIREMENT_ITEMS.map((item) => {
                const value = landlordItemValue(load.landlord, item.id);
                const valueId = `${baseId}-item-${item.id}`;
                return (
                  <li key={item.id} className={styles.row}>
                    <label className={styles.check}>
                      <input
                        type="checkbox"
                        checked={checkedItems.has(item.id)}
                        onChange={() => toggleItem(item.id)}
                        disabled={sending}
                        aria-describedby={valueId}
                      />
                      <span>{item.label}</span>
                    </label>
                    <span id={valueId} className={styles.detail}>
                      {isItemBlank(value) ? (
                        <span className={styles.clears}>Clears</span>
                      ) : (
                        formatItemValue(item.id, value)
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <div className={styles.column}>
            <h3 id={whichHeadingId} className={styles.columnHeading}>
              Which properties
            </h3>
            {rows.length === 0 ? (
              <p className={styles.muted}>{APPLY_NO_PROPERTIES_REASON}</p>
            ) : (
              <ul aria-labelledby={whichHeadingId} className={styles.list}>
                {rows.map((row, index) => {
                  const unit = unitsById.get(row.unitId);
                  const changesId = `${baseId}-row-${index}`;
                  return (
                    <li key={row.unitId} className={styles.row}>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={rowIsChecked(row, hand)}
                          onChange={() => toggleRow(row)}
                          disabled={row.alreadyMatches || sending}
                          aria-describedby={changesId}
                        />
                        <span>{unit !== undefined ? propertyRowLabel(unit) : row.unitId}</span>
                      </label>
                      {unit !== undefined ? <StatusBadge kind="listing" status={unit.status} /> : null}
                      <p id={changesId} className={styles.detail}>
                        {row.alreadyMatches
                          ? 'Already matches'
                          : row.changes.map((id, i) => (
                              <span key={id}>
                                {i > 0 ? ', ' : ''}
                                {ITEM_LABEL.get(id) ?? id}
                                {row.own.includes(id) ? <span className={styles.ownMark}> (own value)</span> : null}
                              </span>
                            ))}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
