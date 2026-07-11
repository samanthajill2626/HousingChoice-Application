// BroadcastComposer — the /broadcasts/new orchestrator. Two steps in one route:
//   1. COMPOSE — AudienceFilters (voucher size + housing authority, pre-filled
//      from the property when ?unitId) + MessageEditor (template + merge fields),
//      with a LIVE reach backed by a single throwaway draft (useComposerDraft:
//      debounced create + delete-previous, so no orphan drafts leak). "Preview"
//      resolves the draft's full candidate list.
//   2. PREVIEW — RecipientPreview (the editable curated list → Send / Delete).
//
// Optional query params: ?unitId= (compose from a property: pre-fill the voucher
// size from its beds, attach the flyer link, show the property), ?contactId=
// (compose to ONE tenant: a seeds-only draft with the filters hidden behind an
// "Add more tenants by filters" opt-in) and ?draftId= (resume an existing draft
// row from the list → straight to Preview). Without ?unitId= a Property picker
// lets the operator attach a property from the composer itself.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ApiError,
  getContact,
  getContacts,
  getUnit,
  getUnits,
  previewBroadcast,
  LISTING_STATUS_LABELS,
  type AudienceFilter,
  type Contact,
  type ListingStatus,
  type PreviewResponse,
  type UnitItem,
} from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { contactDisplayName } from '../contact/format.js';
import { UnitSearchField, type UnitSearchValue } from '../contact/UnitSearchField.js';
import { shortAddress } from '../listing/listingFormat.js';
import { AudienceFilters } from './AudienceFilters.js';
import { MessageEditor } from './MessageEditor.js';
import { RecipientPreview } from './RecipientPreview.js';
import { DEFAULT_SEND_TEMPLATE, resolveTemplateForTenant } from './resolveTemplate.js';
import { useComposerDraft } from './useComposerDraft.js';
import styles from './BroadcastComposer.module.css';

/** The same-origin public flyer funnel URL (ListingDetail.tsx's pattern) - the
 *  fallback [FlyerLink] until the first draft returns the server's flyerUrl. */
function flyerLinkFor(unitId: string): string {
  return `${window.location.origin}/p/${encodeURIComponent(unitId)}`;
}

