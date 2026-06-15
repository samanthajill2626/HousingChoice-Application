// BroadcastResults (M1.8 "Share Listings") — the live results view for one
// broadcast (route '/broadcasts/:id').
//
// Renders the lifecycle status, the summary stat chips (audience / sent /
// delivered / failed / skipped-opted-out / queued), and a per-recipient
// delivery list (reusing DeliveryBadge). Live updates: subscribes to the
// `broadcast.updated` SSE event and patches the stats + status in place; a
// manual Refresh refetches GET results (per-recipient detail only comes from
// the GET, not the event). Honest identity: a recipient with no resolved name
// shows the formatted phone, never a fabricated name.
//
// Dev note: the console driver fires no real delivery callbacks, so most chips
// rest at Queued/Sent — that's expected (see the milestone note).
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getBroadcastResults,
  useApi,
  useEventStream,
  type BroadcastResults as BroadcastResultsData,
  type BroadcastStats,
  type BroadcastStatus,
} from '../../api';
import {
  Badge,
  Button,
  ChevronLeftIcon,
  DeliveryBadge,
  EmptyState,
  Spinner,
} from '../../ui';
import {
  STAT_CHIPS,
  broadcastStatusLabel,
  broadcastStatusTone,
  recipientDeliveryStatus,
  recipientLabel,
} from './broadcast';
import styles from './BroadcastResults.module.css';

export default function BroadcastResults(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const broadcastId = id ?? '';
  const navigate = useNavigate();

  const { data, loading, error, refetch } = useApi(
    (signal) => getBroadcastResults(broadcastId, signal),
    [broadcastId],
  );

  // Live patch from the SSE event: status + stats arrive on broadcast.updated
  // without the recipients map, so we overlay them on top of the fetched data.
  const [livePatch, setLivePatch] = useState<
    { status: BroadcastStatus; stats: BroadcastStats } | undefined
  >(undefined);

  useEventStream({
    onBroadcastUpdated: useCallback(
      (event: { broadcastId: string; status: BroadcastStatus; stats: BroadcastStats }) => {
        if (event.broadcastId !== broadcastId) return;
        setLivePatch({ status: event.status, stats: event.stats });
      },
      [broadcastId],
    ),
  });

  // A fresh fetch supersedes a stale live patch (refetch carries the recipients
  // map too, which the event lacks) — clear the patch when new data lands.
  const merged = useMemo<BroadcastResultsData | undefined>(() => {
    if (data === undefined) return undefined;
    if (livePatch === undefined) return data;
    return { ...data, status: livePatch.status, stats: livePatch.stats };
  }, [data, livePatch]);

  const handleRefresh = useCallback(() => {
    setLivePatch(undefined);
    refetch();
  }, [refetch]);

  if (loading && data === undefined) {
    return (
      <section className={styles.page}>
        <Spinner center label="Loading broadcast" />
      </section>
    );
  }

  if (error || merged === undefined) {
    const notFound = error?.status === 404 || error?.code === 'broadcast_not_found';
    return (
      <section className={styles.page}>
        <EmptyState
          title={notFound ? 'Broadcast not found' : "Couldn't load this broadcast"}
          description={
            notFound
              ? 'This broadcast may have been removed.'
              : 'Something went wrong loading the broadcast.'
          }
          action={
            <Button variant="secondary" onClick={() => navigate('/units')}>
              Back to listings
            </Button>
          }
        />
      </section>
    );
  }

  return <ResultsView data={merged} onRefresh={handleRefresh} />;
}

function ResultsView({
  data,
  onRefresh,
}: {
  data: BroadcastResultsData;
  onRefresh: () => void;
}): React.JSX.Element {
  // Per-recipient list. The contactKey carries the phone for `phone#` keys; an
  // unresolved contactId falls back to a short id stub (never a fabricated name).
  // The preview sample is not on the results payload, so we have no name map
  // here — labels resolve from the key alone (honest fallback).
  const noNames = useMemo(() => new Map<string, string>(), []);
  const recipientEntries = Object.entries(data.recipients);

  return (
    <section className={styles.page} aria-labelledby="broadcast-heading">
      <Link to="/units" className={styles.back}>
        <ChevronLeftIcon size={16} />
        Back to listings
      </Link>

      <header className={styles.header}>
        <div>
          <h1 id="broadcast-heading">Broadcast results</h1>
          <p className={styles.lead}>
            {data.unitId !== null ? (
              <Link to={`/units/${encodeURIComponent(data.unitId)}`}>View shared listing</Link>
            ) : (
              'General broadcast'
            )}
          </p>
        </div>
        <Badge tone={broadcastStatusTone(data.status)} dot>
          {broadcastStatusLabel(data.status)}
        </Badge>
      </header>

      <div className={styles.toolbar}>
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </div>

      {data.last_error !== undefined && (
        <p className={styles.error} role="alert">
          {data.last_error}
        </p>
      )}

      <div className={styles.surface}>
        <h2 className={styles.sectionTitle}>Delivery summary</h2>
        <div className={styles.chips} aria-label="Broadcast statistics">
          {STAT_CHIPS.map((chip) => (
            <div key={chip.key} className={styles.chip}>
              <span className={styles.chipValue}>{data.stats[chip.key]}</span>
              <Badge tone={chip.tone} dot>
                {chip.label}
              </Badge>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.surface}>
        <h2 className={styles.sectionTitle}>Recipients ({recipientEntries.length})</h2>
        {recipientEntries.length === 0 ? (
          <p className={styles.lead}>
            No recipients yet. They’re snapshotted when the broadcast is sent.
          </p>
        ) : (
          <ul className={styles.recipients} aria-label="Per-recipient delivery">
            {recipientEntries.map(([key, r]) => {
              const delivery = recipientDeliveryStatus(r.status);
              return (
                <li key={key} className={styles.recipient}>
                  <span className={styles.who} title={recipientLabel(key, noNames)}>
                    {recipientLabel(key, noNames)}
                  </span>
                  {delivery !== undefined ? (
                    <DeliveryBadge
                      status={delivery}
                      {...(r.errorCode !== undefined && { errorCode: r.errorCode })}
                    />
                  ) : (
                    <Badge tone="warning" dot>
                      Skipped
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
