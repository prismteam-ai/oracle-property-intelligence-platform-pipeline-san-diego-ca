import { useEffect, useState, type ReactNode } from 'react';
import { copyText, fmtCell } from '../lib/format';
import type { Resource } from '../lib/useResource';

/** Spinner with a second line once the wait is long enough to be a cold start. */
export function Loading({ label, testId }: { label: string; testId?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1500);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="loading" role="status" aria-live="polite" data-testid={testId ?? 'loading'}>
      <span className="spinner" aria-hidden="true" />
      <span>
        {label}
        {slow ? (
          <span className="muted">
            {' '}
            Still working: the first request after idle can take about 4 seconds (cold start).
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function ErrorNotice({
  error,
  onRetry,
  testId,
}: {
  error: Error;
  onRetry?: () => void;
  testId?: string;
}) {
  return (
    <div className="notice notice-error" role="alert" data-testid={testId ?? 'error'}>
      <div className="notice-body">{error.message}</div>
      {onRetry ? (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** Renders the loading, error and ready states of a resource in one place. */
export function ResourceView<T>({
  state,
  reload,
  label,
  testId,
  children,
}: {
  state: Resource<T>;
  reload: () => void;
  label: string;
  testId?: string;
  children: (data: T) => ReactNode;
}) {
  if (state.status === 'idle') return null;
  if (state.status === 'loading') {
    return <Loading label={label} testId={testId ? `${testId}-loading` : undefined} />;
  }
  if (state.status === 'error') {
    return (
      <ErrorNotice
        error={state.error}
        onRetry={reload}
        testId={testId ? `${testId}-error` : undefined}
      />
    );
  }
  return <>{children(state.data)}</>;
}

export function CopyButton({
  value,
  label = 'Copy',
  testId,
}: {
  value: string;
  label?: string;
  testId?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="btn btn-small"
      data-testid={testId}
      onClick={() => {
        void copyText(value).then((ok) => setState(ok ? 'copied' : 'failed'));
      }}
    >
      <span aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </span>
    </button>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/** A source URL as a link, or plain text when it is not a web address (e.g. "local"). */
export function SourceLink({ url, label }: { url: string | null; label?: string }) {
  if (!url) return <span className="muted">no link</span>;
  if (!/^https?:\/\//.test(url)) return <span className="muted">{url}</span>;
  return <ExternalLink href={url}>{label ?? url.replace(/^https?:\/\//, '')}</ExternalLink>;
}

export function Card({
  title,
  aside,
  children,
  testId,
  id,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  testId?: string;
  id?: string;
}) {
  return (
    <section className="card" data-testid={testId} id={id} aria-label={title}>
      <header className="card-head">
        <h3>{title}</h3>
        {aside ? <div className="card-aside">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

const isNumeric = (value: unknown): boolean =>
  typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value));

/** Generic table for query and agent rows. Links are made clickable; long text wraps. */
export function DataTable({
  columns,
  rows,
  testId,
  caption,
}: {
  columns: readonly string[];
  rows: readonly Record<string, unknown>[];
  testId?: string;
  caption: string;
}) {
  return (
    <div
      className="table-scroll"
      data-testid={testId}
      tabIndex={0}
      role="group"
      aria-label={caption}
    >
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => {
                const value = row[c];
                const textValue = fmtCell(value);
                return (
                  <td
                    key={c}
                    className={
                      isNumeric(value) ? 'num' : textValue.length > 36 ? 'wrap' : undefined
                    }
                  >
                    {value === null || value === undefined ? (
                      <span className="null">null</span>
                    ) : /^https?:\/\//.test(textValue) ? (
                      <ExternalLink href={textValue}>link</ExternalLink>
                    ) : (
                      textValue
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function StatusBadge({ status }: { status: string | null }) {
  const ok = status === 'ok' || status === 'completed' || status === 'success';
  return (
    <span className={`badge ${ok ? 'badge-ok' : 'badge-warn'}`}>
      {ok ? 'Completed' : (status ?? 'unknown')}
    </span>
  );
}
