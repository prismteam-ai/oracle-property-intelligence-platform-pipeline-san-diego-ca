import { useId, useState } from 'react';
import { Card, CopyButton, ErrorNotice, Loading, ResourceView } from '../components/ui';
import { MCP_URL } from '../lib/config';
import { McpError, listTools, rpc, type ToolInfo } from '../lib/mcp';
import { useResource } from '../lib/useResource';

const DEFAULT_TOOL = 'getAtlasDatasetInfo';

export const curlExample = (url: string): string =>
  `curl -s -X POST ${url} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${DEFAULT_TOOL}","arguments":{}}}'`;

export const mcpJsonExample = (url: string): string =>
  JSON.stringify({ mcpServers: { 'oracle-san-diego': { type: 'http', url } } }, null, 2);

function Snippet({ title, code, testId }: { title: string; code: string; testId: string }) {
  return (
    <div className="snippet">
      <div className="row row-between">
        <h4>{title}</h4>
        <CopyButton value={code} testId={`copy-${testId}`} />
      </div>
      <pre className="code" data-testid={testId}>
        {code}
      </pre>
    </div>
  );
}

function Catalogue({ tools }: { tools: readonly ToolInfo[] }) {
  return (
    <ul className="tool-list" data-testid="tool-catalogue">
      {tools.map((tool) => (
        <li key={tool.name} className="tool" data-testid={`tool-${tool.name}`}>
          <div className="source-title">
            <strong>
              <code>{tool.name}</code>
            </strong>
            {tool.title ? <span className="muted">{tool.title}</span> : null}
            {tool.annotations?.readOnlyHint === true ? (
              <span className="badge badge-ok">read-only</span>
            ) : null}
          </div>
          <p>{tool.description ?? 'No description.'}</p>
          <details className="disclosure">
            <summary>Input schema</summary>
            <pre className="code">{JSON.stringify(tool.inputSchema ?? {}, null, 2)}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

type CallState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; json: string; ms: number; isError: boolean }
  | { status: 'error'; error: Error };

const MAX_SHOWN = 20_000;

function Tester({ tools }: { tools: readonly ToolInfo[] }) {
  const [tool, setTool] = useState(DEFAULT_TOOL);
  const [args, setArgs] = useState('{}');
  const [state, setState] = useState<CallState>({ status: 'idle' });
  const ids = useId();
  const names = tools.length > 0 ? tools.map((t) => t.name) : [DEFAULT_TOOL];

  const call = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.trim() === '' ? '{}' : args);
    } catch {
      setState({ status: 'error', error: new Error('The arguments are not valid JSON.') });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setState({ status: 'error', error: new Error('The arguments must be a JSON object.') });
      return;
    }
    setState({ status: 'running' });
    const started = performance.now();
    rpc('tools/call', { name: tool, arguments: parsed as Record<string, unknown> }).then(
      (result) => {
        const isError =
          typeof result === 'object' &&
          result !== null &&
          'isError' in result &&
          result.isError === true;
        setState({
          status: 'ok',
          json: JSON.stringify(result, null, 2),
          ms: Math.round(performance.now() - started),
          isError,
        });
      },
      (error: unknown) =>
        setState({
          status: 'error',
          error: error instanceof McpError ? error : new Error(String(error)),
        }),
    );
  };

  return (
    <form
      className="stack-tight"
      onSubmit={(event) => {
        event.preventDefault();
        call();
      }}
    >
      <div className="controls-row">
        <label className="field">
          <span className="field-label">Tool</span>
          <select data-testid="tester-tool" value={tool} onChange={(e) => setTool(e.target.value)}>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-grow" htmlFor={`${ids}-args`}>
          <span className="field-label">Arguments (JSON object)</span>
          <input
            id={`${ids}-args`}
            type="text"
            data-testid="tester-args"
            spellCheck={false}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="btn btn-primary"
          data-testid="tester-call"
          disabled={state.status === 'running'}
        >
          Call tool
        </button>
      </div>
      <div aria-live="polite">
        {state.status === 'idle' ? (
          <p className="empty-line">
            Calls <code>tools/call</code> on the live endpoint and shows the raw JSON-RPC result.
          </p>
        ) : null}
        {state.status === 'running' ? (
          <Loading label="Calling the tool…" testId="tester-loading" />
        ) : null}
        {state.status === 'error' ? (
          <ErrorNotice error={state.error} testId="tester-error" />
        ) : null}
        {state.status === 'ok' ? (
          <div className="stack-tight">
            <p className="result-meta">
              <span
                className={`badge ${state.isError ? 'badge-warn' : 'badge-ok'}`}
                data-testid="tester-status"
              >
                {state.isError ? 'Tool returned isError' : 'OK'}
              </span>
              <span className="muted">
                {state.ms} ms · {state.json.length.toLocaleString('en-US')} characters
              </span>
            </p>
            <pre className="code code-tall" data-testid="tester-result">
              {state.json.length > MAX_SHOWN
                ? `${state.json.slice(0, MAX_SHOWN)}\n… (${(state.json.length - MAX_SHOWN).toLocaleString('en-US')} more characters not shown)`
                : state.json}
            </pre>
          </div>
        ) : null}
      </div>
    </form>
  );
}

export default function McpSection() {
  const tools = useResource('tools', () => listTools());
  return (
    <div className="page" data-testid="section-mcp">
      <div className="page-head">
        <div>
          <h2>MCP</h2>
          <p className="muted">
            The Oracle’s only public interface is a Model Context Protocol server over stateless
            streamable HTTP. This page, the roofing CRM and any agent call the same tools, so there
            is one data contract.
          </p>
        </div>
      </div>

      <Card title="Endpoint" testId="card-endpoint">
        <p className="cid-row">
          <code className="hash" data-testid="mcp-url">
            {MCP_URL}
          </code>
          <CopyButton value={MCP_URL} label="Copy URL" testId="copy-mcp-url" />
        </p>
        <p className="muted small">
          No session, no key, read-only. Send JSON-RPC 2.0 by POST with the two headers shown in the
          curl example.
        </p>
        <div className="two-col">
          <Snippet title="curl" code={curlExample(MCP_URL)} testId="curl-example" />
          <Snippet
            title="mcp.json (client configuration)"
            code={mcpJsonExample(MCP_URL)}
            testId="mcp-json"
          />
        </div>
      </Card>

      <Card title="Call a tool" testId="card-tester">
        <Tester tools={tools.state.status === 'ok' ? tools.state.data : []} />
      </Card>

      <Card
        title="Tool catalogue (live tools/list)"
        testId="card-catalogue"
        aside={
          tools.state.status === 'ok' ? (
            <span className="muted" data-testid="tool-count">
              {tools.state.data.length} tools
            </span>
          ) : null
        }
      >
        <ResourceView
          state={tools.state}
          reload={tools.reload}
          label="Calling tools/list…"
          testId="tools"
        >
          {(data) => <Catalogue tools={data} />}
        </ResourceView>
      </Card>
    </div>
  );
}
