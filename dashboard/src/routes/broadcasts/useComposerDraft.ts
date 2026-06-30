// useComposerDraft — owns the single throwaway DRAFT that backs the composer's
// LIVE reach + the Preview/Send id. There is NO draft-update endpoint (editing a
// draft = recreate), so this keeps exactly ONE "current draft id" at a time: on a
// material audience/message change (debounced), it creates a fresh draft to get
// the new `estimatedCount`+`truncated`, then deletes the PREVIOUS throwaway draft
// so no orphan drafts leak. The current id is reused for Preview + Send.
//
// A draft is (re)created only when the message is non-empty (the backend requires
// a non-empty body_template); until then the reach shows "unavailable". The
// unitId never changes within a composer session, so it's a stable input.
//
// On unmount, if the current draft was never sent it stays a draft in the list
// (the operator can resume it) — we do NOT auto-delete on unmount (that would
// drop a draft the user may want). Orphan avoidance targets the rapid-iteration
// churn (each keystroke-batch's superseded draft), which IS cleaned up here.
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
  filter: AudienceFilter;
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
  /** A non-validation creation error (network), or null. */
  error: string | null;
  /** Adopt an externally-known draft id (resuming a draft row) WITHOUT creating
   *  one — subsequent material edits still recreate + clean up as usual. */
  adoptDraftId: (id: string) => void;
}

/** Stable key for the material draft inputs — a change here triggers a recreate. */
function materialKey(input: ComposerDraftInput): string {
  return JSON.stringify({
    u: input.unitId ?? null,
    b: input.bodyTemplate.trim(),
    f: {
      h: input.filter.housing_authority ?? null,
      s: input.filter.bedroomSize ?? null,
    },
  });
}

export function useComposerDraft(input: ComposerDraftInput): ComposerDraftState {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [reachCount, setReachCount] = useState<number | undefined>(undefined);
  const [truncated, setTruncated] = useState(false);
  const [reachPending, setReachPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The currently-live draft id, read inside async callbacks without re-binding.
  const currentIdRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Bumped on each (re)create kickoff; a resolved create from a superseded
  // attempt is discarded (it must not adopt a stale id as current).
  const genRef = useRef(0);
  const lastKeyRef = useRef<string | null>(null);

  const adoptDraftId = useCallback((id: string) => {
    currentIdRef.current = id;
    setDraftId(id);
  }, []);

  const key = materialKey(input);
  const hasBody = input.bodyTemplate.trim().length > 0;

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
        setReachCount(undefined);
        setTruncated(false);
        setReachPending(false);
      }
      return;
    }
    clearedRef.current = false;
    // Same material inputs as the live draft → nothing to do.
    if (lastKeyRef.current === key) return;

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
        audience_filter: input.filter,
      })
        .then((created) => {
          if (gen !== genRef.current) {
            // Superseded by a newer create — delete THIS throwaway so it doesn't leak.
            void deleteBroadcast(created.broadcastId).catch(() => {});
            return;
          }
          lastKeyRef.current = key;
          currentIdRef.current = created.broadcastId;
          setDraftId(created.broadcastId);
          setReachCount(created.estimatedCount);
          setTruncated(created.truncated);
          setReachPending(false);
          // Clean up the PREVIOUS throwaway draft now that a fresh one supersedes it.
          if (previousId !== null && previousId !== created.broadcastId) {
            void deleteBroadcast(previousId).catch(() => {});
          }
        })
        .catch((err: unknown) => {
          if (gen !== genRef.current) return;
          setReachPending(false);
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
    };
  }, [key, hasBody, input.unitId, input.bodyTemplate, input.filter]);

  return {
    draftId,
    reachCount,
    truncated,
    reachPending,
    error,
    adoptDraftId,
  };
}
