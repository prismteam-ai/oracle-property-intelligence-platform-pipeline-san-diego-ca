import { Card, Fact, ResourceView, SourceLink, StatusBadge } from '../components/ui';
import { getCoverage, getDatasetInfo, getPipelineRuns, queryAtlas } from '../lib/api';
import { COUNTY_NAME } from '../lib/config';
import { fmtDuration, fmtInt, fmtTimestamp } from '../lib/format';
import type { Coverage, DatasetInfo, PipelineRun, PipelineRuns, RunStat } from '../lib/schemas';
import { useResource } from '../lib/useResource';

/**
 * Licence / terms per source, copied from the pipeline's SOURCES.md. The serving API returns
 * each source's limits but not its licence line, so these are keyed on the source host.
 */
const LICENCES: readonly { match: string; licence: string }[] = [
  {
    match: 'geo.sandag.org',
    licence:
      'Public ArcGIS feature service, no login. Attribution: “SanGIS using legal recorded data provided by the County Recorders and Assessor’s Office”.',
  },
  {
    match: 'data.sandiegocounty.gov',
    licence:
      'County of San Diego open data portal. The datasets declare no licence in their metadata; published for public use without login.',
  },
  {
    match: 'data.sandiego.gov',
    licence:
      'City of San Diego Open Data Portal: Open Data Commons Public Domain Dedication and Licence (PDDL).',
  },
  {
    match: 'services.arcgis.com/ay9ePoQ2UfAX3U38',
    licence:
      'Public feature service owned by the City of Carlsbad GIS, tagged “open data”, no login. The item declares no licence text.',
  },
  {
    match: 'cslb.ca.gov',
    licence:
      'Public record published by the Contractors State License Board. Email addresses are withheld by the Board.',
  },
];

export function licenceFor(url: string | null): string {
  if (!url || !/^https?:/.test(url)) return 'Derived inside the pipeline from the sources above.';
  return LICENCES.find((l) => url.includes(l.match))?.licence ?? 'Not recorded.';
}

export function windowLabel(run: Pick<PipelineRun, 'window_from' | 'window_to'>): string {
  if (!run.window_from && !run.window_to) return 'Everything available';
  return `${run.window_from ?? 'earliest record'} → ${run.window_to ?? 'latest record'}`;
}

function runKind(run: PipelineRun): string {
  if (!run.window_from) return 'Full load';
  return run.forced ? 'Incremental (forced re-fetch)' : 'Incremental';
}

const sum = (
  stats: readonly RunStat[],
  key: 'fetched' | 'inserted' | 'updated' | 'unchanged' | 'rejected',
) => stats.reduce((total, s) => total + (s[key] ?? 0), 0);

