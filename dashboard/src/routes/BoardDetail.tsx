// BoardDetail (M1.10) — one case + its actions (route '/boards/:caseId').
//
// Shows the stage, placement tag, tour date, next deadline, the attention flag
// (with a Clear/acknowledge button), lost reason, lease/move-in dates, and the
// linked relay thread (group_thread) when set. Tenant + listing names are
// hydrated best-effort (getContact + getUnit) — we fall back to the IDs, never a
// fabricated name. Staff-facing: we say "listing", never "property".
//
// ACTIONS (each calls the endpoint directly, then patches local state — mirrors
// UnitDetail's direct-mutation posture):
//   - advance/set stage (<select> → updateCase)
//   - schedule/clear tour (date input → updateCase({ tour_date })/null)
//   - set/clear next deadline (type <select> + datetime input → setCaseDeadline)
//   - set up relay thread (setUpCaseRelay; surfaces a link to the conversation,
//     handles relay_exists / provisioning-disabled / unreachable / not-found)
//
// LIVE UPDATE: the `case.updated` SSE event scoped to THIS caseId patches the
// displayed case (stage / attention / tour / deadline / relay link) in place.
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  getCase,
  getContact,
  getUnit,
  setCaseDeadline,
  setUpCaseRelay,
  updateCase,
  useApi,
  useEventStream,
  type CaseDeadlineType,
  type CaseItem,
  type CaseStage,
  type CaseUpdatedEvent,
  type Contact,
  type Conversation,
  type UnitItem,
  CASE_STAGES,
} from '../api/index.js';
import { Badge, Button, ChevronLeftIcon, EmptyState, Spinner, useToast } from '../ui/index.js';
import { formatAddress } from './records/Address.js';
import { contactName } from './records/records.js';
import { formatPhone } from './thread/identity.js';
import {
  CASE_DEADLINE_TYPE_LABEL,
  CASE_DEADLINE_TYPES,
  CASE_STAGE_LABEL,
  caseStageTone,
  caseTitle,
  formatDate,
  formatDateTime,
} from './boards/boards.js';
import styles from './boards/boards.module.css';

/** Apply a `case.updated` SSE projection onto a stored CaseItem (the event
 *  carries the board fields, with attention as a boolean + nulls for cleared). */
function applyEvent(prev: CaseItem, e: CaseUpdatedEvent): CaseItem {
  const next: CaseItem = { ...prev, stage: e.stage as CaseStage };
  if (e.tour_date !== null) next.tour_date = e.tour_date;
  else delete next.tour_date;
  if (e.next_deadline_type !== null) {
    next.next_deadline_type = e.next_deadline_type as CaseDeadlineType;
  } else delete next.next_deadline_type;
  if (e.next_deadline_at !== null) next.next_deadline_at = e.next_deadline_at;
  else delete next.next_deadline_at;
  if (e.group_thread !== null) next.group_thread = e.group_thread;
  else delete next.group_thread;
  if (e.lost_reason !== null) next.lost_reason = e.lost_reason;
  else delete next.lost_reason;
  if (e.updated_at !== null) next.updated_at = e.updated_at;
  if (e.attention) next.attention = prev.attention ?? { reason: 'needs_attention', at: e.updated_at ?? '' };
  else delete next.attention;
  return next;
}

export default function BoardDetail(): React.JSX.Element {
  const { caseId } = useParams<{ caseId: string }>();
  const id = caseId ?? '';
  const navigate = useNavigate();

  const { data, loading, error } = useApi((signal) => getCase(id, signal), [id]);

  // Local overlay so actions + SSE patch the displayed case without a refetch.
  const [item, setItem] = useState<CaseItem | undefined>(undefined);
  const current = item ?? data;

  // Seed the overlay from the first fetch.
  if (data !== undefined && item === undefined) {
    setItem(data);
  }

  const onCaseUpdated = useCallback(
    (e: CaseUpdatedEvent) => {
      if (e.caseId !== id) return;
      setItem((prev) => (prev ? applyEvent(prev, e) : prev));
    },
    [id],
  );
  useEventStream({ onCaseUpdated });

  if (loading && data === undefined) {
    return (
      <section className={styles.page}>
        <Spinner center label="Loading case" />
      </section>
    );
  }

  if (error || current === undefined) {
    const notFound = error?.status === 404 || error?.code === 'case_not_found';
    return (
      <section className={styles.page}>
        <EmptyState
          title={notFound ? 'Case not found' : "Couldn't load this case"}
          description={
            notFound ? 'This case may have been removed.' : 'Something went wrong loading the case.'
          }
          action={
            <Button variant="secondary" onClick={() => navigate('/boards')}>
              Back to boards
            </Button>
          }
        />
      </section>
    );
  }

  return <CaseView item={current} onPatched={setItem} />;
}

