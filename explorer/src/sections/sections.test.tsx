import { webcrypto } from 'node:crypto';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentUnavailableError, askAgent } from '../lib/api';
import { McpError } from '../lib/mcp';
import type { AgentResponse, Manifest, PipelineRuns } from '../lib/schemas';
import { clearResourceCache } from '../lib/useResource';
import AgentPanel from './AgentPanel';
import Artifacts, { ManifestView, PublicationHistory } from './Artifacts';
import { QueryConsole, parseSchema } from './QueryLayer';
import { RunHistory } from './RunSummary';

vi.mock('../components/MapView', () => ({
  default: ({ points, testId }: { points: readonly unknown[]; testId: string }) => (
    <div data-testid={testId} data-point-count={points.length} />
  ),
}));

const digest = async (bytes: Uint8Array): Promise<string> =>
  Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');

const rpcResponse = (result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => clearResourceCache());

describe('RunHistory', () => {
  const data: PipelineRuns = {
    runs: [
      {
        run_id: 1,
        started_at: '2026-11-25 16:15:43.184',
        finished_at: '2026-11-25 16:22:22.805',
        window_from: null,
        window_to: '2026-11-15',
        status: 'ok',
        forced: false,
      },
      {
        run_id: 2,
        started_at: '2026-11-25 16:22:28.144',
        finished_at: '2026-11-25 16:22:45.502',
        window_from: '2026-11-10',
        window_to: null,
        status: 'ok',
        forced: false,
      },
    ],
    stats: [
      {
        run_id: 1,
        source_id: 'sdcity_permits',
        entity: 'permit',
        fetched: 1272476,
        rejected: 92,
        inserted: 1272384,
        updated: 0,
        unchanged: 0,
      },
      {
        run_id: 2,
        source_id: 'sdcity_permits',
        entity: 'permit',
        fetched: 5210,
        rejected: 0,
        inserted: 14,
        updated: 320,
        unchanged: 4876,
        notes: 'ETag changed',
      },
    ],
  };

  it('lists runs newest first with window, duration and per-source deltas', () => {
    render(<RunHistory data={data} />);
    const runs = screen.getAllByRole('article');
    expect(runs.map((r) => r.getAttribute('data-testid'))).toEqual(['run-2', 'run-1']);

    const run2 = within(screen.getByTestId('run-2'));
    expect(run2.getByText('Incremental')).toBeInTheDocument();
    expect(run2.getByText('2026-11-10 → latest record')).toBeInTheDocument();
    expect(run2.getByText('17 s')).toBeInTheDocument();
    const cells = within(screen.getByTestId('run-2-sdcity_permits-permit'))
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells).toEqual([
      'sdcity_permits',
      'permit',
      '5,210',
      '14',
      '320',
      '4,876',
      '0',
      'ETag changed',
    ]);

    const run1 = within(screen.getByTestId('run-1'));
    expect(run1.getByText('Full load')).toBeInTheDocument();
    expect(run1.getByText('6 min 40 s')).toBeInTheDocument();
  });

  it('says so when there are no runs', () => {
    render(<RunHistory data={{ runs: [], stats: [] }} />);
    expect(screen.getByTestId('run-history-empty')).toBeInTheDocument();
  });
});

