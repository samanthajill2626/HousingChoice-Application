// CaseDetail — a single placement's detail page (F2.3) at /cases/:caseId. Shows
// the stage label + phase, tenant (home) + listing links, time-in-stage
// (stage_entered_at), the lost reason (via formatLostReason), and
// inspection_outcome + final_rent (the latter read off the linked unit) where
// present. A full "Move to…" stage picker drives transitions through the SAME
// gated pipeline as the board (lost → LostReasonModal; OUT of
// awaiting_rent_acceptance → finalRent; OUT of awaiting_inspection →
// inspectionOutcome). A history panel (useCaseHistory) renders the audit rows
// newest-first with "load more".
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  PLACEMENT_STAGES,
  STAGE_LABELS,
  STAGE_PHASE,
  formatLostReason,
  getCase,
  getContact,
  getUnit,
  transitionPlacement,
  useEventStream,
  type CaseItem,
  type CaseUpdatedEvent,
  type Contact,
  type LostReason,
  type PlacementStage,
  type UnitItem,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { Card, EmptyRow, KV } from '../contact/Card.js';
import { formatMoney } from '../listing/listingFormat.js';
import { contactDisplayName, formatAddress } from '../contact/format.js';
import { dateTime, historyTitle, shortDate, summarizeHistory } from './casesFormat.js';
import { gateFor, type TransitionGate } from './transitionGate.js';
import { LostReasonModal } from './LostReasonModal.js';
import { MovePromptModal, type MovePromptResult } from './MovePromptModal.js';
import { useCaseHistory } from './useCaseHistory.js';
import styles from './CaseDetail.module.css';

interface PendingMove {
  toStage: PlacementStage;
  gate: TransitionGate;
}

