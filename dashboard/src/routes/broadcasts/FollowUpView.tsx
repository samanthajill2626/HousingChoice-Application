// FollowUpView - Matching's "Follow up" tab (last-heard-from spec 5.6, 14.4).
// The waiting list grouped by property: a group is one available property
// (its short address and its own waiting count), rows longest-waiting first.
// Groups follow the server's order - longest-waiting first overall - so a
// group sorts by its oldest row. A row: the recipient (a link to the contact
// page, where the call action lives - the list adds no Call), Sent <date>,
// Last heard from <date>, the outcome chip, and Interested / Not interested /
// Text. Resolving a row keeps it on screen with its new chip and drops it from
// the counts; Undo puts a not-interested row back.
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ensureContactConversation, setListingSendOutcome, type FollowUpItem } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { daysSince, formatHeardFrom } from '../../lib/heardFrom.js';
// The ONE outcome-error copy rule (W2 Task 3.8): 503 with saved:true ->
// "Saved - reload to see the change.", anything else -> "Couldn't save - try again."
import { outcomeErrorCopy } from '../../lib/listingOutcomeErrors.js';
import { TourChip } from '../contact/Card.js';
import { followUpKey, type FollowUpResolution, type FollowUpsState } from './useFollowUps.js';
import styles from './FollowUpView.module.css';

export interface FollowUpViewProps {
  followUps: FollowUpsState;
  /** The clock for the dates and the N-days chips (tests pin it). */
  now?: Date;
}

const TEXT_FAILED = "Couldn't open the conversation - try again.";

