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
 *
 * The answer is stored with the key it belongs to, so in the render right after the key changes
 * the caller sees "loading" and never the previous key's data.
 */
export function useResource<T>(
  key: string | null,
  load: () => Promise<T>,
): { state: Resource<T>; reload: () => void } {
  const [held, setHeld] = useState<{ key: string | null; resource: Resource<T> }>({
    key,
    resource: key === null ? { status: 'idle' } : { status: 'loading' },
  });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) {
      setHeld({ key, resource: { status: 'idle' } });
      return;
    }
    let live = true;
    setHeld({ key, resource: { status: 'loading' } });
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
        if (live) setHeld({ key, resource: { status: 'ok', data } });
      },
      (error: unknown) => {
        if (live) {
          setHeld({
            key,
            resource: {
              status: 'error',
              error: error instanceof Error ? error : new Error(String(error)),
            },
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

  const state: Resource<T> =
    held.key === key ? held.resource : key === null ? { status: 'idle' } : { status: 'loading' };
  return { state, reload };
}
