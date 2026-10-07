// useComposerDraft — owns the single throwaway DRAFT that backs the composer's
// LIVE reach + the Preview/Send id. There is NO draft-update endpoint (editing a
// draft = recreate), so this keeps exactly ONE "current draft id" at a time: on a
// material audience/message change (debounced), it creates a fresh draft to get
// the new `estimatedCount`+`truncated`, then deletes the PREVIOUS throwaway draft
// so no orphan drafts leak. The current id is reused for Preview + Send.
//
// A draft is (re)created only when the message is non-empty (the backend requires
// a non-empty body_template); until then the reach shows "unavailable". A unitId
// change (the Property picker), a filter enable/edit, or a seed-list change is a
// material change like any other: the draft recreates.
//
// On unmount, if the current draft was never sent it stays a draft in the list
// (the operator can resume it) — we do NOT auto-delete on unmount (that would
// drop a draft the user may want). Orphan avoidance targets the rapid-iteration
// churn (each keystroke-batch's superseded draft), which IS cleaned up here.
// EXCEPTION: a `disposable` draft (the pre-filled default template, untouched —
// zero operator work) IS deleted on unmount, so opening the composer and
// leaving never litters the Matching list.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  createBroadcast,
  deleteBroadcast,
  type AudienceFilter,
} from '../../api/index.js';

const DEBOUNCE_MS = 600;

export interface ComposerDraftInput {
  unitId?: string;
  bodyTemplate: string;
  /** ABSENT = seeds-only draft: the createBroadcast body omits audience_filter
   *  entirely (the backend then resolves the seed list alone). */
  filter?: AudienceFilter;
  /** Hand-picked recipients seeded from the entry point (?contactId=). */
  seedContactIds?: string[];
  /** True while the draft carries NO operator work — the pre-filled default
   *  template, untouched. A disposable draft is DELETED on unmount instead of
   *  staying in the Matching list (open-and-leave must not leak a junk row).
   *  Adopted (resumed) drafts and anything hand-edited must pass false — those
   *  keep the stays-in-the-list behavior. A delete racing a just-sent broadcast
   *  is harmless: the DELETE route is draft-guarded (409, no side effects). */
  disposable?: boolean;
  /** Called when a (re)create is refused 422 org_not_on_list - the picked
   *  housing authority left the list (spec 2026-10-06 D7). The composer clears
   *  the pick and owns the message, so this draft is NOT marked stale: the
   *  cleared filter either matches the current draft again or recreates it. */
  onOrgNotOnList?: () => void;
}

export interface ComposerDraftState {
  /** The current draft id (the Preview/Send target), or null when none yet. */
  draftId: string | null;
  /** The live reach estimate from the latest draft, or undefined when none. */
  reachCount?: number;
  /** The latest draft's truncated flag. */
  truncated: boolean;
  /** True while a draft (re)creation is in flight. */
  reachPending: boolean;
  /** The flyer link for the draft's unit from the latest create response, or
   *  null when none (no unit / no flyer). Task 7's resolved editor uses it. */
  flyerUrl: string | null;
  /** A non-validation creation error (network), or null. */
  error: string | null;
  /** True when the LAST (re)create FAILED, so the current draft id no longer
   *  matches the on-screen audience/message — Preview/Send must stay disabled
   *  (don't act on a stale draft) until a fresh create succeeds. */
  stale: boolean;
  /** The material key of the inputs on screen now (unit, message, filter,
   *  seeds) - what a draft made now would be made for. */
  key: string;
  /** The material key the current draft was made for: null with no draft,
   *  an adopted one, or no message. `draftKey === key` is "the current draft
   *  is the one on screen", from the very render a change lands in - before
   *  any recreate starts (code review R3-FE-1: a Preview's result belongs to
   *  the draft it previewed). */
  draftKey: string | null;
  /** Adopt an externally-known draft id (resuming a draft row) WITHOUT creating
   *  one — subsequent material edits still recreate + clean up as usual. */
  adoptDraftId: (id: string) => void;
}

/** Stable key for the material draft inputs — a change here triggers a recreate.
 *  Covers ALL four inputs: unit, body, the filter (null when the filter is OFF,
 *  so enabling it is itself a material change), and the seed list. */
function materialKey(input: ComposerDraftInput): string {
  return JSON.stringify({
    u: input.unitId ?? null,
    b: input.bodyTemplate.trim(),
    f:
      input.filter === undefined
        ? null
        : {
            h: input.filter.housing_authority ?? null,
            s: input.filter.bedroomSize ?? null,
          },
    s: input.seedContactIds?.join(',') ?? null,
  });
}