describe('QueryConsole', () => {
  it('shows the guard refusal word for word when a non-SELECT is tried', async () => {
    const runQuery = vi
      .fn()
      .mockRejectedValue(
        new McpError('tool_error', 'Query rejected: Only SELECT (or WITH ... SELECT) is allowed.'),
      );
    render(<QueryConsole runQuery={runQuery} />);
    await userEvent.click(screen.getByTestId('sql-example-forbidden'));
    expect(runQuery).toHaveBeenCalledWith('DELETE FROM permit WHERE is_open');
    expect(await screen.findByTestId('sql-rejected-message')).toHaveTextContent(
      'Query rejected: Only SELECT (or WITH ... SELECT) is allowed.',
    );
    expect(screen.getByTestId('sql-rejected')).toHaveTextContent('Nothing was executed');
  });

  it('shows rows, the row count and the truncation flag', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      columns: ['apn', 'roof_age_years'],
      rows: [{ apn: '5335231400', roof_age_years: 56 }],
      rowCount: 1,
      truncated: true,
    });
    render(<QueryConsole runQuery={runQuery} />);
    await userEvent.click(screen.getByTestId('sql-run'));
    expect(await screen.findByTestId('sql-row-count')).toHaveTextContent('1 rows');
    expect(screen.getByTestId('sql-truncated')).toHaveTextContent('Truncated');
    expect(within(screen.getByTestId('sql-results')).getByText('5335231400')).toBeInTheDocument();
  });

  it('shows other failures as errors, not as guard refusals', async () => {
    const runQuery = vi.fn().mockRejectedValue(new McpError('network', 'Could not reach the API.'));
    render(<QueryConsole runQuery={runQuery} />);
    await userEvent.click(screen.getByTestId('sql-run'));
    expect(await screen.findByTestId('sql-error')).toHaveTextContent('Could not reach the API.');
    expect(screen.queryByTestId('sql-rejected')).not.toBeInTheDocument();
  });
});

describe('parseSchema', () => {
  it('splits relations, columns and notes', () => {
    const parsed = parseSchema(
      'place(name VARCHAR, lat DOUBLE)\n  -- Gazetteer (city | zip).\n\nDistance in miles: 3958 * asin(x).',
    );
    expect(parsed.relations).toEqual([
      {
        name: 'place',
        columns: [
          { name: 'name', type: 'VARCHAR' },
          { name: 'lat', type: 'DOUBLE' },
        ],
        note: 'Gazetteer (city | zip).',
      },
    ]);
    expect(parsed.notes).toEqual(['Distance in miles: 3958 * asin(x).']);
  });
});

