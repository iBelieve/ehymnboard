import { useCallback, useEffect, useState } from "react";

/** Loads a list, and reloads it after each change. */
export function useList<T>(load: () => Promise<T[]>) {
  const [items, setItems] = useState<T[]>();
  const [error, setError] = useState<string>();
  const reload = useCallback(
    () =>
      load().then(
        (next) => {
          setItems(next);
          setError(undefined);
        },
        (e: unknown) => setError(String(e)),
      ),
    [load],
  );
  useEffect(() => void reload(), [reload]);
  return { items, error, reload };
}
