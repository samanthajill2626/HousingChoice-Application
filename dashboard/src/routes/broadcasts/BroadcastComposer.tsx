// BroadcastComposer — the /broadcasts/new orchestrator. Three steps in one route:
//   0. PROPERTY — every Matching send carries a property (spec 2026-07-13:
//      there is no property-less send), so until one is attached the ONLY thing
//      on screen is the property choice: a browsable candidate list + search.
//      ?unitId= entries arrive with the property fixed and skip this step.
//   1. COMPOSE - AudienceFilters (voucher size + housing authorities, pre-filled
//      from the property and owned by it - matching-blast-rules D3) + MessageEditor, pre-filled with the property's REAL
//      details ([Beds]/[Address]/[Rent]/[FlyerLink] resolved; [TenantName]
//      stays a per-recipient token), with a LIVE reach backed by a single
//      throwaway draft (useComposerDraft). "Preview" resolves the candidates.
//   2. PREVIEW — RecipientPreview (the editable curated list → Send / Delete).
//
// Optional query params: ?unitId= (property fixed by the entry point),
// ?contactId= (compose to ONE contact - a tenant or a partner: property step first, then a seeds-only
// draft with the filters hidden behind an "Add more tenants by filters" opt-in)
// and ?draftId= (resume an existing draft row from the list).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ApiError,
  getContact,
  getAllContacts,
  getAllUnits,
  getUnit,
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
import { ORG_FILTER_TYPED_HINT, orgListUnknown, orgNotOnListBody } from '../orgs/orgCopy.js';
import { useOrgList } from '../orgs/useOrgList.js';
import { UnitSearchField, type UnitSearchValue } from '../contact/UnitSearchField.js';
import { acceptedVoucherSizes, authoritiesOf, shortAddress } from '../listing/listingFormat.js';
import { AudienceFilters } from './AudienceFilters.js';
import { prefillAuthorities } from './authorityPrefill.js';
import { MessageEditor } from './MessageEditor.js';
import { RecipientPreview } from './RecipientPreview.js';
import {
  DEFAULT_SEND_TEMPLATE,
  ONE_TO_ONE_SEND_TEMPLATE,
  resolveTemplateForUnit,
} from './resolveTemplate.js';
import { useComposerDraft } from './useComposerDraft.js';
import styles from './BroadcastComposer.module.css';

/** How many properties the browse list reveals at a time (the initial batch and
 *  each "Load more"). The whole portfolio is loaded client-side either way - this
 *  is purely how much of it is on screen at once. */
const UNIT_BROWSE_BATCH = 12;

/** The same-origin public flyer funnel URL (ListingDetail.tsx's pattern) - the
 *  fallback [FlyerLink] until the first draft returns the server's flyerUrl. */
function flyerLinkFor(unitId: string): string {
  return `${window.location.origin}/p/${encodeURIComponent(unitId)}`;
}

/** matching-blast-rules D3b: a 422 org_not_on_list from the draft create or
 *  from Preview named ONE member of the housing authority filter; that member
 *  alone is removed. */
function authorityLeftTheList(text: string): string {
  return `${text} is no longer on the organization list, so it was removed from the filter.`;
}

/** D3: the property did not load, so nothing was prefilled from it. */
const PROPERTY_LOAD_FAILED =
  "Couldn't load the property, so its housing authorities and voucher size were not filled in.";
/** D3: the organization list did not load, so no authority was prefilled. */
const ORG_LIST_FAILED =
  "Couldn't load the organization list, so housing authorities were not filled in from the property.";
/** D7: a filter draft's Preview was refused 503 audience_rules_unavailable. */
const RULES_UNAVAILABLE =
  "Couldn't check tours and Not interested replies, so the recipient list can't be shown yet.";

/** D3: the property load, kept with the id it was for - a failed state
 *  belongs to that property and clears when it loads or the property changes. */
type UnitLoad = { unitId: string; status: 'loaded'; unit: UnitItem } | { unitId: string; status: 'failed' };

