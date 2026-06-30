import { useState, useEffect, useRef } from 'react';

// Bump this prefix to invalidate ALL persisted state across a breaking release.
const NS = 'tf.v1.';

// Hardened localStorage-backed state.
//
// Improvements over the naive version:
//  - namespaced + versioned keys (change NS to drop stale data safely)
//  - tolerant of corrupt / legacy JSON (falls back to initial)
//  - `initial` may be a value or a lazy factory function
//  - optional `rehydrate(parsed)` runs on load to sanitise the stored value,
//    e.g. reset transient flags (loading), cap arrays, or drop dead references.
//
// Usage:
//   const [x, setX] = usePersistentState('compare.rows', [], {
//     rehydrate: rows => rows.map(r => ({ ...r, loading: false, error: null })).slice(0, 24),
//   });
export function usePersistentState(key, initial, options = {}) {
  const { rehydrate } = options;
  const storageKey = NS + key;

  // keep latest rehydrate without re-running the initializer
  const rehydrateRef = useRef(rehydrate);
  rehydrateRef.current = rehydrate;

  const makeInitial = () => (typeof initial === 'function' ? initial() : initial);

  const [val, setVal] = useState(() => {
    try {
      const s = localStorage.getItem(storageKey);
      if (s === null) return makeInitial();
      const parsed = JSON.parse(s);
      return rehydrateRef.current ? rehydrateRef.current(parsed) : parsed;
    } catch {
      return makeInitial();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(val));
    } catch {
      // quota exceeded or storage unavailable — silently ignore
    }
  }, [storageKey, val]);

  return [val, setVal];
}