describe('Artifacts', () => {
  const small = new TextEncoder().encode('{"runId":3}');
  let manifest: Manifest;

  beforeEach(async () => {
    manifest = {
      runId: 3,
      createdAt: '2026-11-25T17:00:00.000Z',
      rootCid: 'bafybeirootrootrootrootrootrootroot',
      previousRootCid: 'bafybeioldoldoldoldoldoldoldoldold',
      objects: [
        {
          name: '',
          cid: 'bafybeirootrootrootrootrootrootroot',
          size: 90000000,
          codec: 'directory',
          sha256: null,
        },
        {
          name: 'coverage.json',
          cid: 'bafkcoverage',
          size: small.length,
          codec: 'file',
          sha256: await digest(small),
        },
        {
          name: 'query-table.parquet',
          cid: 'bafkquery',
          size: 64 * 1024 * 1024,
          codec: 'file',
          sha256: 'ab'.repeat(32),
        },
      ],
      car: {
        name: 'run-0003.car',
        size: 90001234,
        sha256: 'cd'.repeat(32),
        rootCid: 'bafybeirootrootrootrootrootrootroot',
      },
      pins: [
        {
          provider: 'filebase',
          cid: 'bafybeirootrootrootrootrootrootroot',
          ok: true,
          detail: 'root matches',
        },
      ],
    };
  });

  it('lists every object with CID, size, codec, digest and CID-derived gateway links', () => {
    render(<ManifestView manifest={manifest} />);
    expect(screen.getByTestId('manifest-root-cid')).toHaveTextContent(manifest.rootCid);
    expect(screen.getByTestId('manifest-previous-root')).toHaveTextContent('bafybeiold');
    expect(screen.getByTestId('manifest-car')).toHaveTextContent('run-0003.car');
    expect(screen.getByTestId('manifest-pins')).toHaveTextContent('filebase');

    const row = within(screen.getByTestId('object-coverage-json'));
    expect(row.getByTestId('cid-coverage-json')).toHaveTextContent('bafkcoverage');
    expect(row.getByTestId('sha-coverage-json')).toHaveTextContent(/^[0-9a-f]{64}$/);
    expect(row.getByText('file')).toBeInTheDocument();
    expect(row.getByRole('link', { name: '4everland.io' })).toHaveAttribute(
      'href',
      `https://4everland.io/ipfs/${manifest.rootCid}/coverage.json`,
    );
    expect(row.getByRole('link', { name: 'Open in ipfs.io' })).toHaveAttribute(
      'href',
      `https://ipfs.io/ipfs/${manifest.rootCid}/coverage.json`,
    );
  });

  it('keeps the full check of a large object behind an explicit button with a size warning', () => {
    render(<ManifestView manifest={manifest} />);
    expect(screen.queryByTestId('verify-query-table-parquet')).not.toBeInTheDocument();
    expect(screen.getByTestId('large-warning-query-table-parquet')).toHaveTextContent('64.0 MB');
    expect(screen.getByTestId('verify-full-query-table-parquet')).toHaveTextContent(
      'Download and verify in full',
    );
  });

  it('verifies an object per gateway: match, mismatch, HTTP 429 and CORS failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('4everland.io') || url.includes('storry.tv')) return new Response(small);
      if (url.includes('latam.orbitor.dev')) return new Response('tampered');
      if (url.includes('dweb.link')) return new Response('slow down', { status: 429 });
      if (init?.mode === 'no-cors') return new Response(null);
      throw new TypeError('Failed to fetch');
    });
    render(<ManifestView manifest={manifest} deps={{ fetchImpl, digest }} />);
    await userEvent.click(screen.getByTestId('verify-coverage-json'));

    const outcome = async (gateway: string): Promise<string | null> =>
      (await screen.findByTestId(`verify-result-coverage-json-${gateway}`)).getAttribute(
        'data-outcome',
      );
    expect(await outcome('4everland.io')).toBe('match');
    expect(await outcome('storry.tv')).toBe('match');
    expect(await outcome('latam.orbitor.dev')).toBe('mismatch');
    expect(await outcome('dweb.link')).toBe('http_error');
    expect(await outcome('ipfs.io')).toBe('cors_blocked');
    expect(screen.getByTestId('verify-result-coverage-json-ipfs.io')).toHaveTextContent(
      'Blocked by CORS',
    );
    expect(screen.getByTestId('verify-result-coverage-json-summary')).toHaveTextContent(
      'Verified: 2 independent public gateways',
    );
  });

  it('does not claim verification when fewer than two gateways match', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    render(<ManifestView manifest={manifest} deps={{ fetchImpl, digest }} />);
    await userEvent.click(screen.getByTestId('verify-coverage-json'));
    expect(await screen.findByTestId('verify-result-coverage-json-summary')).toHaveTextContent(
      'Not verified: only 0 of 5',
    );
  });

  it('shows the publication chain and checks that an older root still resolves', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(small));
    render(
      <PublicationHistory
        manifest={manifest}
        deps={{ fetchImpl, digest }}
        publications={[
          {
            runId: 2,
            createdAt: '2026-11-25T16:40:00.000Z',
            rootCid: 'bafybeioldoldoldoldoldoldoldoldold',
            previousRootCid: null,
          },
          {
            runId: 3,
            createdAt: '2026-11-25T17:00:00.000Z',
            rootCid: manifest.rootCid,
            previousRootCid: 'bafybeioldoldoldoldoldoldoldoldold',
          },
        ]}
      />,
    );
    expect(screen.getByTestId('publication-summary')).toHaveTextContent(
      '2 publishes, 2 distinct root CIDs',
    );
    await userEvent.click(screen.getByTestId('check-resolves-2'));
    expect(await screen.findByTestId('resolve-result-2-summary')).toHaveTextContent(
      'Resolves: 5 independent public gateways still serve this CID.',
    );
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      '/ipfs/bafybeioldoldoldoldoldoldoldoldold/coverage.json',
    );
  });

  it('handles "not published yet" and a history tool that does not exist yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_url, init) => {
        const name = (JSON.parse(String(init?.body)) as { params: { name: string } }).params.name;
        return rpcResponse({
          isError: true,
          content: [
            {
              type: 'text',
              text:
                name === 'getArtifactManifest'
                  ? 'No manifest is present for this run: the artifacts have not been published yet.'
                  : 'MCP error -32602: Tool getPublicationHistory not found',
            },
          ],
        });
      }),
    );
    render(<Artifacts />);
    expect(await screen.findByTestId('manifest-unpublished')).toHaveTextContent(
      'have not been published yet',
    );
    expect(await screen.findByTestId('publications-unavailable')).toHaveTextContent(
      'not deployed on this API yet',
    );
    expect(screen.getByTestId('gateway-list')).toHaveTextContent('ipfs.io');
  });
});