/** Every run with its window, duration and per-source deltas, newest first. */
export function RunHistory({ data }: { data: PipelineRuns }) {
  const runs = [...data.runs].sort((a, b) => b.run_id - a.run_id);
  if (runs.length === 0) {
    return (
      <p className="empty-line" data-testid="run-history-empty">
        No pipeline runs are recorded yet.
      </p>
    );
  }
  return (
    <div className="stack" data-testid="run-history">
      {runs.map((run) => {
        const stats = data.stats.filter((s) => s.run_id === run.run_id);
        return (
          <article className="run" key={run.run_id} data-testid={`run-${run.run_id}`}>
            <header className="run-head">
              <h4>Run {run.run_id}</h4>
              <StatusBadge status={run.status} />
              <span className="badge badge-neutral">{runKind(run)}</span>
            </header>
            <dl className="facts facts-tight">
              <Fact label="Window">{windowLabel(run)}</Fact>
              <Fact label="Started">{fmtTimestamp(run.started_at)}</Fact>
              <Fact label="Finished">{fmtTimestamp(run.finished_at)}</Fact>
              <Fact label="Duration">{fmtDuration(run.started_at, run.finished_at)}</Fact>
            </dl>
            <div
              className="table-scroll"
              tabIndex={0}
              role="group"
              aria-label={`Run ${run.run_id} counts`}
            >
              <table className="mini-table">
                <caption className="sr-only">Per-source counts for run {run.run_id}</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Entity</th>
                    <th scope="col" className="num">
                      Fetched
                    </th>
                    <th scope="col" className="num">
                      Inserted
                    </th>
                    <th scope="col" className="num">
                      Updated
                    </th>
                    <th scope="col" className="num">
                      Unchanged
                    </th>
                    <th scope="col" className="num">
                      Rejected
                    </th>
                    <th scope="col">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
                    <tr
                      key={`${s.source_id}/${s.entity}`}
                      data-testid={`run-${run.run_id}-${s.source_id}-${s.entity}`}
                    >
                      <td>
                        <code>{s.source_id}</code>
                      </td>
                      <td>{s.entity}</td>
                      <td className="num">{fmtInt(s.fetched)}</td>
                      <td className="num">{fmtInt(s.inserted)}</td>
                      <td className="num">{fmtInt(s.updated)}</td>
                      <td className="num">{fmtInt(s.unchanged)}</td>
                      <td className="num">{fmtInt(s.rejected)}</td>
                      <td className="note-cell">{s.notes ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr data-testid={`run-${run.run_id}-total`}>
                    <th scope="row" colSpan={2}>
                      Total
                    </th>
                    <td className="num">{fmtInt(sum(stats, 'fetched'))}</td>
                    <td className="num">{fmtInt(sum(stats, 'inserted'))}</td>
                    <td className="num">{fmtInt(sum(stats, 'updated'))}</td>
                    <td className="num">{fmtInt(sum(stats, 'unchanged'))}</td>
                    <td className="num">{fmtInt(sum(stats, 'rejected'))}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function LatestRun({ runs, coverage }: { runs: PipelineRuns; coverage: Coverage | null }) {
  const latest = [...runs.runs].sort((a, b) => b.run_id - a.run_id)[0];
  if (!latest) return <p className="empty-line">No pipeline runs are recorded yet.</p>;
  return (
    <dl className="facts" data-testid="latest-run">
      <Fact label="County">{coverage?.county ?? COUNTY_NAME}</Fact>
      <Fact label="Latest run">
        <span data-testid="latest-run-id">Run {latest.run_id}</span>
      </Fact>
      <Fact label="Status">
        <StatusBadge status={latest.status} />
      </Fact>
      <Fact label="Started">{fmtTimestamp(latest.started_at)}</Fact>
      <Fact label="Finished">{fmtTimestamp(latest.finished_at)}</Fact>
      <Fact label="Duration">{fmtDuration(latest.started_at, latest.finished_at)}</Fact>
      <Fact label="Window">{windowLabel(latest)}</Fact>
      <Fact label="Runs recorded">{runs.runs.length}</Fact>
    </dl>
  );
}

export const PERMIT_COVERAGE_SQL =
  'SELECT jurisdiction, count(*) AS permits, count(*) FILTER (is_roofing) AS roofing_permits, ' +
  'count(*) FILTER (is_roofing AND is_open) AS open_roofing_permits FROM permit GROUP BY 1 ORDER BY 2 DESC';

/** Which jurisdictions have permit data: counted live, with the run's own statement beside it. */
function PermitCoverage({ statement }: { statement: string | undefined }) {
  const { state } = useResource('permitCoverage', () => queryAtlas(PERMIT_COVERAGE_SQL));
  return (
    <div className="subcard" data-testid="permit-coverage">
      <h4>Permit coverage by jurisdiction</h4>
      {statement ? (
        <p className="small" data-testid="permit-coverage-statement">
          {statement}
        </p>
      ) : null}
      {state.status === 'loading' ? (
        <p className="muted small">Counting permits per jurisdiction…</p>
      ) : null}
      {state.status === 'error' ? (
        <p className="muted small">
          The live per-jurisdiction count is unavailable ({state.error.message}).
        </p>
      ) : null}
      {state.status === 'ok' ? (
        <div className="table-scroll table-mid">
          <table className="mini-table" data-testid="permit-coverage-table">
            <caption className="sr-only">Permits per jurisdiction, counted live</caption>
            <thead>
              <tr>
                <th scope="col">Jurisdiction with a permit feed</th>
                <th scope="col" className="num">
                  Permits
                </th>
                <th scope="col" className="num">
                  Roofing
                </th>
                <th scope="col" className="num">
                  Open roofing
                </th>
              </tr>
            </thead>
            <tbody>
              {state.data.rows.map((row) => (
                <tr key={String(row.jurisdiction)}>
                  <td>{String(row.jurisdiction ?? 'not recorded')}</td>
                  <td className="num">{fmtInt(Number(row.permits))}</td>
                  <td className="num">{fmtInt(Number(row.roofing_permits))}</td>
                  <td className="num">{fmtInt(Number(row.open_roofing_permits))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="muted small">
        Parcels are loaded for the whole county; the table is counted live with queryAtlas.
      </p>
    </div>
  );
}

function CoverageBlock({ coverage }: { coverage: Coverage }) {
  const roofing = coverage.roofing ?? {};
  const label: Record<string, string> = {
    roofingPermits: 'Roofing permits',
    openRoofingPermits: 'Open roofing permits',
    openFiveYearsPlus: 'Open five years or more',
    openRoofingPermitsWithoutParcel: 'Open roofing permits without a parcel match',
    parcelsWithRoofYear: 'Parcels with a roof year',
    parcelsRoofFromPermit: 'Roof year taken from a roofing permit',
  };
  const parcels = coverage.counts.find((c) => c.table === 'property')?.rows ?? null;
  return (
    <>
      <dl className="facts">
        <Fact label="County">{coverage.county}</Fact>
        {coverage.fips ? <Fact label="FIPS">{coverage.fips}</Fact> : null}
        <Fact label="Parcels loaded">{fmtInt(parcels)}</Fact>
        {coverage.bbox ? (
          <Fact label="Bounding box">
            {coverage.bbox.minLat} to {coverage.bbox.maxLat} N, {coverage.bbox.minLon} to{' '}
            {coverage.bbox.maxLon} E
          </Fact>
        ) : null}
        <Fact label="Data as of">{fmtTimestamp(coverage.asOf)}</Fact>
        {Object.entries(roofing).map(([key, value]) => (
          <Fact key={key} label={label[key] ?? key}>
            {fmtInt(value)}
          </Fact>
        ))}
      </dl>
      <PermitCoverage statement={coverage.limitations.find((l) => /^Permit data/i.test(l))} />
    </>
  );
}

function Sources({ info }: { info: DatasetInfo }) {
  return (
    <ul className="source-list" data-testid="source-list">
      {info.sources.map((s) => (
        <li key={s.name} className="source-item">
          <div className="source-title">
            <strong>{s.name}</strong>
            <span className="muted">{s.rows === null ? '' : `${fmtInt(s.rows)} rows fetched`}</span>
          </div>
          <div className="small">
            <SourceLink url={s.url} />
          </div>
          <dl className="kv">
            <dt>Limits</dt>
            <dd>{s.limits ?? 'None recorded.'}</dd>
            <dt>Licence</dt>
            <dd>{licenceFor(s.url)}</dd>
          </dl>
        </li>
      ))}
    </ul>
  );
}

export default function RunSummary() {
  const runs = useResource('pipelineRuns', () => getPipelineRuns());
  const coverage = useResource('coverage', () => getCoverage());
  const info = useResource('datasetInfo', () => getDatasetInfo());

  return (
    <div className="page" data-testid="section-summary">
      <div className="page-head">
        <div>
          <h2>Run summary</h2>
          <p className="muted">
            What the pipeline loaded for {COUNTY_NAME}, when, from which sources, and what it could
            not get.
          </p>
        </div>
      </div>

      <Card title="Latest pipeline run" testId="card-latest-run">
        <ResourceView
          state={runs.state}
          reload={runs.reload}
          label="Loading pipeline runs…"
          testId="runs"
        >
          {(data) => (
            <LatestRun
              runs={data}
              coverage={coverage.state.status === 'ok' ? coverage.state.data : null}
            />
          )}
        </ResourceView>
      </Card>

      <Card title="County coverage" testId="card-coverage">
        <ResourceView
          state={coverage.state}
          reload={coverage.reload}
          label="Loading coverage…"
          testId="coverage"
        >
          {(data) => <CoverageBlock coverage={data} />}
        </ResourceView>
      </Card>

      <Card title="Sources, limits and licences" testId="card-sources">
        <ResourceView
          state={info.state}
          reload={info.reload}
          label="Loading sources…"
          testId="sources"
        >
          {(data) => <Sources info={data} />}
        </ResourceView>
      </Card>

      <Card title="Documented limitations" testId="card-limitations" id="limitations">
        <ResourceView
          state={coverage.state}
          reload={coverage.reload}
          label="Loading limitations…"
          testId="limitations"
        >
          {(data) =>
            data.limitations.length === 0 ? (
              <p className="empty-line">No limitations are documented for this run.</p>
            ) : (
              <ul className="bullets" data-testid="limitations-list">
                {data.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )
          }
        </ResourceView>
      </Card>

      <Card title="Run history" testId="card-run-history">
        <p className="muted small">
          Each run records what it fetched and what changed. A later incremental run that fetches a
          source again shows the rows as unchanged or updated instead of inserting them twice.
        </p>
        <ResourceView
          state={runs.state}
          reload={runs.reload}
          label="Loading run history…"
          testId="history"
        >
          {(data) => <RunHistory data={data} />}
        </ResourceView>
      </Card>
    </div>
  );
}