/** One labelled fact, rendered only when the value is present. */
function Fact({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.JSX.Element | null {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CaseView({
  item,
  onPatched,
}: {
  item: CaseItem;
  onPatched: (c: CaseItem) => void;
}): React.JSX.Element {
  const toast = useToast();

  // Best-effort hydration of the parties' display names (fall back to the IDs).
  const { data: tenant } = useApi<Contact | undefined>(
    (signal) => getContact(item.tenantId, signal).catch(() => undefined),
    [item.tenantId],
  );
  const { data: unit } = useApi<UnitItem | undefined>(
    (signal) => getUnit(item.unitId, signal).catch(() => undefined),
    [item.unitId],
  );

  const tenantLabel = useMemo(() => {
    if (tenant) {
      const name = contactName(tenant);
      if (name !== undefined) return name;
      if (typeof tenant.phone === 'string' && tenant.phone.length > 0) return formatPhone(tenant.phone);
    }
    return item.tenantId;
  }, [tenant, item.tenantId]);

  const unitLabel = useMemo(() => {
    if (unit) return formatAddress(unit.address) ?? unit.jurisdiction ?? `Listing ${unit.unitId}`;
    return item.unitId;
  }, [unit, item.unitId]);

  // --- Action state -------------------------------------------------------
  const [stage, setStage] = useState<CaseStage>(item.stage);
  const [tourDate, setTourDate] = useState(item.tour_date ?? '');
  const [deadlineType, setDeadlineType] = useState<CaseDeadlineType>(
    item.next_deadline_type ?? 'tour_reminder',
  );
  const [deadlineAt, setDeadlineAt] = useState('');
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  // The relay outcome: a conversation to link to, plus an optional note.
  const [relayConversation, setRelayConversation] = useState<Conversation | undefined>(undefined);
  const [relayNote, setRelayNote] = useState<string | undefined>(undefined);

  /** Run a mutation that returns the updated case; patch local state + toast. */
  async function run(
    key: string,
    fn: () => Promise<CaseItem>,
    successMsg: string,
  ): Promise<void> {
    if (busy !== undefined) return;
    setBusy(key);
    setActionError(undefined);
    try {
      const updated = await fn();
      onPatched(updated);
      setStage(updated.stage);
      setTourDate(updated.tour_date ?? '');
      toast.success(successMsg);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Could not ${successMsg.toLowerCase()}.`;
      setActionError(msg);
      toast.error(msg);
    } finally {
      setBusy(undefined);
    }
  }

  async function handleSetUpRelay(): Promise<void> {
    if (busy !== undefined) return;
    setBusy('relay');
    setActionError(undefined);
    setRelayNote(undefined);
    try {
      const { conversation, case: updated } = await setUpCaseRelay(item.caseId);
      onPatched(updated);
      setRelayConversation(conversation);
      toast.success('Relay thread created');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'relay_exists') {
          // The existing relay rides on the error body — link to it.
          const body = err.body as { conversation?: Conversation } | undefined;
          if (body?.conversation !== undefined) setRelayConversation(body.conversation);
          setRelayNote('A relay thread already exists for this case.');
        } else if (err.code === 'relay_provisioning_disabled') {
          setRelayNote('Relay provisioning is disabled until A2P approval.');
        } else if (err.code === 'pool_number_unavailable') {
          setRelayNote('No phone number is available right now — try again shortly.');
        } else if (err.code === 'tenant_unreachable') {
          setRelayNote('The tenant has no phone on file — add one before setting up a relay.');
        } else if (err.code === 'landlord_unreachable') {
          setRelayNote('The listing landlord has no phone on file — add one first.');
        } else if (err.code === 'unit_not_found') {
          setRelayNote("This case's listing could not be found.");
        } else {
          setActionError(err.message);
        }
      } else {
        setActionError('Could not set up the relay thread.');
      }
    } finally {
      setBusy(undefined);
    }
  }

  const tour = formatDate(item.tour_date);
  const deadlineWhen = formatDateTime(item.next_deadline_at);
  const groupThread = item.group_thread;

  return (
    <section className={styles.page} aria-labelledby="case-detail-heading">
      <Link to="/boards" className={styles.back}>
        <ChevronLeftIcon size={16} />
        Back to boards
      </Link>

      <header className={styles.header}>
        <div>
          <h1 id="case-detail-heading">{caseTitle(item)}</h1>
          <p className={styles.lead}>
            {tenantLabel} · {unitLabel}
          </p>
        </div>
        <Badge tone={caseStageTone(item.stage)} dot>
          {CASE_STAGE_LABEL[item.stage]}
        </Badge>
      </header>

      {item.attention !== undefined && (
        <div className={styles.surface}>
          <h2 className={styles.sectionTitle}>Needs attention</h2>
          <p className={styles.notice}>
            {item.attention.reason}
            {formatDateTime(item.attention.at) !== undefined
              ? ` · ${formatDateTime(item.attention.at)}`
              : ''}
          </p>
          <div className={styles.formActions}>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'attention'}
              onClick={() =>
                void run('attention', () => updateCase(item.caseId, { attention: null }), 'Attention cleared')
              }
            >
              Clear attention
            </Button>
          </div>
        </div>
      )}

      <div className={styles.surface}>
        <h2 className={styles.sectionTitle}>Details</h2>
        <dl className={styles.facts}>
          <Fact label="Tenant" value={<Link to={`/contacts/${encodeURIComponent(item.tenantId)}`}>{tenantLabel}</Link>} />
          <Fact label="Listing" value={<Link to={`/units/${encodeURIComponent(item.unitId)}`}>{unitLabel}</Link>} />
          <Fact label="Placement tag" value={item.placement_tag} />
          <Fact label="Tour date" value={tour} />
          <Fact
            label="Next deadline"
            value={
              item.next_deadline_type !== undefined
                ? `${CASE_DEADLINE_TYPE_LABEL[item.next_deadline_type]}${deadlineWhen !== undefined ? ` · ${deadlineWhen}` : ''}`
                : undefined
            }
          />
          <Fact label="Lost reason" value={item.lost_reason} />
          <Fact label="Lease date" value={formatDate(item.lease_date)} />
          <Fact label="Move-in date" value={formatDate(item.move_in_date)} />
          <Fact label="Notes" value={item.notes} />
        </dl>
      </div>

      <div className={styles.surface}>
        <h2 className={styles.sectionTitle}>Stage</h2>
        <div className={styles.actionRow}>
          <div className={styles.grow}>
            <label className={styles.fieldLabel} htmlFor="case-stage">
              Stage
            </label>
            <select
              id="case-stage"
              className={styles.select}
              value={stage}
              disabled={busy !== undefined}
              onChange={(e) => setStage(e.target.value as CaseStage)}
            >
              {CASE_STAGES.map((s) => (
                <option key={s} value={s}>
                  {CASE_STAGE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <Button
            loading={busy === 'stage'}
            disabled={busy !== undefined && busy !== 'stage'}
            onClick={() => void run('stage', () => updateCase(item.caseId, { stage }), 'Stage updated')}
          >
            Save stage
          </Button>
        </div>
      </div>

      <div className={styles.surface}>
        <h2 className={styles.sectionTitle}>Tour</h2>
        <div className={styles.actionRow}>
          <div className={styles.grow}>
            <label className={styles.fieldLabel} htmlFor="case-tour-date">
              Tour date
            </label>
            <input
              id="case-tour-date"
              type="date"
              className={styles.input}
              value={tourDate}
              disabled={busy !== undefined}
              onChange={(e) => setTourDate(e.target.value)}
            />
          </div>
          <Button
            loading={busy === 'tour'}
            disabled={busy !== undefined && busy !== 'tour'}
            onClick={() =>
              void run(
                'tour',
                () => updateCase(item.caseId, { tour_date: tourDate.length > 0 ? tourDate : null }),
                'Tour saved',
              )
            }
          >
            Save tour
          </Button>
          <Button
            variant="secondary"
            loading={busy === 'tourClear'}
            disabled={busy !== undefined && busy !== 'tourClear'}
            onClick={() =>
              void run('tourClear', () => updateCase(item.caseId, { tour_date: null }), 'Tour cleared')
            }
          >
            Clear tour
          </Button>
        </div>
      </div>

      <div className={styles.surface}>
        <h2 className={styles.sectionTitle}>Next deadline</h2>
        <div className={styles.actionRow}>
          <div className={styles.grow}>
            <label className={styles.fieldLabel} htmlFor="case-deadline-type">
              Deadline type
            </label>
            <select
              id="case-deadline-type"
              className={styles.select}
              value={deadlineType}
              disabled={busy !== undefined}
              onChange={(e) => setDeadlineType(e.target.value as CaseDeadlineType)}
            >
              {CASE_DEADLINE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CASE_DEADLINE_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.grow}>
            <label className={styles.fieldLabel} htmlFor="case-deadline-at">
              When
            </label>
            <input
              id="case-deadline-at"
              type="datetime-local"
              className={styles.input}
              value={deadlineAt}
              disabled={busy !== undefined}
              onChange={(e) => setDeadlineAt(e.target.value)}
            />
          </div>
          <Button
            loading={busy === 'deadline'}
            disabled={busy !== undefined && busy !== 'deadline'}
            onClick={() => {
              if (deadlineAt.length === 0) {
                setActionError('Pick when the deadline is due.');
                return;
              }
              // datetime-local has no timezone; new Date() reads it as local,
              // and setCaseDeadline canonicalizes to ISO 8601 for the wire.
              const iso = new Date(deadlineAt).toISOString();
              void run(
                'deadline',
                () => setCaseDeadline(item.caseId, { type: deadlineType, at: iso }),
                'Deadline set',
              );
            }}
          >
            Set deadline
          </Button>
          <Button
            variant="secondary"
            loading={busy === 'deadlineClear'}
            disabled={busy !== undefined && busy !== 'deadlineClear'}
            onClick={() =>
              void run(
                'deadlineClear',
                () => setCaseDeadline(item.caseId, { clear: true }),
                'Deadline cleared',
              )
            }
          >
            Clear deadline
          </Button>
        </div>
      </div>

      <div className={styles.surface}>
        <h2 className={styles.sectionTitle}>Relay thread</h2>
        {groupThread !== undefined ? (
          <p className={styles.notice}>
            This case has a relay thread.{' '}
            <Link to={`/conversations/${encodeURIComponent(groupThread)}`}>Open relay thread</Link>
          </p>
        ) : (
          <p className={styles.lead}>
            Set up a masked relay thread between the tenant and the listing landlord.
          </p>
        )}
        {relayNote !== undefined && <p className={styles.notice}>{relayNote}</p>}
        {/* The action result link — only when it isn't already shown as the
            group_thread link above (success patches group_thread to the SAME id,
            so we'd otherwise render two identical links). */}
        {relayConversation !== undefined && relayConversation.conversationId !== groupThread && (
          <p className={styles.notice}>
            <Link to={`/conversations/${encodeURIComponent(relayConversation.conversationId)}`}>
              Open relay thread
            </Link>
          </p>
        )}
        <div className={styles.formActions}>
          <Button
            loading={busy === 'relay'}
            disabled={busy !== undefined && busy !== 'relay'}
            onClick={() => void handleSetUpRelay()}
          >
            {groupThread !== undefined ? 'Re-check relay thread' : 'Set up relay thread'}
          </Button>
        </div>
      </div>

      {actionError !== undefined && (
        <p className={styles.formError} role="alert">
          {actionError}
        </p>
      )}
    </section>
  );
}
