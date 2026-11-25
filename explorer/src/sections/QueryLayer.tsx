import { useId, useState } from 'react';
import { Card, DataTable, ErrorNotice, Loading, ResourceView } from '../components/ui';
import { getSchemaText, queryAtlas } from '../lib/api';
import { fmtInt } from '../lib/format';
import { McpError } from '../lib/mcp';
import type { QueryResult } from '../lib/schemas';
import { SQL_EXAMPLES } from '../lib/sqlExamples';
import { useResource } from '../lib/useResource';

export interface Relation {
  name: string;
  columns: { name: string; type: string }[];
  note: string;
}

/** Splits the getAtlasSchema text into relations; anything that does not fit is kept as a note. */
export function parseSchema(text: string): { relations: Relation[]; notes: string[] } {
  const relations: Relation[] = [];
  const notes: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const match = /^(\w+)\(([\s\S]*?)\)\s*(?:\n\s*--\s*([\s\S]*))?$/.exec(block.trim());
    if (!match || !/^\w+ \w+/.test(match[2] ?? '')) {
      if (block.trim() !== '') notes.push(block.trim());
      continue;
    }
    relations.push({
      name: match[1] ?? '',
      columns: (match[2] ?? '').split(/,\s*/).map((c) => {
        const [name = '', ...type] = c.trim().split(' ');
        return { name, type: type.join(' ') };
      }),
      note: (match[3] ?? '').trim(),
    });
  }
  return { relations, notes };
}

type RunState =
  | { status: 'idle' }
  | { status: 'running'; sql: string }
  | { status: 'ok'; result: QueryResult; ms: number }
  | { status: 'rejected'; message: string; sql: string }
  | { status: 'error'; error: Error };

/** The SQL box, the one-click examples and the result or the guard's refusal. */
export function QueryConsole({
  runQuery = queryAtlas,
}: {
  runQuery?: (sql: string) => Promise<QueryResult>;
}) {
  const [sql, setSql] = useState(SQL_EXAMPLES[0]?.sql ?? '');
  const [state, setState] = useState<RunState>({ status: 'idle' });
  const sqlId = useId();

  const run = (statement: string): void => {
    if (statement.trim() === '') return;
    setState({ status: 'running', sql: statement });
    const started = performance.now();
    runQuery(statement).then(
      (result) => setState({ status: 'ok', result, ms: Math.round(performance.now() - started) }),
      (error: unknown) => {
        if (error instanceof McpError && error.kind === 'tool_error') {
          setState({ status: 'rejected', message: error.message, sql: statement });
        } else {
          setState({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      },
    );
  };

  return (
    <div className="stack">
      <div>
        <p className="field-label" id={`${sqlId}-examples`}>
          One-click examples
        </p>
        <ul className="chips" aria-labelledby={`${sqlId}-examples`}>
          {SQL_EXAMPLES.map((example) => (
            <li key={example.id}>
              <button
                type="button"
                className={`chip-btn${example.forbidden ? ' chip-danger' : ''}`}
                data-testid={`sql-example-${example.id}`}
                onClick={() => {
                  setSql(example.sql);
                  run(example.sql);
                }}
              >
                {example.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <form
        className="stack-tight"
        onSubmit={(event) => {
          event.preventDefault();
          run(sql);
        }}
      >
        <label className="field-label" htmlFor={sqlId}>
          SQL (one read-only SELECT; capped at 1,000 rows)
        </label>
        <textarea
          id={sqlId}
          className="sql-input"
          data-testid="sql-input"
          rows={9}
          spellCheck={false}
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              run(sql);
            }
          }}
        />
        <div className="row">
          <button
            type="submit"
            className="btn btn-primary"
            data-testid="sql-run"
            disabled={state.status === 'running' || sql.trim() === ''}
          >
            Run query
          </button>
          <span className="muted small">Ctrl+Enter also runs it.</span>
        </div>
      </form>

      <div aria-live="polite" data-testid="sql-output">
        {state.status === 'idle' ? (
          <p className="empty-line">Pick an example or write a SELECT, then run it.</p>
        ) : null}
        {state.status === 'running' ? (
          <Loading label="Running the query in DuckDB…" testId="sql-loading" />
        ) : null}
        {state.status === 'rejected' ? (
          <div className="notice notice-guard" role="alert" data-testid="sql-rejected">
            <div className="notice-body">
              <strong>The read-only guard refused this statement.</strong>
              <p data-testid="sql-rejected-message">{state.message}</p>
              <p className="small">
                Nothing was executed. Only one SELECT (or WITH … SELECT) is accepted.
              </p>
            </div>
          </div>
        ) : null}
        {state.status === 'error' ? <ErrorNotice error={state.error} testId="sql-error" /> : null}
        {state.status === 'ok' ? (
          <div className="stack-tight">
            <p className="result-meta" data-testid="sql-meta">
              <strong data-testid="sql-row-count">{fmtInt(state.result.rowCount)} rows</strong>
              <span
                className={`badge ${state.result.truncated ? 'badge-warn' : 'badge-neutral'}`}
                data-testid="sql-truncated"
              >
                {state.result.truncated ? 'Truncated at the 1,000-row cap' : 'Not truncated'}
              </span>
              <span className="muted">{state.ms} ms round trip</span>
            </p>
            {state.result.rows.length === 0 ? (
              <p className="empty-line">The query ran and returned no rows.</p>
            ) : (
              <DataTable
                columns={state.result.columns}
                rows={state.result.rows}
                testId="sql-results"
                caption="Query results"
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SchemaView({ text }: { text: string }) {
  const { relations, notes } = parseSchema(text);
  if (relations.length === 0) return <pre className="code">{text}</pre>;
  return (
    <div className="stack-tight" data-testid="schema">
      {relations.map((r, index) => (
        <details
          className="disclosure"
          key={r.name}
          open={index === 0}
          data-testid={`schema-${r.name}`}
        >
          <summary>
            <code>{r.name}</code> <span className="muted">· {r.columns.length} columns</span>
          </summary>
          <p className="small">{r.note}</p>
          <ul className="columns">
            {r.columns.map((c) => (
              <li key={c.name}>
                <code>{c.name}</code> <span className="muted">{c.type}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
      {notes.map((n) => (
        <p className="small muted" key={n}>
          {n}
        </p>
      ))}
    </div>
  );
}

export default function QueryLayer() {
  const schema = useResource('schema', () => getSchemaText());
  return (
    <div className="page" data-testid="section-query">
      <div className="page-head">
        <div>
          <h2>Query layer (DuckDB)</h2>
          <p className="muted">Structured queries over the published snapshot.</p>
        </div>
      </div>

      <div className="notice notice-info" data-testid="duckdb-statement">
        <div className="notice-body">
          <strong>No database server is running.</strong> The data is served by DuckDB reading the
          published Parquet files directly, inside a function that starts on request and scales to
          zero. There is no Oracle-hosted database to operate: the same Parquet files that are
          pinned to IPFS are the database.
        </div>
      </div>

      <Card title="Run a query" testId="card-sql">
        <QueryConsole />
      </Card>

      <Card title="Schema" testId="card-schema">
        <ResourceView
          state={schema.state}
          reload={schema.reload}
          label="Loading the schema…"
          testId="schema-state"
        >
          {(text) => <SchemaView text={text} />}
        </ResourceView>
      </Card>
    </div>
  );
}
