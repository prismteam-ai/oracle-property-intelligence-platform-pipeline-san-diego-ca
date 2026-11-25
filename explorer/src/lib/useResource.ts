import { useCallback, useEffect, useRef, useState } from 'react';

export type Resource<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; error: Error };

const cache = new Map<string, Promise<unknown>>();

/** Test helper: forget every cached answer. */
export function clearResourceCache(): void {
  cache.clear();
}

/**
 * Loads one keyed resource and shares the answer between components (the header and a section
 * often need the same tool call). `key === null` means "do not load yet". Failed loads are not
 * cached, and `reload` forces a fresh call.
 */
export function useResource<T>(
  key: string | null,
  load: () => Promise<T>,
): { state: Resource<T>; reload: () => void } {
  const [state, setState] = useState<Resource<T>>(
    key === null ? { status: 'idle' } : { status: 'loading' },
  );
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) {
      setState({ status: 'idle' });
      return;
    }
    let live = true;
    setState({ status: 'loading' });
    let pending = cache.get(key) as Promise<T> | undefined;
    if (!pending) {
      const started = loadRef.current();
      pending = started;
      cache.set(key, started);
      started.catch(() => {
        if (cache.get(key) === started) cache.delete(key);
      });
    }
    pending.then(
      (data) => {
        if (live) setState({ status: 'ok', data });
      },
      (error: unknown) => {
        if (live) {
          setState({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [key, nonce]);

  const reload = useCallback(() => {
    if (key !== null) cache.delete(key);
    setNonce((n) => n + 1);
  }, [key]);

  return { state, reload };
}