export function CaseDetail(): React.JSX.Element {
  const { caseId = '' } = useParams<{ caseId: string }>();
  // Consolidated load state keyed by forId — loading is DERIVED during render
  // when caseId changes (no synchronous setState in the effect → no cascading
  // render), mirroring useListing.
  const [loaded, setLoaded] = useState<{
    status: 'loading' | 'ready' | 'error';
    case_: CaseItem | null;
    unit: UnitItem | null;
    tenant: Contact | null;
    forId: string;
  }>({ status: 'loading', case_: null, unit: null, tenant: null, forId: caseId });
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the in-flight load so a refetch (SSE-driven or caseId change)
  // supersedes the previous one and a late response can't clobber fresher state.
  const abortRef = useRef<AbortController | null>(null);

  // Apply an updated case in place (after a transition returns it), keeping the
  // resolved unit — instant feedback before the case.updated refetch reconciles.
  const setCase = useCallback(
    (next: CaseItem) => {
      setLoaded((prev) => ({ ...prev, status: 'ready', case_: next, forId: caseId }));
    },
    [caseId],
  );

  // Fetch (or refetch) the full case bundle. No synchronous loading reset — on a
  // caseId change loading is DERIVED during render (forId mismatch); a live
  // refetch updates in place (the unit carries final_rent, which a transition can
  // change, so we refetch it too rather than patch from the SSE event).
  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      const c = await getCase(caseId, signal);
      if (signal.aborted) return;
      // The unit (for final_rent + a readable address) AND the tenant contact
      // (so staff see the person by NAME, not the raw id — GLOSSARY) are both
      // best-effort: a failure on either is non-fatal — the page still renders
      // from the case, degrading that field to the id.
      const [u, t] = await Promise.all([
        getUnit(c.unitId, signal).catch(() => null),
        getContact(c.tenantId, signal).catch(() => null),
      ]);
      if (signal.aborted) return;
      setLoaded({ status: 'ready', case_: c, unit: u, tenant: t, forId: caseId });
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setLoaded({ status: 'error', case_: null, unit: null, tenant: null, forId: caseId });
    }
  }, [caseId]);

  useEffect(() => {
    // load sets state only after an await (never synchronously) — a fetch-on-mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Live: a transition on THIS case (here, another tab, or another user) emits
  // case.updated — refetch so every field reflects it, not just the History panel.
  const onCaseUpdated = useCallback(
    (ev: CaseUpdatedEvent) => {
      if (ev.caseId === caseId) void load();
    },
    [caseId, load],
  );
  useEventStream({ onCaseUpdated });

  // Committed state is for a previous caseId → still loading the new one.
  const fresh =
    loaded.forId === caseId
      ? loaded
      : { status: 'loading' as const, case_: null, unit: null, tenant: null };
  const status = fresh.status;
  const case_ = fresh.case_;
  const unit = fresh.unit;
  const tenant = fresh.tenant;

  const runTransition = useCallback(
    (toStage: PlacementStage, extra: { lostReason?: LostReason } & MovePromptResult) => {
      setBusy(true);
      setError(null);
      void transitionPlacement(caseId, {
        toStage,
        source: 'manual',
        ...(extra.lostReason !== undefined && { lostReason: extra.lostReason }),
        ...(extra.finalRent !== undefined && { finalRent: extra.finalRent }),
        ...(extra.inspectionOutcome !== undefined && { inspectionOutcome: extra.inspectionOutcome }),
      })
        .then((updated) => setCase(updated))
        .catch(() => setError('That move was rejected — please try again.'))
        .finally(() => {
          setBusy(false);
          setPending(null);
        });
    },
    [caseId, setCase],
  );

  // NOTE: this per-stage picker intentionally allows moving a TERMINAL case
  // (moved_in / lost) back to an active stage — treated as an allowed "re-open".
  // We deliberately do NOT block it here.
  function requestMove(toStage: PlacementStage): void {
    if (!case_ || toStage === case_.stage) return;
    const gate = gateFor(case_.stage, toStage);
    if (gate === 'none') {
      runTransition(toStage, {});
      return;
    }
    setPending({ toStage, gate });
  }

  if (status === 'loading') {
    return (
      <div className={styles.center}>
        <Spinner center />
      </div>
    );
  }

  if (status === 'error' || !case_) {
    return (
      <div className={styles.center}>
        <p role="alert" className={styles.error}>
          We couldn&apos;t load this case.
        </p>
      </div>
    );
  }

  const stageLabel = STAGE_LABELS[case_.stage] ?? case_.stage;
  const phase = STAGE_PHASE[case_.stage];
  // Staff see the person by NAME (GLOSSARY); degrade to the raw id only when the
  // tenant contact truly can't be loaded.
  const tenantLabel = tenant ? contactDisplayName(tenant.firstName, tenant.lastName, tenant.phone) : case_.tenantId;
  const listing = unit ? formatAddress(unit.address) || case_.unitId : case_.unitId;
  const lostReason = formatLostReason(case_.lost_reason);
  const finalRent = formatMoney(unit?.final_rent);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          {stageLabel}
          <span className={styles.phase}>{phase}</span>
        </h1>
        <div className={styles.actions}>
          <label className={styles.moveLabel}>
            <span className={styles.srOnly}>Move to stage</span>
            <select
              className={styles.moveSelect}
              aria-label="Move to stage"
              value=""
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value as PlacementStage;
                if (v) requestMove(v);
              }}
            >
              <option value="">Move to…</option>
              {PLACEMENT_STAGES.filter((s) => s !== case_.stage).map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}

      <div className={styles.cols}>
        <div className={styles.left}>
          <Card title="Placement">
            <KV
              k="Tenant"
              v={<Link to={`/contacts/${case_.tenantId}`}>{tenantLabel}</Link>}
            />
            <KV k="Listing" v={<Link to={`/listings/${case_.unitId}`}>{listing}</Link>} />
            <KV k="Stage" v={stageLabel} />
            <KV k="Phase" v={phase} />
            <KV
              k="In stage since"
              v={case_.stage_entered_at ? dateTime(case_.stage_entered_at) : '—'}
            />
            {case_.tour_date ? <KV k="Tour date" v={shortDate(case_.tour_date)} /> : null}
            {case_.inspection_outcome ? (
              <KV k="Inspection" v={case_.inspection_outcome === 'pass' ? 'Pass' : 'Fail'} />
            ) : null}
            {finalRent ? <KV k="Final rent" v={`${finalRent}/mo`} /> : null}
            {lostReason ? <KV k="Lost reason" v={lostReason} /> : null}
          </Card>

          <HistoryPanel caseId={caseId} />
        </div>
      </div>

      {pending !== null && pending.gate === 'lost' ? (
        <LostReasonModal
          subject={tenantLabel}
          onClose={() => setPending(null)}
          onConfirm={(reason) => runTransition(pending.toStage, { lostReason: reason })}
          busy={busy}
        />
      ) : null}

      {pending !== null && (pending.gate === 'finalRent' || pending.gate === 'inspectionOutcome') ? (
        <MovePromptModal
          mode={pending.gate === 'finalRent' ? 'finalRent' : 'inspectionOutcome'}
          onClose={() => setPending(null)}
          onConfirm={(result) => runTransition(pending.toStage, result)}
          busy={busy}
        />
      ) : null}
    </div>
  );
}

function HistoryPanel({ caseId }: { caseId: string }): React.JSX.Element {
  const { status, rows, hasMore, loadingMore, loadMore } = useCaseHistory(caseId);
  return (
    <Card title="History" aside={rows.length > 0 ? String(rows.length) : undefined}>
      {status === 'loading' ? (
        <Spinner center />
      ) : status === 'error' ? (
        <EmptyRow>We couldn&apos;t load the history.</EmptyRow>
      ) : rows.length === 0 ? (
        <EmptyRow>No history yet.</EmptyRow>
      ) : (
        <>
          <ul className={styles.history} aria-label="Placement history">
            {rows.map((row, i) => (
              <li key={`${row.ts}:${i}`} className={styles.historyRow}>
                <div className={styles.historyTop}>
                  <span className={styles.historyType}>{historyTitle(row.event_type)}</span>
                  <span className={styles.historyTs}>{dateTime(row.ts)}</span>
                </div>
                <div className={styles.historySummary}>{summarizeHistory(row.event_type, row.payload)}</div>
                {row.actorId ? <div className={styles.historyActor}>by {row.actorId}</div> : null}
              </li>
            ))}
          </ul>
          {hasMore ? (
            <Button variant="secondary" size="sm" loading={loadingMore} onClick={loadMore}>
              Load more
            </Button>
          ) : null}
        </>
      )}
    </Card>
  );
}