export function BroadcastComposer(): React.JSX.Element {
  const [params] = useSearchParams();
  const unitId = params.get('unitId') ?? undefined;
  const resumeDraftId = params.get('draftId') ?? undefined;
  const seedContactId = params.get('contactId') ?? undefined;
  const seedContactIds = useMemo(
    () => (seedContactId !== undefined ? [seedContactId] : []),
    [seedContactId],
  );

  const [unit, setUnit] = useState<UnitItem | null>(null);
  const [filter, setFilter] = useState<AudienceFilter>({ contact_type: 'tenant' });
  const [bodyTemplate, setBodyTemplate] = useState('');
  // Whether the staff user has hand-edited the message. Only textarea keystrokes
  // flip this (NOT the programmatic auto-seed below), so the resolved default can
  // keep re-seeding until the operator takes the pen.
  const [bodyEdited, setBodyEdited] = useState(false);
  // Seeded entry starts seeds-only: the audience filters are hidden until the
  // operator opts in ("Add more tenants by filters" - a one-way flip).
  const [audienceEnabled, setAudienceEnabled] = useState(seedContactIds.length === 0);
  const [seedContact, setSeedContact] = useState<Contact | null>(null);

  // Property picker state - only used when the entry point did NOT fix a unit.
  const [unitCandidates, setUnitCandidates] = useState<UnitItem[]>([]);
  const [unitPick, setUnitPick] = useState<UnitSearchValue>({ label: '' });
  const effectiveUnitId = unitId ?? unitPick.unitId;

  // Resolved message mode: exactly ONE recipient and the filters are still off.
  // The editor shows the FINAL rendered text (what will actually send), not a
  // token template - there is no per-recipient variance to preserve.
  const resolvedMode = seedContactIds.length === 1 && !audienceEnabled;

  // Preview step state.
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Tenant candidates for the "add a tenant" search (loaded once).
  const [tenants, setTenants] = useState<Contact[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(true);

  const draft = useComposerDraft({
    ...(effectiveUnitId !== undefined && { unitId: effectiveUnitId }),
    bodyTemplate,
    ...(audienceEnabled && { filter }),
    ...(seedContactIds.length > 0 && { seedContactIds }),
  });

  // Resume an existing draft id (from a draft row) — adopt it WITHOUT creating one.
  const adoptedRef = useRef(false);
  useEffect(() => {
    if (resumeDraftId !== undefined && !adoptedRef.current) {
      adoptedRef.current = true;
      draft.adoptDraftId(resumeDraftId);
    }
  }, [resumeDraftId, draft]);

  // Resolve the seeded tenant for the banner (and Task 7's resolved mode).
  useEffect(() => {
    if (seedContactId === undefined) return;
    const controller = new AbortController();
    getContact(seedContactId, controller.signal)
      .then(setSeedContact)
      .catch(() => setSeedContact(null)); // banner falls back to the raw id
    return () => controller.abort();
  }, [seedContactId]);

  // Property-picker candidates - only when the entry point did not fix a unit.
  useEffect(() => {
    if (unitId !== undefined) return; // fixed by the entry point
    const controller = new AbortController();
    getUnits({}, controller.signal)
      .then((page) => setUnitCandidates(page.units))
      .catch(() => {
        /* candidate load failed - the picker just has nothing to suggest */
      });
    return () => controller.abort();
  }, [unitId]);

  // Load the property (address -> property label; beds feed the pre-fill below).
  useEffect(() => {
    if (effectiveUnitId === undefined) {
      setUnit(null); // picker cleared - drop the stale property context
      return;
    }
    const controller = new AbortController();
    getUnit(effectiveUnitId, controller.signal)
      .then(setUnit)
      .catch(() => {
        /* property load failed — compose still works without the pre-fill */
      });
    return () => controller.abort();
  }, [effectiveUnitId]);

  // Auto-seed the resolved default message for the single recipient: only in
  // resolved mode, only with a property attached (no unit -> leave the body
  // alone until the operator types or picks one), and only while the operator
  // has not hand-edited it. Re-seeds on unit/tenant/flyer change. Written via
  // setBodyTemplate directly (NOT the edit-tracking onChange) so it never marks
  // the body as edited. The flyer prefers the server's flyerUrl, falling back to
  // the same-origin funnel until the first draft exists.
  useEffect(() => {
    if (!resolvedMode || unit === null || bodyEdited) return;
    const flyer =
      draft.flyerUrl ?? (effectiveUnitId !== undefined ? flyerLinkFor(effectiveUnitId) : undefined);
    setBodyTemplate(
      resolveTemplateForTenant(DEFAULT_SEND_TEMPLATE, unit, seedContact?.firstName, flyer),
    );
  }, [resolvedMode, unit, bodyEdited, draft.flyerUrl, effectiveUnitId, seedContact]);

  // Pre-fill the voucher size from the property's beds (overridable), only while
  // the filters are ACTIVE (hidden filters have no state to pre-fill) and only
  // when the operator hasn't already set a size. Enabling the filters with a
  // property attached applies the pre-fill at that moment.
  useEffect(() => {
    if (!audienceEnabled || unit === null || typeof unit.beds !== 'number') return;
    const beds = unit.beds;
    setFilter((prev) => (prev.bedroomSize === undefined ? { ...prev, bedroomSize: beds } : prev));
  }, [audienceEnabled, unit]);

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

  // A textarea keystroke (as opposed to the programmatic auto-seed): take the
  // operator's edit AND latch bodyEdited so the auto-seed stops overwriting it.
  function onBodyChange(next: string): void {
    setBodyEdited(true);
    setBodyTemplate(next);
  }

  // "Add more tenants by filters" - the one-way flip out of seeds-only. Leaving
  // resolved mode with a unit attached always resets the body: the resolved text
  // names ONE tenant and must never send to a broader audience. When the operator
  // has edited that text, confirm before discarding (cancel aborts the flip);
  // when it is still the untouched auto-seed there is nothing to protect, so the
  // reset is silent. Either way the body returns to '' (token mode - they will
  // compose a fresh template). A no-unit typed body is a plain token template
  // already and survives the flip untouched.
  function onEnableFilters(): void {
    if (resolvedMode && unit !== null) {
      if (bodyEdited) {
        const ok = window.confirm(
          'Switching the audience resets the message to the template. Discard your edits?',
        );
        if (!ok) return;
      }
      setBodyTemplate('');
      setBodyEdited(false);
    }
    setAudienceEnabled(true);
  }

  // Spec 2026-07-10: a non-Available property's flyer link is dead (public.ts
  // serves only 'available'). Warn EARLY — before the operator curates a whole
  // audience — that the Send step will ask to make it Available.
  const unavailableNote =
    unit !== null && unit.status !== 'available' ? (
      <p className={styles.unavailableNote} role="status">
        This property is{' '}
        <strong>{LISTING_STATUS_LABELS[unit.status as ListingStatus] ?? unit.status}</strong>, so
        its flyer link won't work. You'll be asked to make it Available when you send.
      </p>
    ) : null;

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
        {unavailableNote}
        <RecipientPreview
          draftId={draft.draftId}
          preview={preview}
          tenantCandidates={tenants}
          candidatesLoading={tenantsLoading}
          {...(unitId !== undefined && { unitId })}
        />
      </div>
    );
  }

  // COMPOSE step.
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Send a property</h1>
      {unavailableNote}

      <div className={styles.cols}>
        <div className={styles.col}>
          {seedContactIds.length > 0 && !audienceEnabled ? (
            <div className={styles.seedBanner}>
              <p className={styles.seedBannerText}>
                Sending to{' '}
                <strong>
                  {seedContact !== null
                    ? contactDisplayName(seedContact.firstName, seedContact.lastName, seedContact.phone)
                    : seedContactId}
                </strong>
                .
              </p>
              <button
                type="button"
                className={styles.seedBannerBtn}
                onClick={onEnableFilters}
              >
                Add more tenants by filters
              </button>
            </div>
          ) : (
            <AudienceFilters
              filter={filter}
              onChange={setFilter}
              {...(typeof unit?.beds === 'number' && { propertyBeds: unit.beds })}
              {...(draft.reachCount !== undefined && { reachCount: draft.reachCount })}
              reachPending={draft.reachPending}
              truncated={draft.truncated}
            />
          )}
          {unitId === undefined ? (
            <div className={styles.pickerField}>
              <span className={styles.pickerLabel}>Property</span>
              <UnitSearchField
                value={unitPick}
                onChange={setUnitPick}
                candidates={unitCandidates}
                inputLabel="Property"
              />
            </div>
          ) : null}
        </div>
        <div className={styles.col}>
          <MessageEditor
            value={bodyTemplate}
            onChange={onBodyChange}
            resolved={resolvedMode}
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