function dayCount(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

function waitingChip(item: FollowUpItem, now: Date): string {
  const n = dayCount(daysSince(item.waitingSince, now));
  return item.outcome === 'replied' ? `Replied, quiet ${n}` : `No reply yet, ${n}`;
}

function groupByUnit(items: readonly FollowUpItem[]): Array<{ unitId: string; unitLabel: string; items: FollowUpItem[] }> {
  const groups = new Map<string, { unitId: string; unitLabel: string; items: FollowUpItem[] }>();
  for (const item of items) {
    let g = groups.get(item.unitId);
    if (g === undefined) {
      g = { unitId: item.unitId, unitLabel: item.unitLabel, items: [] };
      groups.set(item.unitId, g);
    }
    g.items.push(item);
  }
  return [...groups.values()];
}

function FollowUpRow({
  item,
  resolution,
  now,
  onResolve,
  onUnresolve,
}: {
  item: FollowUpItem;
  resolution: FollowUpResolution | undefined;
  now: Date;
  onResolve: (r: FollowUpResolution) => void;
  onUnresolve: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sent = formatHeardFrom(item.sentAt, now);
  const heard = formatHeardFrom(item.lastHeardFromAt, now);
  const unitPath = `/listings/${encodeURIComponent(item.unitId)}`;

  async function record(outcome: 'interested' | 'not_interested' | 'clear'): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { row } = await setListingSendOutcome(item.unitId, item.contactId, outcome);
      if (outcome === 'clear') onUnresolve();
      else if (outcome === 'not_interested') onResolve({ kind: 'not_interested' });
      else onResolve({ kind: 'interested', ...(row.tour !== undefined && { tour: row.tour }) });
    } catch (err) {
      setError(outcomeErrorCopy(err));
    } finally {
      setBusy(false);
    }
  }

  async function openText(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const conversationId = await ensureContactConversation(item.contactId);
      navigate(`/conversations/${encodeURIComponent(conversationId)}`);
    } catch {
      setError(TEXT_FAILED);
      setBusy(false);
    }
  }

  return (
    <li className={styles.row}>
      <span className={styles.who}>
        <Link className={styles.name} to={`/contacts/${encodeURIComponent(item.contactId)}`}>
          {item.name}
        </Link>
      </span>
      <span className={styles.when}>
        {/* Contract N1 (adjudication outcome-F3): a title only when it has text. */}
        <span {...(sent.title !== '' && { title: sent.title })}>
          Sent <b className={styles.date}>{sent.label}</b>
        </span>
        <span {...(heard.title !== '' && { title: heard.title })}>
          Last heard from <b className={styles.date}>{heard.label}</b>
        </span>
      </span>
      <span className={styles.act}>
        {resolution === undefined ? (
          <>
            <span className={`${styles.chip} ${item.outcome === 'replied' ? styles.chipReplied : styles.chipWait}`}>
              {waitingChip(item, now)}
            </span>
            {item.interestedSupported ? (
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={busy}
                aria-label={`Mark ${item.name} interested in ${item.unitLabel}`}
                onClick={() => {
                  if (item.interestedMode === 'route') void record('interested');
                  else navigate(`${unitPath}?tour=new&tenantId=${encodeURIComponent(item.contactId)}`);
                }}
              >
                Interested
              </button>
            ) : item.type === 'partner' ? (
              // Plan review R2 #1 (the B8 rule): the tour link is for a PARTNER
              // recipient only - never a landlord or team-member row, which
              // gets neither Interested nor the link.
              <Link
                className={styles.link}
                to={`${unitPath}?tour=new`}
                aria-label={`Request a tour for ${item.name} at ${item.unitLabel}`}
              >
                Request a tour
              </Link>
            ) : null}
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              aria-label={`Mark ${item.name} not interested in ${item.unitLabel}`}
              onClick={() => void record('not_interested')}
            >
              Not interested
            </button>
          </>
        ) : resolution.kind === 'interested' ? (
          resolution.tour !== undefined ? (
            <TourChip tourId={resolution.tour.tourId} state={resolution.tour.state} />
          ) : (
            <span className={`${styles.chip} ${styles.chipDone}`}>Interested</span>
          )
        ) : (
          <>
            <span className={`${styles.chip} ${styles.chipNo}`}>Not interested</span>
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              aria-label={`Undo not interested for ${item.name}`}
              onClick={() => void record('clear')}
            >
              Undo
            </button>
          </>
        )}
        <button
          type="button"
          className={styles.linkBtn}
          disabled={busy}
          aria-label={`Text ${item.name}`}
          onClick={() => void openText()}
        >
          Text
        </button>
      </span>
      {error !== null ? (
        <p className={styles.rowError} role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function FollowUpView({ followUps, now: nowProp }: FollowUpViewProps): React.JSX.Element {
  const [mountNow] = useState(() => new Date());
  const now = nowProp ?? mountNow;
  const baseId = useId();

  if (followUps.status === 'loading') return <Spinner center />;
  if (followUps.status === 'error') {
    return (
      <div className={styles.error} role="alert">
        <p>We couldn&apos;t load follow-ups.</p>
        <button type="button" className={styles.btn} onClick={() => followUps.retry()}>
          Retry
        </button>
      </div>
    );
  }
  if (followUps.items.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyBody}>Nothing waiting on a reply.</p>
      </div>
    );
  }
  return (
    <div className={styles.view}>
      {followUps.truncated ? (
        <p className={styles.note} role="status">
          Showing follow-ups for the first 100 available properties.
        </p>
      ) : null}
      {groupByUnit(followUps.items).map((group, index) => {
        const headingId = `${baseId}-g${index}`;
        const waiting = group.items.filter((i) => !followUps.resolutions.has(followUpKey(i))).length;
        return (
          <section key={group.unitId} className={styles.group} aria-labelledby={headingId}>
            <h2 id={headingId} className={styles.groupTitle}>
              {group.unitLabel}
              <span className={styles.groupSub}>{waiting} waiting</span>
            </h2>
            <ul className={styles.rows} aria-label={`Waiting on ${group.unitLabel}`}>
              {group.items.map((item) => {
                const key = followUpKey(item);
                return (
                  <FollowUpRow
                    key={key}
                    item={item}
                    resolution={followUps.resolutions.get(key)}
                    now={now}
                    onResolve={(r) => followUps.resolve(item, r)}
                    onUnresolve={() => followUps.unresolve(item)}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