describe('AgentPanel', () => {
  const response: AgentResponse = {
    answer: 'There are 2 matching properties.',
    assumptions: ['Roof age is a proxy from the assessor year.'],
    evidence: [
      { tool: 'queryAtlas', sql: 'SELECT apn FROM parcel', rowCount: 2, note: 'radius filter' },
    ],
    rows: [
      { apn: '1', address: '525 B ST', roof_age_years: 56 },
      { apn: '2', address: '629 J ST', roof_age_years: 31 },
    ],
    points: [
      { apn: '1', lat: 32.71, lon: -117.16, label: '525 B ST' },
      { apn: '2', lat: 32.7, lon: -117.15, label: '629 J ST' },
    ],
    model: 'test-model',
    elapsedMs: 4200,
  };

  it('starts idle, then shows a loading state while the agent works', async () => {
    const ask = vi.fn(() => new Promise<AgentResponse>(() => undefined));
    render(<AgentPanel ask={ask} />);
    expect(screen.getByTestId('agent-idle')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('agent-example-aged-roofs'));
    expect(screen.getByTestId('agent-loading')).toBeInTheDocument();
    expect(screen.getByTestId('agent-ask')).toBeDisabled();
  });

  it('sends the demo prompt with the picked place and shows answer, assumptions, evidence, rows and map', async () => {
    const ask = vi.fn().mockResolvedValue(response);
    render(<AgentPanel ask={ask} />);
    await userEvent.selectOptions(screen.getByTestId('agent-place'), 'la-jolla');
    await userEvent.click(screen.getByTestId('agent-example-aged-roofs'));
    expect(ask).toHaveBeenCalledWith({
      question:
        'Which properties in San Diego County within five miles of La Jolla have roofs older than 15 years?',
      center: { lat: 32.8328, lon: -117.2713 },
      radiusMiles: 5,
    });
    expect(await screen.findByTestId('agent-answer')).toHaveTextContent('2 matching properties');
    expect(screen.getByTestId('agent-assumptions')).toHaveTextContent('Roof age is a proxy');
    expect(screen.getByTestId('agent-evidence')).toHaveTextContent('queryAtlas');
    expect(screen.getByTestId('agent-evidence')).toHaveTextContent('SELECT apn FROM parcel');
    expect(within(screen.getByTestId('agent-rows')).getByText('525 B ST')).toBeInTheDocument();
    expect(screen.getByTestId('agent-meta')).toHaveTextContent('test-model · 4.2 s');
    expect(await screen.findByTestId('agent-map')).toHaveAttribute('data-point-count', '2');
  });

  it('says clearly when the agent endpoint is not available yet (404)', async () => {
    const ask = vi.fn().mockRejectedValue(new AgentUnavailableError());
    render(<AgentPanel ask={ask} />);
    await userEvent.click(screen.getByTestId('agent-example-open-permits'));
    expect(await screen.findByTestId('agent-unavailable')).toHaveTextContent(
      'The agent endpoint is not available yet.',
    );
  });

  it('shows other failures with a retry', async () => {
    const ask = vi.fn().mockRejectedValue(new Error('The agent answered HTTP 500: boom'));
    render(<AgentPanel ask={ask} />);
    await userEvent.type(screen.getByTestId('agent-question'), 'anything');
    await userEvent.click(screen.getByTestId('agent-ask'));
    expect(await screen.findByTestId('agent-error')).toHaveTextContent('HTTP 500: boom');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
  });
});

describe('askAgent', () => {
  it('maps 404 to AgentUnavailableError and parses a good answer', async () => {
    const notFound = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"error":"not found"}', { status: 404 }));
    await expect(askAgent({ question: 'q' }, { fetchImpl: notFound })).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
    const ok = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ answer: 'hi' })));
    await expect(askAgent({ question: 'q' }, { fetchImpl: ok })).resolves.toMatchObject({
      answer: 'hi',
      assumptions: [],
      evidence: [],
      rows: [],
      points: [],
    });
  });
});