/** D3: staff's edits to the audience filters, OWNED by one property. An
 *  absent field is not edited (the property's prefill shows); a present one
 *  is staff's, and the prefill never overwrites it while the property stays.
 *  Value and ownership live in this ONE state and every write is a functional
 *  update (docs/issues/broadcast-composer-prefill-overwrites-edit.md). */
interface FilterEdits {
  /** The property these edits belong to (null: none - a resumed draft). */
  unitId: string | null;
  /** Staff's housing authority list ([] = staff emptied it). */
  authorities?: string[];
  /** Staff's voucher size (null = staff cleared it). */
  size?: number | null;
}

/** No authority prefill (no property loaded) - ONE shared value, so the
 *  derived filter keeps its identity. */
const NO_AUTHORITY_PREFILL: { names: string[]; unused: string[] } = { names: [], unused: [] };

/** matching-blast-rules D7 (AR39): a Preview REFUSAL, kept as data with the
 *  identity it answered - exactly like a preview result: the draft it read,
 *  the inputs that draft was made for (`key`), and the property on screen at
 *  the click. It is shown only while that draft is still the one on screen. */
interface PreviewRefusal {
  draftId: string;
  key: string;
  unitId: string | null;
  kind: 'rules_unavailable';
}

/** D3b (AR39): the "no longer on the organization list" notice, kept with
 *  the property its refusal was for - shown only while that property is on
 *  screen. */
interface AuthorityNotice {
  unitId: string | null;
  text: string;
}

/** Code review R3-FE-1: a Preview that landed after the audience or the
 *  message changed is dropped - its candidates belong to another draft. */
const AUDIENCE_CHANGED = 'The audience changed - preview again.';

