import { useState, useEffect } from 'react';

export function usePersistentState(key, initial) {
  const [val, setVal] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s !== null ? JSON.parse(s) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      // localStorage full or unavailable — silently ignore
    }
  }, [key, val]);

  return [val, setVal];
}