export function useComposerDraft(input: ComposerDraftInput): ComposerDraftState {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [reachCount, setReachCount] = useState<number | undefined>(undefined);
  const [truncated, setTruncated] = useState(false);
  const [reachPending, setReachPending] = useState(false);
  const [flyerUrl, setFlyerUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // lastKeyRef's twin for rendering: the key the current draft was made for.
  const [draftKey, setDraftKey] = useState<string | null>(null);

  // The currently-live draft id, read inside async callbacks without re-binding.
  const currentIdRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Bumped on each (re)create kickoff; a resolved create from a superseded
  // attempt is discarded (it must not adopt a stale id as current).
  const genRef = useRef(0);
  const lastKeyRef = useRef<string | null>(null);
  // The latest refusal callback, read inside the async create without
  // re-binding the effect. Updated in an effect, never during render (the
  // react-hooks refs rule; the disposableRef write below predates it).
  const onOrgNotOnListRef = useRef(input.onOrgNotOnList);
  useEffect(() => {
    onOrgNotOnListRef.current = input.onOrgNotOnList;
  }, [input.onOrgNotOnList]);

  const adoptDraftId = useCallback((id: string) => {
    currentIdRef.current = id;
    setDraftId(id);
    setDraftKey(null); // what it was made for is not known here
  }, []);

  const key = materialKey(input);
  const hasBody = input.bodyTemplate.trim().length > 0;

  // Pristine-draft cleanup: mirror `disposable` into a ref so the unmount-only
  // effect below reads the LATEST value (an effect dep would re-run it).
  const disposableRef = useRef(input.disposable === true);
  disposableRef.current = input.disposable === true;
  useEffect(
    () => () => {
      if (disposableRef.current && currentIdRef.current !== null) {
        // Fire-and-forget through Promise.resolve: this runs at teardown, where
        // a test-restored (un-mocked-mid-cleanup) client may not hand back a
        // real promise - never let cleanup throw.
        void Promise.resolve(deleteBroadcast(currentIdRef.current)).catch(() => {});
      }
    },
    [],
  );

  // Tracks whether the reach is currently cleared, so the "no body" reset below
  // runs at most once per empty→empty stretch (no cascading re-render, no need
  // to read the reach state inside the effect).
  const clearedRef = useRef(true);

  useEffect(() => {
    // No message yet → nothing to estimate (the backend rejects an empty body).
    if (!hasBody) {
      if (!clearedRef.current) {
        clearedRef.current = true;
        lastKeyRef.current = null;
        setDraftKey(null);
        setReachCount(undefined);
        setTruncated(false);
        setFlyerUrl(null);
        setReachPending(false);
        setStale(false);
      }
      return;
    }
    clearedRef.current = false;
    // Same material inputs as the live draft: no draft to make. A change
    // undone before its own draft was made - inside the debounce, or after its
    // recreate failed - lands here too. Its cleanup already cleared the timer
    // and discarded any create in flight (genRef), so the screen matches the
    // live draft again: nothing is pending, nothing is stale, and no error
    // stands (code review R4-2).
    if (lastKeyRef.current === key) {
      setReachPending(false);
      setStale(false);
      setError(null);
      return;
    }

    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    setReachPending(true);
    setError(null);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      genRef.current += 1;
      const gen = genRef.current;
      const previousId = currentIdRef.current;
      createBroadcast({
        ...(input.unitId !== undefined && { unitId: input.unitId }),
        body_template: input.bodyTemplate,
        ...(input.filter !== undefined && { audience_filter: input.filter }),
        ...(input.seedContactIds !== undefined &&
          input.seedContactIds.length > 0 && { seedContactIds: input.seedContactIds }),
      })
        .then((created) => {
          if (gen !== genRef.current) {
            // Superseded by a newer create (or unmounted — cleanup bumps genRef):
            // delete THIS throwaway so it doesn't leak, and do NOT setState.
            void deleteBroadcast(created.broadcastId).catch(() => {});
            return;
          }
          lastKeyRef.current = key;
          currentIdRef.current = created.broadcastId;
          setDraftId(created.broadcastId);
          setDraftKey(key);
          setReachCount(created.estimatedCount);
          setTruncated(created.truncated);
          setFlyerUrl(created.flyerUrl ?? null);
          setReachPending(false);
          setStale(false); // a fresh draft now matches the screen again
          // Clean up the PREVIOUS throwaway draft now that a fresh one supersedes it.
          if (previousId !== null && previousId !== created.broadcastId) {
            void deleteBroadcast(previousId).catch(() => {});
          }
        })
        .catch((err: unknown) => {
          if (gen !== genRef.current) return;
          setReachPending(false);
          const onOrgNotOnList = onOrgNotOnListRef.current;
          if (
            onOrgNotOnList !== undefined &&
            err instanceof ApiError &&
            err.status === 422 &&
            err.code === 'org_not_on_list'
          ) {
            // Spec 2026-10-06 D7: the composer clears the pick and says so.
            setError(null);
            onOrgNotOnList();
            return;
          }
          // The recreate FAILED, so currentIdRef still points at the PRIOR draft
          // whose body/filter no longer match the screen — mark stale so Preview/
          // Send stay disabled until a fresh create succeeds.
          setStale(true);
          if (err instanceof ApiError && err.status === 400) {
            // A validation bounce (e.g. body too long) — surface, keep prior id.
            setError(err.message);
          } else {
            setError("Couldn't estimate the audience — try again.");
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
      // Bump the generation so a createBroadcast resolving AFTER unmount takes the
      // superseded branch — it self-deletes the orphan draft and never setStates
      // on an unmounted component (no React warning, no leaked orphan).
      genRef.current += 1;
    };
  }, [key, hasBody, input.unitId, input.bodyTemplate, input.filter, input.seedContactIds]);

  return {
    draftId,
    reachCount,
    truncated,
    reachPending,
    flyerUrl,
    error,
    stale,
    key,
    draftKey,
    adoptDraftId,
  };
}
