// Boards (M1.10) — the staff-facing case board (route '/boards'). A kanban:
// one column per stage, each holding the cases whose stage matches (newest-ish
// first). Each card shows the placement_tag (else a caseId stub), a stage badge,
// a "Needs attention" cue when the escalation flag is set, and the tour /
// next-deadline dates when present; tapping a card opens its detail.
//
// LIVE UPDATE (the guarantee): subscribes to the `case.updated` SSE event and
// patches the in-memory case in place — a stage change moves the card to its new
// column, and attention/tour/deadline refresh — without a refetch. A `case.updated`
// for an UNKNOWN caseId (a case created elsewhere) triggers a first-page refetch
// so the new card appears.
//
// This is a deliberately simple operator harness: the first page (limit 100) is
// the working set; columns scroll horizontally on narrow screens.
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listCases,
  useApi,
  useEventStream,
  type CaseItem,
  type CasesPage,
  type CaseStage,
  type CaseUpdatedEvent,
  CASE_STAGES,
} from '../api/index.js';
import { Badge, Button, EmptyState, HomeIcon, PlusIcon, Spinner } from '../ui/index.js';
import {
  CASE_STAGE_LABEL,
  caseStageTone,
  caseTitle,
  formatDate,
  formatDateTime,
  groupByStage,
} from './boards/boards.js';
import styles from './boards/boards.module.css';

const PAGE_LIMIT = 100;

/**
 * Apply a `case.updated` SSE projection onto a stored CaseItem. The event
 * carries only the board-relevant fields, with `attention` as a BOOLEAN and the
 * optional fields as `null` when cleared — so we map them back onto the richer
 * CaseItem shape (a false/null clears the field; a true attention keeps the
 * existing reason object, or seeds a minimal one).
 */
function applyEvent(prev: CaseItem, e: CaseUpdatedEvent): CaseItem {
  const next: CaseItem = {
    ...prev,
    stage: e.stage as CaseStage,
  };
  if (e.tour_date !== null) next.tour_date = e.tour_date;
  else delete next.tour_date;
  if (e.next_deadline_type !== null) {
    next.next_deadline_type = e.next_deadline_type as CaseItem['next_deadline_type'];
  } else delete next.next_deadline_type;
  if (e.next_deadline_at !== null) next.next_deadline_at = e.next_deadline_at;
  else delete next.next_deadline_at;
  if (e.group_thread !== null) next.group_thread = e.group_thread;
  else delete next.group_thread;
  if (e.lost_reason !== null) next.lost_reason = e.lost_reason;
  else delete next.lost_reason;
  if (e.updated_at !== null) next.updated_at = e.updated_at;
  if (e.attention) {
    next.attention = prev.attention ?? { reason: 'needs_attention', at: e.updated_at ?? '' };
  } else {
    delete next.attention;
  }
  return next;
}

export default function Boards(): React.JSX.Element {
  const { data, loading, error, refetch } = useApi(
    (signal) => listCases({ limit: PAGE_LIMIT }, signal),
    [],
  );

  // The live in-memory case list, seeded from the fetched page and patched by
  // SSE events. Re-seeded whenever a fresh fetch lands (refetch supersedes the
  // accumulated live patches). Seeding happens DURING render (not via an effect)
  // so the cards appear in the SAME commit as the page — no empty-state flash,
  // and no fetch→effect race (which made the render test timing-flaky under load).
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [seededFrom, setSeededFrom] = useState<CasesPage | undefined>(undefined);
  if (data !== undefined && data !== seededFrom) {
    setSeededFrom(data);
    setCases(data.cases);
  }

  const onCaseUpdated = useCallback(
    (e: CaseUpdatedEvent) => {
      setCases((prev) => {
        const idx = prev.findIndex((c) => c.caseId === e.caseId);
        if (idx === -1) {
          // A case we don't have yet (created elsewhere) — pull the first page
          // again so the new card shows up with its full detail.
          refetch();
          return prev;
        }
        const updated = [...prev];
        const existing = updated[idx];
        if (existing) updated[idx] = applyEvent(existing, e);
        return updated;
      });
    },
    [refetch],
  );

  useEventStream({ onCaseUpdated });

  if (loading && data === undefined) {
    return (
      <section className={styles.page}>
        <Spinner center label="Loading cases" />
      </section>
    );
  }

  if (error) {
    return (
      <section className={styles.page}>
        <EmptyState
          icon={<HomeIcon size={28} />}
          title="Couldn't load the board"
          description="Something went wrong reaching the server."
          action={
            <Button variant="secondary" onClick={refetch}>
              Try again
            </Button>
          }
        />
      </section>
    );
  }

  const columns = groupByStage(cases, CASE_STAGES);

  return (
    <section className={styles.page} aria-labelledby="boards-heading">
      <header className={styles.header}>
        <div>
          <h1 id="boards-heading">Boards</h1>
          <p className={styles.lead}>
            Each case is one tenant–listing deal moving through the stage ladder.
          </p>
        </div>
        <Button as="a" href="/boards/new" size="sm">
          <PlusIcon size={16} />
          New case
        </Button>
      </header>

      {cases.length === 0 ? (
        <EmptyState
          icon={<HomeIcon size={28} />}
          title="No cases yet"
          description="Open a case with New case to start tracking a deal."
        />
      ) : (
        <div className={styles.board} aria-label="Case board">
          {columns.map((col) => (
            <section
              key={col.stage}
              className={styles.column}
              aria-label={CASE_STAGE_LABEL[col.stage]}
            >
              <div className={styles.columnHead}>
                <span className={styles.columnTitle}>{CASE_STAGE_LABEL[col.stage]}</span>
                <span className={styles.count}>{col.cases.length}</span>
              </div>
              <ul className={styles.cards}>
                {col.cases.map((c) => (
                  <CaseCard key={c.caseId} item={c} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function CaseCard({ item }: { item: CaseItem }): React.JSX.Element {
  const tour = formatDate(item.tour_date);
  const deadline = formatDateTime(item.next_deadline_at);

  return (
    <li>
      <Link to={`/boards/${encodeURIComponent(item.caseId)}`} className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>{caseTitle(item)}</span>
          {item.attention !== undefined && (
            <Badge tone="danger" dot>
              Needs attention
            </Badge>
          )}
        </div>
        <Badge tone={caseStageTone(item.stage)} dot>
          {CASE_STAGE_LABEL[item.stage]}
        </Badge>
        {(tour !== undefined || deadline !== undefined) && (
          <div className={styles.cardMeta}>
            {tour !== undefined && <span className={styles.metaLine}>Tour: {tour}</span>}
            {deadline !== undefined && <span className={styles.metaLine}>Due: {deadline}</span>}
          </div>
        )}
      </Link>
    </li>
  );
}
