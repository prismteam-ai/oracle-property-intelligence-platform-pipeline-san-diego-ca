import { webcrypto } from 'node:crypto';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentUnavailableError, askAgent } from '../lib/api';
import { McpError } from '../lib/mcp';
import type { AgentResponse, LeadRow, Manifest, PipelineRuns, Property } from '../lib/schemas';
import { clearResourceCache } from '../lib/useResource';
import { SQL_EXAMPLES } from '../lib/sqlExamples';
import AgentPanel, { retrievedCount } from './AgentPanel';
import Artifacts, { ManifestView, PublicationHistory, RECORDED_PROBES } from './Artifacts';
import ExploreMap, {
  OUT_OF_AREA_NOTE,
  PropertyDetail,
  ResultsBody,
  leadArgs,
  transferBaseSentence,
  yearsBetween,
} from './ExploreMap';
import { lastRunForSource, permitTotals } from './Records';
import { QueryConsole, parseSchema, refusal } from './QueryLayer';
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

describe('query time limit', () => {
  it('offers the runaway example and labels a stopped query as a time limit, not a refusal', async () => {
    const runQuery = vi
      .fn()
      .mockRejectedValue(
        new McpError('tool_error', 'Query stopped after 15 seconds: it ran past the time limit.'),
      );
    render(<QueryConsole runQuery={runQuery} />);
    expect(screen.getByTestId('sql-example-timeout')).toHaveTextContent('15 s');
    await userEvent.click(screen.getByTestId('sql-example-timeout'));
    expect(String(runQuery.mock.calls[0]?.[0])).toContain(
      'SELECT count(*) FROM parcel a, parcel b, parcel c',
    );
    expect(await screen.findByTestId('sql-rejected-kind')).toHaveTextContent(
      'The time limit stopped this query.',
    );
    expect(screen.getByTestId('sql-rejected-message')).toHaveTextContent(
      'Query stopped after 15 seconds',
    );
  });

  it('tells a guard refusal, a time limit and an engine error apart', () => {
    expect(refusal('Query rejected: Only SELECT is allowed.').headline).toMatch(/guard refused/);
    expect(refusal('Query stopped after 15 seconds').headline).toMatch(/time limit/);
    expect(refusal('Query failed: Binder Error').headline).toMatch(/could not run/);
  });
});

