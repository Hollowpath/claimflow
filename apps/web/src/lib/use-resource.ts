import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../api/client';

/** Primitive inputs that identify one load. */
export type ResourceDeps = readonly (string | number | boolean | undefined)[];

export type Resource<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly error: ApiError }
  | { readonly state: 'ready'; readonly data: T };

/**
 * Loads data for a component. Each load is identified by its inputs; a result
 * is shown only while those inputs are current, and late results are dropped,
 * so a slow response for one user or claim can never appear for another.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: ResourceDeps,
): Resource<T> & {
  reload: () => void;
  replace: (data: T) => void;
} {
  const [generation, setGeneration] = useState(0);
  const key = JSON.stringify([...deps, generation]);
  const [result, setResult] = useState<{
    key: string;
    resource: Resource<T>;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setResult({ key, resource: { state: 'ready', data } });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({
            key,
            resource: { state: 'error', error: toApiError(error) },
          });
        }
      },
    );
    return () => controller.abort();
    // `key` captures every input; `load` is recreated on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const replace = useCallback(
    (data: T) => setResult({ key, resource: { state: 'ready', data } }),
    [key],
  );
  const resource: Resource<T> =
    result?.key === key ? result.resource : { state: 'loading' };
  return { ...resource, reload, replace };
}

export function toApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(
        0,
        'INTERNAL_ERROR',
        'Something went wrong. Please try again.',
      );
}
