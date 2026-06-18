// useContactVocabulary — fetches the operator-configured pick-lists once on
// mount. Best-effort: suggestions are non-critical, so errors degrade to empty
// lists and never throw to the UI.
import { useEffect, useState } from 'react';
import { getContactVocabulary, type ContactVocabulary } from '../../api/index.js';

const EMPTY: ContactVocabulary = { roles: [], relationshipRoles: [], fieldLabels: [] };

export function useContactVocabulary(): ContactVocabulary {
  const [vocabulary, setVocabulary] = useState<ContactVocabulary>(EMPTY);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const vocab = await getContactVocabulary(controller.signal);
        if (controller.signal.aborted) return;
        setVocabulary(vocab);
      } catch (err) {
        // AbortError on unmount — silently ignore.
        // Any other error — degrade to empty lists (suggestions are non-critical).
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        // Keep the empty vocabulary; do not surface an error state.
      }
    })();
    return () => controller.abort();
  }, []);

  return vocabulary;
}