describe('Explore map filters', () => {
  const search = {
    center: { lat: 32.7157, lon: -117.1611 },
    radiusMiles: 2,
    minAge: 15,
    minYearsHeld: 12,
  };
  const row: LeadRow = {
    apn: '5335220400',
    address: '428 C ST',
    city: 'SAN DIEGO',
    zip: '92101',
    lat: 32.71699,
    lon: -117.16064,
    distanceMiles: 0.093,
    roofYear: 1941,
    roofAgeYears: 85,
    roofBasis: 'year_built',
    roofConfidence: 'medium',
    openRoofPermits: 0,
    longestOpenDays: null,
    topOpenPermitId: null,
    topOpenContractor: null,
    topOpenLicenseNo: null,
    ownerOccupied: false,
    lastTransferDate: '1998-03-13',
    useType: null,
  };
  const data = {
    total: 1018,
    agedRoofCount: 893,
    openPermitCount: 0,
    asOf: '2026-11-25',
    coverageNote: null,
    rows: [row],
  };

  it('sends the new parameters for the ownership and out-of-area tabs', () => {
    expect(leadArgs('ownership', search)).toMatchObject({
      signal: 'any',
      minYearsSinceTransfer: 12,
    });
    expect(leadArgs('ownership', search)).not.toHaveProperty('ownerOccupied');
    expect(leadArgs('outOfArea', search)).toMatchObject({ signal: 'any', ownerOccupied: 'no' });
    expect(leadArgs('outOfArea', search)).not.toHaveProperty('minYearsSinceTransfer');
    expect(leadArgs('aged', search)).toMatchObject({ signal: 'aged_roof', minRoofAgeYears: 15 });
  });

  it('computes whole years since the last transfer', () => {
    expect(yearsBetween('1998-03-13', '2026-11-25')).toBe(28);
    expect(yearsBetween('2016-11-26', '2026-11-25')).toBe(9);
    expect(yearsBetween(null, '2026-11-25')).toBeNull();
  });

  it('shows years unchanged on the ownership tab', () => {
    render(
      <ResultsBody
        tab="ownership"
        data={data}
        search={search}
        expanded={null}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId('results-total')).toHaveTextContent(
      '1,018 properties with no recorded transfer for 12+ years',
    );
    expect(screen.getByTestId('row-5335220400')).toHaveTextContent('28 yrs');
    expect(screen.getByTestId('row-5335220400')).toHaveTextContent('last transfer 1998-03-13');
  });

  it('states that out-of-area is a proxy', () => {
    render(
      <ResultsBody
        tab="outOfArea"
        data={data}
        search={search}
        expanded={null}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByTestId('out-of-area-note')).toHaveTextContent(OUT_OF_AREA_NOTE);
    expect(OUT_OF_AREA_NOTE).toMatch(/Proxy/);
    expect(OUT_OF_AREA_NOTE).toMatch(/No public source holds an owner mailing address/);
    expect(screen.getByTestId('row-5335220400')).toHaveTextContent('Not flagged owner-occupied');
  });

  it('shows pending permits distinctly from open and closed ones', () => {
    const permit = (permitId: string, isOpen: boolean): Property['permits'][number] => ({
      permitId,
      permitType: 'Residential Alteration',
      roofingClass: 'reroof',
      isRoofing: true,
      status: 'Open',
      isOpen,
      appliedDate: '2026-09-21',
      issuedDate: null,
      closedDate: null,
      daysOpen: isOpen ? 400 : null,
      description: null,
      contractor: null,
      provenance: {
        source: 'sdcounty_permits',
        sourceRecordId: permitId,
        sourceUrl: null,
        fetchedAt: null,
      },
    });
    const property: Property = {
      apn: '1024201900',
      address: '1 A ST',
      city: 'RAMONA',
      zip: '92065',
      lat: 33,
      lon: -116.9,
      yearBuilt: 1980,
      roofYear: 1980,
      roofAgeYears: 46,
      roofBasis: 'year_built',
      roofConfidence: 'medium',
      useType: null,
      ownerOccupied: true,
      ownerName: null,
      ownerMailing: null,
      lastTransferDate: null,
      yearsSinceTransfer: null,
      permits: [permit('P-PENDING', false), permit('P-OPEN', true), permit('P-DONE', false)],
      provenance: {
        source: 'sandag_parcels',
        sourceRecordId: '1',
        sourceUrl: null,
        fetchedAt: null,
      },
    };
    render(
      <PropertyDetail
        property={property}
        statusGroups={
          new Map([
            ['P-PENDING|sdcounty_permits', 'pending'],
            ['P-OPEN|sdcounty_permits', 'open'],
            ['P-DONE|sdcounty_permits', 'completed'],
          ])
        }
      />,
    );
    expect(screen.getByTestId('permit-counts')).toHaveTextContent('1 open, 1 pending, 1 closed');
    const pending = screen.getByTestId('permit-P-PENDING');
    expect(pending).toHaveAttribute('data-permit-state', 'pending');
    expect(pending).toHaveTextContent('Pending: applied, not issued');
    expect(pending).toHaveTextContent('Not counted as an open permit');
    expect(screen.getByTestId('permit-P-OPEN')).toHaveAttribute('data-permit-state', 'open');
    expect(screen.getByTestId('permit-P-DONE')).toHaveTextContent('Completed');
  });
});

