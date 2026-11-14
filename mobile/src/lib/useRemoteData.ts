import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

/**
 * Load data, poll it while the app is in the foreground, and refresh when the app returns to the foreground.
 * `load` should be memoised by the caller (useCallback) so changing it reloads.
 */
export function useRemoteData<T>(load: () => Promise<T>, pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const inFlight = useRef(false);

  const fetchNow = useCallback(async (manual = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (manual) setRefreshing(true);
    try {
      const next = await loadRef.current();
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setData(null);
    void fetchNow();
  }, [load, fetchNow]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void fetchNow();
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    if (pollMs > 0) {
      timer = setInterval(() => {
        if (AppState.currentState === "active") void fetchNow();
      }, pollMs);
    }
    return () => {
      sub.remove();
      if (timer) clearInterval(timer);
    };
  }, [fetchNow, pollMs]);

  const refresh = useCallback(() => fetchNow(true), [fetchNow]);
  const reload = useCallback(() => fetchNow(false), [fetchNow]);

  return { data, error, loading: data === null && error === null, refreshing, refresh, reload, setData };
}