export function BroadcastComposer(): React.JSX.Element {
  const [params] = useSearchParams();
  const unitId = params.get('unitId') ?? undefined;
  const resumeDraftId = params.get('draftId') ?? undefined;
  const seedContactId = params.get('contactId') ?? undefined;
  const seedContactIds = useMemo(
    () => (seedContactId !== undefined ? [seedContactId] : []),
    [seedContactId],
  );

  const [unitLoad, setUnitLoad] = useState<UnitLoad | null>(null);
  // The message starts EMPTY everywhere: compose is unreachable until a
  // property is attached (the property step), and the moment one loads the
  // auto-fill effects below seed the REAL prefill (unit tokens resolved;
  // [TenantName] kept - or fully resolved in single-recipient mode). ?draftId=
  // must stay empty regardless (a non-empty body would recreate the draft and
  // DELETE the one being resumed).
  // Keep text and edit ownership atomic: a pending prefill effect must check
  // the latest ownership when its update applies, not its render's old flag.
  const [{ body: bodyTemplate, edited: bodyEdited }, setMessage] = useState({
    body: '',
    edited: false,
  });
  // Seeded entry starts seeds-only: the audience filters are hidden until the
  // operator opts in ("Add more tenants by filters" - a one-way flip).
  const [audienceEnabled, setAudienceEnabled] = useState(seedContactIds.length === 0);
  const [seedContact, setSeedContact] = useState<Contact | null>(null);
  // The housing authority list behind the filters' picker - read ONCE here
  // (one GET /api/organizations per mount), not in AudienceFilters: the
  // property prefill and the Preview gate read the same answer
  // (matching-blast-rules D3).
  const orgList = useOrgList();

  // Property picker state - only used when the entry point did NOT fix a unit.
  const [unitCandidates, setUnitCandidates] = useState<UnitItem[]>([]);
  const [unitPick, setUnitPick] = useState<UnitSearchValue>({ label: '' });
  const effectiveUnitId = unitId ?? unitPick.unitId;
  // How many browse rows are revealed, and which query that reveal belongs to.
  // A full portfolio is ~100 properties, so the list opens at one batch and
  // grows on "Load more" rather than dumping everything. The query is part of
  // the state (rather than an effect that resets it) so a NEW query DERIVES a
  // fresh batch during render - each query is its own list, and carrying a
  // previous reveal into it reads as an arbitrary cutoff. Same
  // derive-don't-cascade pattern as useListings' `forDeleted`.
  const [reveal, setReveal] = useState<{ query: string; count: number }>({
    query: '',
    count: UNIT_BROWSE_BATCH,
  });

  // Resolved message mode: exactly ONE recipient and the filters are still off.
  // The editor shows the FINAL rendered text (what will actually send), not a
  // token template - there is no per-recipient variance to preserve.
  const resolvedMode = seedContactIds.length === 1 && !audienceEnabled;

  // matching-blast-rules D3: the property on screen and its load - a load for
  // another id (the previous pick, or one still in flight) is not this one's.
  const loaded = unitLoad !== null && unitLoad.unitId === effectiveUnitId ? unitLoad : null;
  const unit = loaded !== null && loaded.status === 'loaded' ? loaded.unit : null;

  // D3 prefill - DERIVED, never written by an effect: the property's accepted
  // authorities mapped to list names (authorityPrefill), and the voucher size
  // it takes (acceptedVoucherSizes, the one reader; the filter holds ONE size
  // until tracker #12, so the first, as the public flyer does - D3a).
  const { entries: orgEntries, loading: orgLoading, error: orgError } = orgList;
  const authorityPrefill = useMemo(
    () =>
      unit === null
        ? NO_AUTHORITY_PREFILL
        : prefillAuthorities(authoritiesOf(unit), { entries: orgEntries, loading: orgLoading, error: orgError }),
    [unit, orgEntries, orgLoading, orgError],
  );
  const propertyVoucherSize = unit === null ? undefined : acceptedVoucherSizes(unit)[0];

  // D3 ownership: staff's edits for THIS property win; a filter not edited
  // shows the prefill. A DIFFERENT property resets the edits (pickProperty).
  const [edits, setEdits] = useState<FilterEdits>(() => ({ unitId: unitId ?? null }));
  const unitKey = effectiveUnitId ?? null;
  const ownEdits: FilterEdits = edits.unitId === unitKey ? edits : { unitId: unitKey };
  const authorities = ownEdits.authorities ?? authorityPrefill.names;
  const size = ownEdits.size !== undefined ? (ownEdits.size ?? undefined) : propertyVoucherSize;
  // The filter keeps its identity while its content stays (the draft hook
  // re-runs on a new filter object): keyed on the names joined by a line
  // break, which no organization name can hold.
  const authoritiesKey = authorities.join('\n');
  const filter = useMemo<AudienceFilter>(() => {
    const names = authoritiesKey === '' ? [] : authoritiesKey.split('\n');
    return {
      contact_type: 'tenant',
      ...(names.length > 0 && { housing_authorities: names }),
      ...(size !== undefined && { bedroomSize: size }),
    };
  }, [authoritiesKey, size]);

  // D3 timing: ONLY with a property attached and the filters on (never on a
  // resumed draft, which has no property here) does Preview wait for the
  // prefill to settle - the property loaded or failed, AND the organization
  // list loaded or failed. An ABORTED load is neither (the load effect).
  // While it waits the draft hook makes NO draft (`hold`, AR23): a draft made
  // now would carry a filter the prefill is about to change.
  const prefillGated = audienceEnabled && effectiveUnitId !== undefined && resumeDraftId === undefined;
  const prefillPending = prefillGated && (loaded === null || orgLoading);
  const prefillNotices: string[] = [];
  if (prefillGated && loaded !== null && loaded.status === 'failed') prefillNotices.push(PROPERTY_LOAD_FAILED);
  if (prefillGated && orgError && orgListUnknown(orgList)) prefillNotices.push(ORG_LIST_FAILED);

  // Preview step state. A result is kept with the draft it previewed and the
  // inputs that draft was made for: those candidates belong to that draft
  // alone (code review R3-FE-1 - see currentPreview below).
  const [preview, setPreview] = useState<{ draftId: string; key: string; result: PreviewResponse } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // matching-blast-rules D7 (AR39): the last Preview was refused 503
  // audience_rules_unavailable - kept with the draft it read, like a result;
  // compose says why, with Try again, while that draft is the one on screen.
  const [refusal, setRefusal] = useState<PreviewRefusal | null>(null);

  // Spec 2026-10-06 D7, matching-blast-rules D3b: a 422 org_not_on_list from
  // the draft create or from Preview names the member of the housing
  // authority filter that left the list. THAT member alone is removed (an
  // edit: the prefill never puts it back while the property stays) and this
  // message stays under the picker until the operator next changes a filter
  // (a recreate clears the draft hook's own error, so the composer owns this
  // one). AR39: both belong to the property the refused request was made for
  // - the removal applies only while the edits are still that property's,
  // and the notice shows only while that property is on screen - so a refusal
  // that lands after a change to a DIFFERENT property changes and says nothing.
  const [authorityNotice, setAuthorityNotice] = useState<AuthorityNotice | null>(null);
  function rejectAuthority(text: string | null): void {
    // This render's property and list: the ones the refused request carried
    // (Preview: the clicking render; a create: the render whose inputs it was
    // made for - a later change supersedes it in the draft hook).
    const owner = unitKey;
    const current = authorities;
    const kept = text === null ? current : current.filter((name) => name.trim() !== text.trim());
    // A refusal that names no member we hold (never expected) empties the
    // list, so the composer is never left holding a filter the server refuses.
    const next = kept.length < current.length ? kept : [];
    setEdits((prev) => (prev.unitId === owner ? { ...prev, authorities: next } : prev));
    setAuthorityNotice({ unitId: owner, text: authorityLeftTheList(text ?? 'That housing authority') });
  }
  /** A filter change from AudienceFilters: each filter that differs from the
   *  one on screen becomes staff's edit for this property (D3). */
  function onFilterChange(next: AudienceFilter): void {
    setAuthorityNotice(null);
    const nextAuthorities = next.housing_authorities ?? [];
    const nextSize = next.bedroomSize ?? null;
    const authoritiesEdited = nextAuthorities.join('\n') !== authoritiesKey;
    const sizeEdited = nextSize !== (size ?? null);
    if (!authoritiesEdited && !sizeEdited) return;
    setEdits((prev) => {
      const own: FilterEdits = prev.unitId === unitKey ? prev : { unitId: unitKey };
      return {
        ...own,
        ...(authoritiesEdited && { authorities: nextAuthorities }),
        ...(sizeEdited && { size: nextSize }),
      };
    });
  }
  // Code review R2-FE-3: text typed in the housing authority filter but never
  // picked is NOT a filter (D7 - the draft changes only on a pick or a clear,
  // never per keystroke), so Preview waits while there is any: a preview (and
  // the send after it) of every tenant must never pass for a filtered one.
  // AudienceFilters reports it; the picker reports '' when it unmounts.
  const [authorityText, setAuthorityText] = useState('');
  const authorityTyped = authorityText.trim() !== '';

  // Tenant candidates for the "add a tenant" search (loaded once).
  const [tenants, setTenants] = useState<Contact[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(true);

  const draft = useComposerDraft({
    ...(effectiveUnitId !== undefined && { unitId: effectiveUnitId }),
    bodyTemplate,
    ...(audienceEnabled && { filter }),
    ...(seedContactIds.length > 0 && { seedContactIds }),
    onOrgNotOnList: (err) => rejectAuthority(orgNotOnListBody(err)?.text ?? null),
    // matching-blast-rules D3 (AR23, AR35): no draft until the prefill settles.
    hold: prefillPending,
    // Untouched pre-fill/auto-seed = zero operator work: the draft is deleted
    // on unmount instead of littering the Matching list. A resumed draft is
    // the operator's saved work — never disposable.
    disposable: !bodyEdited && resumeDraftId === undefined,
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
  // EVERY page is walked (getAllUnits): the server pages at 50, and a
  // one-shot first page left the rest of a real portfolio unpickable - not just
  // unbrowsable, but unfindable by search too, since the search filters this
  // array client-side.
  useEffect(() => {
    if (unitId !== undefined) return; // fixed by the entry point
    const controller = new AbortController();
    getAllUnits({}, controller.signal)
      .then(setUnitCandidates)
      .catch(() => {
        /* candidate load failed - the picker just has nothing to suggest */
      });
    return () => controller.abort();
  }, [unitId]);

  // Load the property (address -> property label; its authorities and voucher
  // size feed the prefill above). The result is kept WITH the id it was for,
  // so a stale property never shows for a new pick and no reset is needed when
  // the picker clears.
  useEffect(() => {
    if (effectiveUnitId === undefined) return;
    const id = effectiveUnitId;
    const controller = new AbortController();
    getUnit(id, controller.signal)
      .then((loadedUnit) => setUnitLoad({ unitId: id, status: 'loaded', unit: loadedUnit }))
      .catch((err: unknown) => {
        // matching-blast-rules D3: an ABORTED load (an unmount, a property
        // change, StrictMode's double mount - api/client.ts rethrows the
        // AbortError) is neither loaded nor failed: the gate keeps waiting and
        // no notice shows. A real failure settles the prefill with its notice;
        // compose still works without it.
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setUnitLoad({ unitId: id, status: 'failed' });
      });
    return () => controller.abort();
  }, [effectiveUnitId]);

  // Auto-seed the one-to-one default for the single recipient (share-skip-fix
  // D8): the property's one-line address, one space, the flyer link - no name,
  // no greeting, no beds, no rent. Only in resolved mode, only with a property
  // attached (no unit -> leave the body alone until the operator types or picks
  // one), and only while the operator has not hand-edited it. Re-seeds on
  // unit/flyer change. Written via a guarded state update (NOT the edit-tracking
  // onChange) so it never marks the body as edited. The flyer prefers the
  // server's flyerUrl, falling back to the same-origin funnel until the first
  // draft exists.
  useEffect(() => {
    if (!resolvedMode || unit === null || bodyEdited) return;
    const flyer =
      draft.flyerUrl ?? (effectiveUnitId !== undefined ? flyerLinkFor(effectiveUnitId) : undefined);
    setMessage((current) =>
      current.edited ? current : {
        // share-skip-fix D8: one recipient -> address + flyer link only.
        body: resolveTemplateForUnit(ONE_TO_ONE_SEND_TEMPLATE, unit, flyer),
        edited: false,
      },
    );
  }, [resolvedMode, unit, bodyEdited, draft.flyerUrl, effectiveUnitId]);

  // Multi-recipient prefill (property-first, spec 2026-07-13): the moment a
  // property is attached OUTSIDE resolved mode, fill the message with its REAL
  // details - unit tokens resolve to text, [TenantName] STAYS a token so every
  // recipient still gets their own name at send time. Re-seeds on unit/flyer
  // change until the operator edits. Never on ?draftId= resume (a non-empty
  // body would recreate-and-delete the resumed draft).
  useEffect(() => {
    if (resolvedMode || unit === null || bodyEdited || resumeDraftId !== undefined) return;
    const flyer =
      draft.flyerUrl ?? (effectiveUnitId !== undefined ? flyerLinkFor(effectiveUnitId) : undefined);
    setMessage((current) =>
      current.edited ? current : {
        body: resolveTemplateForUnit(DEFAULT_SEND_TEMPLATE, unit, flyer),
        edited: false,
      },
    );
  }, [resolvedMode, unit, bodyEdited, resumeDraftId, draft.flyerUrl, effectiveUnitId]);

  // Load tenant candidates once. EVERY page, for the same reason the property
  // picker above walks them: the search filters this array CLIENT-side, so a
  // tenant missing from it is not merely unbrowsable but unfindable.
  // (This list backs the manual "add a tenant" box only - a broadcast's actual
  // audience is resolved server-side by audienceResolution, which pages.)
  useEffect(() => {
    const controller = new AbortController();
    getAllContacts({ type: 'tenant' }, controller.signal)
      .then((items) => {
        setTenants(items);
        setTenantsLoading(false);
      })
      .catch(() => setTenantsLoading(false));
    return () => controller.abort();
  }, []);

  const propertyLabel = useMemo(
    () => (unit !== null ? shortAddress(unit.address, unit.unitId) : undefined),
    [unit],
  );

  // The seeded tenant's display name (falls back to the raw id when the contact
  // fetch failed) — shared by the seeds-only banner and the resolved 1:1 guard.
  const seedDisplayName =
    seedContact !== null
      ? contactDisplayName(seedContact.firstName, seedContact.lastName, seedContact.phone)
      : (seedContactId ?? '');

  // A textarea keystroke (as opposed to the programmatic auto-seed): take the
  // operator's edit AND latch bodyEdited so the auto-seed stops overwriting it.
  function onBodyChange(next: string): void {
    setMessage({ body: next, edited: true });
  }

  // "Add more tenants by filters" - the one-way flip out of seeds-only. Leaving
  // resolved mode with a unit attached always resets the body: the resolved text
  // was composed for ONE tenant (and may have been edited for them), so it must
  // never send to a broader audience. When the operator has edited that text,
  // confirm before discarding (cancel aborts the flip);
  // when it is still the untouched auto-seed there is nothing to protect, so the
  // reset is silent. The body clears and the multi-recipient prefill effect
  // refills it with the property's details + a [TenantName] token. A no-unit
  // typed body is a plain token template already and survives the flip untouched.
  function onEnableFilters(): void {
    if (resolvedMode && unit !== null) {
      if (bodyEdited) {
        const ok = window.confirm(
          'Switching the audience resets the message to the template. Discard your edits?',
        );
        if (!ok) return;
      }
      setMessage({ body: '', edited: false });
    }
    setAudienceEnabled(true);
  }

  /** The property step's pick (a browse row, or the search field - which also
   *  reports plain typing, with no unitId). matching-blast-rules D3: a
   *  DIFFERENT property empties both filters at once - its prefill fills them
   *  when it loads, and the old property's edits are dropped, with no confirm
   *  (they were chosen for the old property, as the message was); the same
   *  property again changes nothing. A failed load of the picked property is
   *  retried by the pick, so the gate waits for the new attempt. */
  function pickProperty(next: UnitSearchValue): void {
    setUnitPick(next);
    const id = next.unitId;
    if (id === undefined) return;
    if (edits.unitId !== id) setAuthorityNotice(null);
    setEdits((prev) => (prev.unitId === id ? prev : { unitId: id }));
    setUnitLoad((prev) => (prev !== null && prev.unitId === id && prev.status === 'failed' ? null : prev));
  }

  // "Change property" (picked entries only) - back to the property step. An
  // edited message was written for THIS property, so confirm the discard; an
  // untouched prefill just refills for the next pick. The filters wait for
  // the next pick (pickProperty): the same property keeps them.
  function onChangeProperty(): void {
    if (bodyEdited) {
      const ok = window.confirm(
        'Changing the property resets the message for the new property. Discard your edits?',
      );
      if (!ok) return;
    }
    setMessage({ body: '', edited: false });
    setUnitPick({ label: '' });
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
    // What this Preview reads: the current draft, made for the inputs on
    // screen now (canPreview holds draftKey === key).
    const previewed = { draftId: draft.draftId, key: draft.key };
    setPreviewBusy(true);
    setPreviewError(null);
    setRefusal(null);
    setPreview(null);
    try {
      const result = await previewBroadcast(previewed.draftId);
      setPreview({ ...previewed, result });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.code === 'org_not_on_list') {
        // Spec D7, matching-blast-rules D3b: a member of the stored filter
        // left the list after the draft was made - the create's answer. This
        // is the clicking render's rejectAuthority (its property and list,
        // AR39): a property changed meanwhile keeps its own filter.
        rejectAuthority(orgNotOnListBody(err)?.text ?? null);
      } else if (err instanceof ApiError && err.status === 503 && err.code === 'audience_rules_unavailable') {
        // matching-blast-rules D5, D7: the tours or decline read failed, so no
        // list is served (it would check people the rules leave out). Compose
        // stays, with Try again - kept with the draft this Preview read (AR39).
        setRefusal({ ...previewed, unitId: unitKey, kind: 'rules_unavailable' });
      } else if (err instanceof ApiError) {
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
  // must not Preview/Send against it. Editing again retries the recreate. The
  // draft must have been made for what is on screen (draftKey === key) from
  // the very render a change lands in, before its recreate starts (R3-FE-1).
  // And while the housing authority filter holds typed text (R2-FE-3, above),
  // and while the property prefill settles (matching-blast-rules D3).
  const canPreview =
    bodyTemplate.trim().length > 0 &&
    draft.draftId !== null &&
    draft.draftKey === draft.key &&
    !draft.reachPending &&
    !draft.stale &&
    !authorityTyped &&
    !prefillPending;

  // Code review R3-FE-1: a Preview's candidates belong to the draft it
  // previewed. They are reviewed - and Send posts them - only while that
  // draft is still the current one and still made for what is on screen. A
  // result that lands after the audience or the message changed (a new draft
  // made or still being made, a property changed) is dropped, and the compose
  // step says so: Send never posts one draft's candidates to another draft.
  // The filters are frozen while a Preview is in flight (AudienceFilters
  // `disabled`), so a filter change cannot even start then.
  const currentPreview =
    preview !== null &&
    preview.draftId === draft.draftId &&
    preview.key === draft.key &&
    draft.draftKey === draft.key
      ? preview
      : null;

  // matching-blast-rules D7 (AR39): a 503 refusal is shown - the alert and its
  // Try again - only under the SAME rule as a result: while the draft it read
  // is still the current one and still made for what is on screen. Any filter,
  // message or property change fails it, so the alert goes with no effect;
  // a refusal that lands late shows nothing.
  const currentRefusal =
    refusal !== null &&
    refusal.draftId === draft.draftId &&
    refusal.key === draft.key &&
    draft.draftKey === draft.key
      ? refusal
      : null;

  // PROPERTY step - a Matching send ALWAYS carries a property, so until one is
  // attached the only thing on screen is the choice itself: a search field plus
  // a browsable candidate list (no typing needed to see options). ?unitId=
  // entries skip this (property fixed); a resumed draft keeps its stored unit
  // server-side and resumes at compose.
  if (effectiveUnitId === undefined && resumeDraftId === undefined) {
    const query = unitPick.label.trim().toLowerCase();
    // The query matches across the WHOLE portfolio (every page was walked), not
    // just the rows currently revealed.
    const matching =
      query.length > 0
        ? unitCandidates.filter((u) =>
            shortAddress(u.address, u.unitId).toLowerCase().includes(query),
          )
        : unitCandidates;
    // A query the reveal state doesn't belong to starts over at one batch.
    const shownCount = reveal.query === query ? reveal.count : UNIT_BROWSE_BATCH;
    const shown = matching.slice(0, shownCount);
    const hasMore = matching.length > shown.length;
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Send a property</h1>
        {seedContactIds.length > 0 ? (
          <p className={styles.seedBannerText}>
            Sending to <strong>{seedDisplayName}</strong>.
          </p>
        ) : null}
        <p className={styles.pickerHint}>Choose the property to send.</p>
        <div className={styles.pickerField}>
          <span className={styles.pickerLabel}>Property</span>
          <UnitSearchField
            value={unitPick}
            onChange={pickProperty}
            candidates={unitCandidates}
            inputLabel="Property"
          />
        </div>
        <ul className={styles.unitList} aria-label="Properties">
          {shown.map((u) => (
            <li key={u.unitId} className={styles.unitListItem}>
              <button
                type="button"
                className={styles.unitRow}
                onClick={() =>
                  pickProperty({ label: shortAddress(u.address, u.unitId), unitId: u.unitId })
                }
              >
                <span>{shortAddress(u.address, u.unitId)}</span>
                <span className={styles.unitMeta}>
                  {typeof u.beds === 'number' ? `${u.beds} BR - ` : ''}
                  {LISTING_STATUS_LABELS[u.status as ListingStatus] ?? u.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {hasMore ? (
          <div className={styles.moreRow}>
            <button
              type="button"
              className={styles.loadMoreBtn}
              onClick={() => setReveal({ query, count: shownCount + UNIT_BROWSE_BATCH })}
            >
              Load more
            </button>
            <span className={styles.moreCount} role="status">
              Showing {shown.length} of {matching.length}
            </span>
          </div>
        ) : null}
        {unitCandidates.length === 0 ? (
          <p className={styles.pickerHint}>No properties yet - add one from the Properties page.</p>
        ) : null}
        {unitCandidates.length > 0 && matching.length === 0 ? (
          <p className={styles.pickerHint}>
            No properties match that search - clear it to browse them all.
          </p>
        ) : null}
      </div>
    );
  }

  // PREVIEW step - the curated list of the draft it previewed (R3-FE-1).
  if (currentPreview !== null) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Review recipients</h1>
        <button type="button" className={styles.backStep} onClick={() => setPreview(null)}>
          ← Edit audience &amp; message
        </button>
        {unavailableNote}
        <RecipientPreview
          draftId={currentPreview.draftId}
          preview={currentPreview.result}
          tenantCandidates={tenants}
          candidatesLoading={tenantsLoading}
          {...(effectiveUnitId !== undefined && { unitId: effectiveUnitId })}
          {...(resolvedMode &&
            seedContactIds[0] !== undefined && {
              resolvedFor: { contactId: seedContactIds[0], name: seedDisplayName },
            })}
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
                Sending to <strong>{seedDisplayName}</strong>.
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
              onChange={onFilterChange}
              orgList={orgList}
              onAuthorityTextChange={setAuthorityText}
              authorityError={
                authorityNotice !== null && authorityNotice.unitId === unitKey ? authorityNotice.text : null
              }
              disabled={previewBusy}
              {...(propertyVoucherSize !== undefined && { propertyVoucherSize })}
              unusedAuthorities={authorityPrefill.unused}
              noAuthorityMapped={authorityPrefill.names.length === 0 && authorityPrefill.unused.length > 0}
              prefillNotices={prefillNotices}
              {...(draft.reachCount !== undefined && { reachCount: draft.reachCount })}
              reachPending={draft.reachPending}
              truncated={draft.truncated}
            />
          )}
          {unitId === undefined ? (
            <p className={styles.changeProperty}>
              Property: <strong>{propertyLabel ?? effectiveUnitId}</strong>{' '}
              <button
                type="button"
                className={styles.changePropertyBtn}
                onClick={onChangeProperty}
                aria-label="Change property"
              >
                Change
              </button>
            </p>
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
      {currentRefusal !== null ? (
        <p className={styles.error} role="alert">
          {RULES_UNAVAILABLE}{' '}
          <button
            type="button"
            className={styles.retryBtn}
            disabled={!canPreview || previewBusy}
            onClick={() => void onPreview()}
          >
            Try again
          </button>
        </p>
      ) : null}
      {preview !== null && currentPreview === null ? (
        <p className={styles.error} role="alert">
          {AUDIENCE_CHANGED}
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
        {/* A disabled button must say WHY: the operator-actionable gates are
            the empty message and text typed in the housing authority filter;
            the settling draft/reach is transient (spinner). A stale draft's
            failure already renders in the error alert above. */}
        {!previewBusy && !canPreview ? (
          bodyTemplate.trim().length === 0 ? (
            <span className={styles.previewHint}>Write a message to enable the preview.</span>
          ) : authorityTyped ? (
            <span className={styles.previewHint}>{ORG_FILTER_TYPED_HINT}</span>
          ) : draft.reachPending || draft.draftId === null || prefillPending ? (
            <span className={styles.previewHint}>Sizing the audience…</span>
          ) : null
        ) : null}
      </div>
    </div>
  );
}