describe('Explore map form', () => {
  const lead = (apn: string, address: string, unit?: string): LeadRow => ({
    apn,
    address,
    unit,
    city: 'SAN DIEGO',
    zip: '92101',
    lat: 32.71,
    lon: -117.16,
    distanceMiles: 0.1,
    roofYear: 1970,
    roofAgeYears: 56,
    roofBasis: 'year_built',
    roofConfidence: 'medium',
    openRoofPermits: 0,
    longestOpenDays: null,
    topOpenPermitId: null,
    topOpenContractor: null,
    topOpenLicenseNo: null,
    ownerOccupied: false,
    lastTransferDate: '1998-03-13',
    useType: null,
  });

  const stubApi = (): ReturnType<typeof vi.fn<typeof fetch>> => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const params = (
        JSON.parse(String(init?.body)) as {
          params: { name: string; arguments: { center?: { lat: number } } };
        }
      ).params;
      if (params.name === 'findRoofingLeads') {
        const elCajon = params.arguments.center?.lat === 32.7948;
        return rpcResponse({
          content: [],
          structuredContent: {
            total: 2,
            agedRoofCount: 2,
            openPermitCount: 0,
            asOf: '2026-11-25',
            rows: elCajon
              ? [lead('4880000100', '100 E MAIN ST')]
              : [
                  lead('5335000101', '700 FRONT ST', '4B'),
                  lead('5335000102', '700 FRONT ST', '4C'),
                ],
          },
        });
      }
      return rpcResponse({ content: [{ type: 'text', text: 'null' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('shows the unit in the address and the APN on every row', async () => {
    stubApi();
    render(<ExploreMap />);
    expect(await screen.findByTestId('row-5335000101')).toHaveTextContent('700 FRONT ST, Unit 4B');
    expect(screen.getByTestId('row-5335000102')).toHaveTextContent('700 FRONT ST, Unit 4C');
    expect(screen.getByTestId('apn-5335000101')).toHaveTextContent('APN 5335000101');
    expect(screen.getByTestId('apn-5335000102')).toHaveTextContent('APN 5335000102');
  });

  it('clears old rows on invalid input, and a jump clears the error and searches again', async () => {
    const fetchMock = stubApi();
    render(<ExploreMap />);
    await screen.findByTestId('row-5335000101');

    await userEvent.clear(screen.getByTestId('input-lat'));
    await userEvent.type(screen.getByTestId('input-lat'), '99');
    await userEvent.click(screen.getByTestId('search-submit'));
    expect(screen.getByTestId('search-form-error')).toHaveTextContent('outside San Diego County');
    expect(screen.getByTestId('search-form-error')).toHaveTextContent('Nothing was searched.');
    expect(screen.getByTestId('results-stale')).toBeInTheDocument();
    expect(screen.queryByTestId('row-5335000101')).not.toBeInTheDocument();
    expect(screen.queryByTestId('results-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('explore-map')).toHaveAttribute('data-point-count', '0');

    await userEvent.click(screen.getByTestId('place-el-cajon'));
    expect(screen.queryByTestId('search-form-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('input-lat')).toHaveValue('32.7948');
    expect(screen.getByTestId('input-lon')).toHaveValue('-116.9625');
    expect(await screen.findByTestId('row-4880000100')).toHaveTextContent('100 E MAIN ST');
    expect(screen.queryByTestId('results-stale')).not.toBeInTheDocument();
    const centers = fetchMock.mock.calls
      .map(
        (c) =>
          JSON.parse(String(c[1]?.body)) as {
            params: { name: string; arguments: { center?: { lat: number } } };
          },
      )
      .filter((b) => b.params.name === 'findRoofingLeads')
      .map((b) => b.params.arguments.center?.lat);
    expect(centers).not.toContain(99);
    expect(centers.at(-1)).toBe(32.7948);
  });

  it('a jump also recovers from a bad radius by using the last good one', async () => {
    stubApi();
    render(<ExploreMap />);
    await screen.findByTestId('row-5335000101');
    await userEvent.clear(screen.getByTestId('input-radius'));
    await userEvent.click(screen.getByTestId('search-submit'));
    expect(screen.getByTestId('search-form-error')).toHaveTextContent('Radius must be');
    await userEvent.click(screen.getByTestId('place-el-cajon'));
    expect(screen.queryByTestId('search-form-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('input-radius')).toHaveValue(1);
    expect(await screen.findByTestId('row-4880000100')).toBeInTheDocument();
  });

  it('states the usable base of the ownership filter from live numbers', () => {
    expect(transferBaseSentence(93286, 1087462)).toBe(
      'This filter can use 93,286 of 1,087,462 parcels (8.6%): the rest have a transfer date whose century is uncertain, or none at all.',
    );
  });
});

describe('agent row counts', () => {
  it('says "showing X of Y retrieved" when the tools found more rows than were returned', async () => {
    const ask = vi.fn().mockResolvedValue({
      answer: 'Many.',
      assumptions: [],
      evidence: [{ tool: 'findRoofingLeads', sql: null, rowCount: 204, note: null }],
      rows: [{ apn: '1' }, { apn: '2' }],
      points: [],
      model: 'm',
      elapsedMs: 1,
    });
    render(<AgentPanel ask={ask} />);
    await userEvent.click(screen.getByTestId('agent-example-open-permits'));
    expect(await screen.findByTestId('agent-rows-count')).toHaveTextContent(
      'Rows: showing 2 of 204 retrieved',
    );
  });

  it('shows a plain count when nothing was left out', () => {
    expect(
      retrievedCount({
        answer: '',
        assumptions: [],
        evidence: [{ tool: 't', rowCount: 2 }],
        rows: [{ a: 1 }, { a: 2 }],
        points: [],
      }),
    ).toBe(2);
  });
});

describe('SQL examples', () => {
  it('reads at a glance: one row per long-open permit with a named or "(none listed)" contractor', () => {
    const longOpen = SQL_EXAMPLES.find((e) => e.id === 'long-open-permits')?.sql ?? '';
    expect(longOpen).toMatch(/is_roofing AND is_open/);
    expect(longOpen).toMatch(/GROUP BY address, open_since/);
    expect(longOpen).toMatch(/'\(none listed\)'/);
    expect(longOpen).toMatch(/ORDER BY days_open DESC/);
    expect(SQL_EXAMPLES.filter((e) => !e.forbidden && !e.slow)).toHaveLength(5);
  });
});

describe('permit totals and publication status', () => {
  it('uses the one-row-per-permit count and derives the duplicate listings', () => {
    expect(
      permitTotals([
        { table: 'permit', rows: 1756884 },
        { table: 'permit (one row per permit, published)', rows: 1726127 },
      ]),
    ).toEqual({ permits: 1726127, sourceRows: 1756884, duplicates: 30757 });
    expect(permitTotals([{ table: 'permit', rows: 10 }])).toEqual({
      permits: 10,
      sourceRows: 10,
      duplicates: null,
    });
  });

  it('says how many gateways verified a publish, and "not yet verified" for zero', () => {
    render(
      <PublicationHistory
        manifest={null}
        publications={[
          { runId: 6, createdAt: '2026-11-25T17:39:55Z', rootCid: 'bafyone', verifiedGateways: 5 },
          { runId: 3, createdAt: '2026-11-25T16:58:03Z', rootCid: 'bafytwo', verifiedGateways: 0 },
        ]}
      />,
    );
    const rows = within(screen.getByTestId('publication-history')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('verified on 5 public gateways when published');
    expect(rows[1]).toHaveTextContent('not yet verified on public gateways');
    expect(rows[1]).not.toHaveTextContent('0 gateways');
  });
});

describe('lastRunForSource', () => {
  const runs: PipelineRuns = {
    runs: [
      {
        run_id: 5,
        started_at: '2026-11-25 17:20:00',
        finished_at: '2026-11-25 17:25:00',
        status: 'ok',
      },
      {
        run_id: 6,
        started_at: '2026-11-25 17:29:00',
        finished_at: '2026-11-25 17:36:00',
        status: 'ok',
      },
    ],
    stats: [
      {
        run_id: 5,
        source_id: 'carlsbad_permits',
        entity: 'permit',
        fetched: 9886,
        rejected: 0,
        inserted: 9886,
        updated: 0,
        unchanged: 0,
      },
      {
        run_id: 6,
        source_id: 'carlsbad_permits',
        entity: 'permit',
        fetched: 0,
        rejected: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
      },
      {
        run_id: 6,
        source_id: 'sdcity_permits',
        entity: 'permit',
        fetched: 1272476,
        rejected: 0,
        inserted: 0,
        updated: 0,
        unchanged: 1272476,
      },
    ],
  };

  it('finds the last run that fetched rows from the source, in UTC from the run history', () => {
    expect(lastRunForSource(9886, runs)).toEqual({ runId: 5, finishedAt: '2026-11-25 17:25:00' });
    expect(lastRunForSource(1272476, runs)).toEqual({
      runId: 6,
      finishedAt: '2026-11-25 17:36:00',
    });
  });

  it('returns null rather than guess when nothing matches', () => {
    expect(lastRunForSource(42, runs)).toBeNull();
    expect(lastRunForSource(null, runs)).toBeNull();
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
    expect(row.getByRole('link', { name: 'gateway.pinata.cloud' })).toHaveAttribute(
      'href',
      `https://gateway.pinata.cloud/ipfs/${manifest.rootCid}/coverage.json`,
    );
    expect(row.getByRole('link', { name: 'ipfs.hypha.coop' })).toHaveAttribute(
      'href',
      `https://ipfs.hypha.coop/ipfs/${manifest.rootCid}/coverage.json`,
    );
    expect(row.queryByRole('link', { name: /ipfs\.io|dweb\.link|4everland|storry/ })).toBeNull();
  });

  it('keeps the full check of a large object behind an explicit button with a size warning', () => {
    render(<ManifestView manifest={manifest} />);
    expect(screen.queryByTestId('verify-query-table-parquet')).not.toBeInTheDocument();
    expect(screen.getByTestId('large-warning-query-table-parquet')).toHaveTextContent('64.0 MB');
    expect(screen.getByTestId('verify-full-query-table-parquet')).toHaveTextContent(
      'Download and verify in full',
    );
  });

  it('verifies an object per gateway: match, mismatch, HTTP error and CORS failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (/latam\.orbitor|pinata|filebase/.test(url)) return new Response(small);
      if (url.includes('raribleuserdata')) return new Response('tampered');
      if (init?.mode === 'no-cors') return new Response(null);
      throw new TypeError('Failed to fetch');
    });
    render(<ManifestView manifest={manifest} deps={{ fetchImpl, digest }} />);
    await userEvent.click(screen.getByTestId('verify-coverage-json'));

    const outcome = async (gateway: string): Promise<string | null> =>
      (await screen.findByTestId(`verify-result-coverage-json-${gateway}`)).getAttribute(
        'data-outcome',
      );
    expect(await outcome('latam.orbitor.dev')).toBe('match');
    expect(await outcome('gateway.pinata.cloud')).toBe('match');
    expect(await outcome('ipfs.filebase.io')).toBe('match');
    expect(await outcome('ipfs.raribleuserdata.com')).toBe('mismatch');
    expect(await outcome('ipfs.hypha.coop')).toBe('cors_blocked');
    expect(screen.getByTestId('verify-result-coverage-json-ipfs.hypha.coop')).toHaveTextContent(
      'Blocked by CORS',
    );
    expect(
      screen.getByTestId('verify-result-coverage-json-gateway.pinata.cloud-kind'),
    ).toHaveTextContent('Pinning-vendor public gateway');
    expect(screen.getByTestId('verify-result-coverage-json-summary')).toHaveTextContent(
      'Verified: bytes match the manifest on 3 public gateways (1 independent, 2 pinning-vendor).',
    );
  });

  it('never fetches from the gateways outside the automatic check', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(small));
    render(<ManifestView manifest={manifest} deps={{ fetchImpl, digest }} />);
    await userEvent.click(screen.getByTestId('verify-coverage-json'));
    await waitFor(() =>
      expect(screen.getByTestId('verify-result-coverage-json-summary')).toHaveTextContent(
        'Verified: bytes match the manifest on 5 public gateways (3 independent, 2 pinning-vendor).',
      ),
    );
    const hosts = fetchImpl.mock.calls.map((c) => new URL(String(c[0])).host);
    expect(hosts).toHaveLength(5);
    expect(hosts.join(' ')).not.toMatch(/ipfs\.io|dweb\.link|4everland|storry/);
  });

  it('prints the verdict as soon as two gateways match, while a slow one is still pending', async () => {
    let releaseSlow: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('ipfs.hypha.coop')) {
        return new Promise<Response>((resolve) => {
          releaseSlow = resolve;
        });
      }
      if (/latam\.orbitor|filebase/.test(url)) return new Response(small);
      return new Response('gone', { status: 504 });
    });
    render(<ManifestView manifest={manifest} deps={{ fetchImpl, digest }} />);
    await userEvent.click(screen.getByTestId('verify-coverage-json'));

    await waitFor(() =>
      expect(screen.getByTestId('verify-result-coverage-json-summary')).toHaveTextContent(
        'Verified: bytes match the manifest on 2 public gateways (1 independent, 1 pinning-vendor). Still waiting on 1 slower gateway.',
      ),
    );
    expect(screen.getByTestId('verify-result-coverage-json')).toHaveAttribute(
      'data-complete',
      'false',
    );
    expect(screen.getByTestId('verify-result-coverage-json-ipfs.hypha.coop')).toHaveAttribute(
      'data-outcome',
      'pending',
    );

    releaseSlow(new Response(small));
    await waitFor(() =>
      expect(screen.getByTestId('verify-result-coverage-json-summary')).toHaveTextContent(
        /^Verified: bytes match the manifest on 3 public gateways \(2 independent, 1 pinning-vendor\)\.$/,
      ),
    );
    expect(screen.getByTestId('verify-result-coverage-json')).toHaveAttribute(
      'data-complete',
      'true',
    );
  });

  it('does not claim verification when fewer than two gateways match', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    render(<ManifestView manifest={manifest} deps={{ fetchImpl, digest }} />);
    await userEvent.click(screen.getByTestId('verify-coverage-json'));
    expect(await screen.findByTestId('verify-result-coverage-json-summary')).toHaveTextContent(
      'Not verified: bytes match the manifest on only 0 of 5 gateways tried',
    );
  });

  it('shows both runs newest first and checks the earlier root against the recorded digest', async () => {
    const run3Root = 'bafybeid7p55asvoy3r24wgrqny74akxdnts6kbne2b2k3thbz66ywo46wy';
    const recorded = RECORDED_PROBES[run3Root];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(small));
    // The fake bytes are not the real run-3 object, so pretend their digest is the recorded one.
    const recordedDigest = async (): Promise<string> => recorded?.sha256 ?? '';
    render(
      <PublicationHistory
        manifest={manifest}
        deps={{ fetchImpl, digest: recordedDigest }}
        publications={[
          {
            runId: 3,
            createdAt: '2026-11-25T16:58:03.918Z',
            rootCid: run3Root,
            manifestCid: null,
            previousRootCid: null,
            bytes: 171459921,
          },
          {
            runId: 6,
            createdAt: '2026-11-25T17:39:55.679Z',
            rootCid: manifest.rootCid,
            manifestCid: 'bafkreimanifest',
            previousRootCid: run3Root,
            bytes: 172379311,
          },
        ]}
      />,
    );
    expect(screen.getByTestId('publication-summary')).toHaveTextContent(
      '2 publishes, 2 distinct root CIDs',
    );
    const rows = within(screen.getByTestId('publication-history')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Run 6');
    expect(rows[0]).toHaveTextContent('Served now');
    expect(rows[0]).toHaveTextContent('bafkreimanifest');
    expect(rows[0]).toHaveTextContent('164 MB');
    expect(rows[1]).toHaveTextContent('Run 3');

    await userEvent.click(
      screen.getByRole('button', { name: 'Check the earlier CID still resolves' }),
    );
    expect(await screen.findByTestId('resolve-basis-3')).toHaveTextContent(
      'publications/san-diego/run-0003/manifest.json',
    );
    expect(screen.getByTestId('resolve-basis-3')).toHaveTextContent(
      '475574b1c11d004dbe7f242161faf2720d981b32f420232d2e8e3ba218fe7567',
    );
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `https://latam.orbitor.dev/ipfs/${run3Root}/coverage.json`,
    );
    // Sizes differ from the recorded 3,115 bytes, so this must not be reported as a pass.
    expect(screen.getByTestId('resolve-result-3-summary')).toHaveTextContent('Not verified');
    expect(screen.getByTestId('resolve-result-3-latam.orbitor.dev')).toHaveAttribute(
      'data-outcome',
      'mismatch',
    );
  });

  it('reports reachability only when no digest is recorded for an older root', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(small));
    render(
      <PublicationHistory
        manifest={manifest}
        deps={{ fetchImpl, digest }}
        publications={[
          {
            runId: 2,
            createdAt: '2026-11-25T16:40:00.000Z',
            rootCid: 'bafybeiunknownolder',
            previousRootCid: null,
          },
          {
            runId: 3,
            createdAt: '2026-11-25T17:00:00.000Z',
            rootCid: manifest.rootCid,
            previousRootCid: 'bafybeiunknownolder',
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByTestId('check-resolves-2'));
    expect(await screen.findByTestId('resolve-result-2-summary')).toHaveTextContent(
      'Resolves on 5 public gateways (3 independent, 2 pinning-vendor); no recorded digest',
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
    expect(screen.getByTestId('gateway-list')).toHaveTextContent('ipfs.hypha.coop');
    expect(screen.getByTestId('other-gateway-ipfs.io')).toHaveTextContent(
      'interactive browsers only; scripts get HTTP 429',
    );
    expect(screen.getByTestId('other-gateway-storry.tv')).toHaveTextContent(
      'did not find this content when last checked',
    );
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
