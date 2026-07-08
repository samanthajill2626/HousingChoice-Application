// BroadcastComposer — the /broadcasts/new orchestrator. Two steps in one route:
//   1. COMPOSE — AudienceFilters (voucher size + housing authority, pre-filled
//      from the property when ?unitId) + MessageEditor (template + merge fields),
//      with a LIVE reach backed by a single throwaway draft (useComposerDraft:
//      debounced create + delete-previous, so no orphan drafts leak). "Preview"
//      resolves the draft's full candidate list.
//   2. PREVIEW — RecipientPreview (the editable curated list → Send / Delete).
//
// Optional query params: ?unitId= (compose from a property: pre-fill the voucher
// size from its beds, attach the flyer link, show the property) and ?draftId=
// (resume an existing draft row from the list → straight to Preview).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ApiError,
  getContacts,
  getUnit,
  previewBroadcast,
  type AudienceFilter,
  type Contact,
  type PreviewResponse,
  type UnitItem,
} from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { shortAddress } from '../listing/listingFormat.js';
import { AudienceFilters } from './AudienceFilters.js';
import { MessageEditor } from './MessageEditor.js';
import { RecipientPreview } from './RecipientPreview.js';
import { useComposerDraft } from './useComposerDraft.js';
import styles from './BroadcastComposer.module.css';

export function BroadcastComposer(): React.JSX.Element {
  const [params] = useSearchParams();
  const unitId = params.get('unitId') ?? undefined;
  const resumeDraftId = params.get('draftId') ?? undefined;

  const [unit, setUnit] = useState<UnitItem | null>(null);
  const [filter, setFilter] = useState<AudienceFilter>({ contact_type: 'tenant' });
  const [bodyTemplate, setBodyTemplate] = useState('');

  // Preview step state.
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Tenant candidates for the "add a tenant" search (loaded once).
  const [tenants, setTenants] = useState<Contact[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(true);

  const draft = useComposerDraft({
    ...(unitId !== undefined && { unitId }),
    bodyTemplate,
    filter,
  });

  // Resume an existing draft id (from a draft row) — adopt it WITHOUT creating one.
  const adoptedRef = useRef(false);
  useEffect(() => {
    if (resumeDraftId !== undefined && !adoptedRef.current) {
      adoptedRef.current = true;
      draft.adoptDraftId(resumeDraftId);
    }
  }, [resumeDraftId, draft]);

  // Load the property (beds → pre-fill voucher size; address → property label).
  useEffect(() => {
    if (unitId === undefined) return;
    const controller = new AbortController();
    getUnit(unitId, controller.signal)
      .then((u) => {
        setUnit(u);
        // Pre-fill the voucher size from the property's beds (overridable). Only
        // when the operator hasn't already set a size (fresh compose).
        if (typeof u.beds === 'number') {
          setFilter((prev) =>
            prev.bedroomSize === undefined ? { ...prev, bedroomSize: u.beds } : prev,
          );
        }
      })
      .catch(() => {
        /* property load failed — compose still works without the pre-fill */
      });
    return () => controller.abort();
  }, [unitId]);

  // Load tenant candidates once (first page; the search filters client-side).
  useEffect(() => {
    const controller = new AbortController();
    getContacts({ type: 'tenant' }, controller.signal)
      .then((page) => {
        setTenants(page.contacts);
        setTenantsLoading(false);
      })
      .catch(() => setTenantsLoading(false));
    return () => controller.abort();
  }, []);

  const propertyLabel = useMemo(
    () => (unit !== null ? shortAddress(unit.address, unit.unitId) : undefined),
    [unit],
  );

  async function onPreview(): Promise<void> {
    if (draft.draftId === null || previewBusy) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const result = await previewBroadcast(draft.draftId);
      setPreview(result);
    } catch (err) {
      if (err instanceof ApiError) {
        setPreviewError(err.message);
      } else {
        setPreviewError("Couldn't load the recipient list — try again.");
      }
    } finally {
      setPreviewBusy(false);
    }
  }

  // Disable Preview/Send while a recreate is pending OR after one FAILED (stale):
  // the current draft id no longer matches the on-screen audience/message, so we
  // must not Preview/Send against it. Editing again retries the recreate.
  const canPreview =
    bodyTemplate.trim().length > 0 && draft.draftId !== null && !draft.reachPending && !draft.stale;

  // PREVIEW step — the curated list.
  if (preview !== null && draft.draftId !== null) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Review recipients</h1>
        <button type="button" className={styles.backStep} onClick={() => setPreview(null)}>
          ← Edit audience &amp; message
        </button>
        <RecipientPreview
          draftId={draft.draftId}
          preview={preview}
          tenantCandidates={tenants}
          candidatesLoading={tenantsLoading}
        />
      </div>
    );
  }

  // COMPOSE step.
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>New broadcast</h1>

      <div className={styles.cols}>
        <div className={styles.col}>
          <AudienceFilters
            filter={filter}
            onChange={setFilter}
            {...(typeof unit?.beds === 'number' && { propertyBeds: unit.beds })}
            {...(draft.reachCount !== undefined && { reachCount: draft.reachCount })}
            reachPending={draft.reachPending}
            truncated={draft.truncated}
          />
        </div>
        <div className={styles.col}>
          <MessageEditor
            value={bodyTemplate}
            onChange={setBodyTemplate}
            {...(propertyLabel !== undefined && { propertyLabel })}
          />
        </div>
      </div>

      {draft.error !== null ? (
        <p className={styles.error} role="alert">
          {draft.error}
        </p>
      ) : null}
      {previewError !== null ? (
        <p className={styles.error} role="alert">
          {previewError}
        </p>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.previewBtn}
          disabled={!canPreview || previewBusy}
          onClick={() => void onPreview()}
        >
          {previewBusy ? 'Loading…' : 'Preview recipients'}
        </button>
        {draft.reachPending ? <Spinner /> : null}
        {/* A disabled button must say WHY: the one operator-actionable gate is
            the empty message; the settling draft/reach is transient (spinner).
            A stale draft's failure already renders in the error alert above. */}
        {!previewBusy && !canPreview ? (
          bodyTemplate.trim().length === 0 ? (
            <span className={styles.previewHint}>Write a message to enable the preview.</span>
          ) : draft.reachPending || draft.draftId === null ? (
            <span className={styles.previewHint}>Sizing the audience…</span>
          ) : null
        ) : null}
      </div>
    </div>
  );
}
