import { Card, ResourceView, SourceLink } from '../components/ui';
import { getCoverage, getDatasetInfo, getPipelineRuns, queryAtlas } from '../lib/api';
import { fmtInt, fmtTimestamp } from '../lib/format';
import type { Coverage, DatasetInfo, PipelineRuns } from '../lib/schemas';
import { useResource } from '../lib/useResource';
import { licenceFor } from './RunSummary';

export const DERIVED_COUNTS_SQL = `SELECT
  (SELECT count(*) FROM parcel WHERE lat IS NOT NULL AND lon IS NOT NULL) AS parcels_with_coordinates,
  (SELECT count(*) FROM business WHERE lat IS NOT NULL AND lon IS NOT NULL) AS businesses_with_coordinates,
  (SELECT count(*) FROM contractor) AS contractors,
  (SELECT count(bbb_rating) FROM contractor) AS contractors_with_bbb_rating,
  (SELECT any_value(bbb_note) FROM contractor WHERE bbb_note IS NOT NULL) AS bbb_note`;

interface Derived {
  parcelsWithCoordinates: number | null;
  businessesWithCoordinates: number | null;
  contractorsWithBbb: number | null;
  bbbNote: string | null;
}

async function loadDerived(): Promise<Derived> {
  const result = await queryAtlas(DERIVED_COUNTS_SQL);
  const row = result.rows[0] ?? {};
  const n = (key: string): number | null => {
    const value = Number(row[key]);
    return row[key] === null || row[key] === undefined || Number.isNaN(value) ? null : value;
  };
  return {
    parcelsWithCoordinates: n('parcels_with_coordinates'),
    businessesWithCoordinates: n('businesses_with_coordinates'),
    contractorsWithBbb: n('contractors_with_bbb_rating'),
    bbbNote: typeof row.bbb_note === 'string' ? row.bbb_note : null,
  };
}

const HEADLINE: readonly { table: string; label: string; what: string }[] = [
  { table: 'property', label: 'Property', what: 'Parcels with assessor attributes' },
  { table: 'ownership', label: 'Ownership', what: 'Owner-occupancy and last transfer per parcel' },
  { table: 'permit', label: 'Permit', what: 'City and county building permits' },
  { table: 'contractor', label: 'Contractor', what: 'Reconciled on CSLB licence number' },
  { table: 'business', label: 'Business', what: 'City of San Diego tax certificates' },
];

const OTHER_LABEL: Record<string, string> = {
  permit_status_history: 'Permit status history',
  permit_contractor_record: 'Permit contractor records',
  cslb_license: 'CSLB licences',
  rejects: 'Rejected rows (kept, not loaded)',
};

function Totals({ coverage, derived }: { coverage: Coverage; derived: Derived | null }) {
  const count = (table: string): number | null =>
    coverage.counts.find((c) => c.table === table)?.rows ?? null;
  const headline = new Set(HEADLINE.map((h) => h.table));
  const others = coverage.counts.filter((c) => !headline.has(c.table));
  return (
    <>
      <dl className="stat-grid" data-testid="record-totals">
        {HEADLINE.map((h) => (
          <div className="stat" key={h.table} data-testid={`total-${h.table}`}>
            <dt>{h.label}</dt>
            <dd className="stat-value">{fmtInt(count(h.table))}</dd>
            <dd className="muted small">{h.what}</dd>
            {h.table === 'contractor' ? (
              <dd className="small bbb-note" data-testid="bbb-note">
                BBB rating:{' '}
                {derived
                  ? `${fmtInt(derived.contractorsWithBbb)} of ${fmtInt(count('contractor'))} rows carry one. `
                  : ''}
                {derived?.bbbNote ??
                  'Not collected: there is no bulk source and BBB terms limit copying. Each contractor row carries the reason.'}
              </dd>
            ) : null}
          </div>
        ))}
        <div className="stat" data-testid="total-coordinates">
          <dt>Coordinates</dt>
          <dd className="stat-value">{derived ? fmtInt(derived.parcelsWithCoordinates) : '…'}</dd>
          <dd className="muted small">
            Parcels with latitude and longitude
            {derived?.businessesWithCoordinates !== null &&
            derived?.businessesWithCoordinates !== undefined
              ? `; plus ${fmtInt(derived.businessesWithCoordinates)} businesses with coordinates`
              : ''}
          </dd>
        </div>
      </dl>
      {others.length > 0 ? (
        <div className="table-scroll table-narrow">
          <table className="mini-table">
            <caption className="sr-only">Supporting tables</caption>
            <thead>
              <tr>
                <th scope="col">Supporting table</th>
                <th scope="col" className="num">
                  Rows
                </th>
              </tr>
            </thead>
            <tbody>
              {others.map((c) => (
                <tr key={c.table} data-testid={`total-${c.table}`}>
                  <td>{OTHER_LABEL[c.table] ?? c.table}</td>
                  <td className="num">{fmtInt(c.rows)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function SourceTable({ info, runs }: { info: DatasetInfo; runs: PipelineRuns | null }) {
  const lastRun = runs ? [...runs.runs].sort((a, b) => b.run_id - a.run_id)[0] : undefined;
  return (
    <div className="table-scroll" tabIndex={0} role="group" aria-label="Records fetched per source">
      <table className="mini-table" data-testid="source-table">
        <caption className="sr-only">Records fetched per source</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col" className="num">
              Rows fetched
            </th>
            <th scope="col">Collected at</th>
            <th scope="col">Provenance</th>
            <th scope="col">Licence</th>
          </tr>
        </thead>
        <tbody>
          {info.sources.map((s) => (
            <tr key={s.name}>
              <td>{s.name}</td>
              <td className="num">{fmtInt(s.rows)}</td>
              <td>
                {s.fetchedAt ? (
                  fmtTimestamp(s.fetchedAt)
                ) : lastRun ? (
                  <>
                    {fmtTimestamp(lastRun.finished_at)}
                    <span className="muted small">
                      {' '}
                      (end of run {lastRun.run_id}; this source keeps a cursor, not a fetch time)
                    </span>
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td>
                <SourceLink url={s.url} />
              </td>
              <td className="note-cell">{licenceFor(s.url)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Records() {
  const coverage = useResource('coverage', () => getCoverage());
  const info = useResource('datasetInfo', () => getDatasetInfo());
  const runs = useResource('pipelineRuns', () => getPipelineRuns());
  const derived = useResource('derivedCounts', loadDerived);

  return (
    <div className="page" data-testid="section-records">
      <div className="page-head">
        <div>
          <h2>Records by source</h2>
          <p className="muted">
            Totals per table, what each source delivered and when, and the rows that were refused.
          </p>
        </div>
      </div>

      <Card title="Total uploaded records" testId="card-totals">
        <ResourceView
          state={coverage.state}
          reload={coverage.reload}
          label="Loading totals…"
          testId="totals"
        >
          {(data) => (
            <Totals
              coverage={data}
              derived={derived.state.status === 'ok' ? derived.state.data : null}
            />
          )}
        </ResourceView>
        {derived.state.status === 'error' ? (
          <p className="muted small" role="status">
            The coordinate and BBB counts could not be computed live ({derived.state.error.message}
            ).
          </p>
        ) : null}
        <details className="disclosure">
          <summary>How the coordinate and BBB counts are computed</summary>
          <p className="small muted">
            Counted live through the queryAtlas tool with this statement:
          </p>
          <pre className="code">{DERIVED_COUNTS_SQL}</pre>
        </details>
      </Card>

      <Card title="Per source: rows fetched, collection time, provenance" testId="card-per-source">
        <ResourceView
          state={info.state}
          reload={info.reload}
          label="Loading sources…"
          testId="per-source"
        >
          {(data) => (
            <SourceTable info={data} runs={runs.state.status === 'ok' ? runs.state.data : null} />
          )}
        </ResourceView>
        <p className="muted small">
          Every loaded row also carries its own <code>source_id</code>,{' '}
          <code>source_record_id</code>, <code>source_url</code> and <code>fetched_at</code>; they
          are shown per property in the Explore map and are selectable in the query layer.
        </p>
      </Card>

      <Card title="Rejected rows by reason" testId="card-rejects">
        <ResourceView
          state={coverage.state}
          reload={coverage.reload}
          label="Loading rejects…"
          testId="rejects"
        >
          {(data) =>
            data.rejects.length === 0 ? (
              <p className="empty-line">No rows were rejected.</p>
            ) : (
              <div
                className="table-scroll"
                tabIndex={0}
                role="group"
                aria-label="Rejected rows by reason"
              >
                <table className="mini-table" data-testid="rejects-table">
                  <caption className="sr-only">Rejected rows by reason</caption>
                  <thead>
                    <tr>
                      <th scope="col">Source</th>
                      <th scope="col">Entity</th>
                      <th scope="col">Reason</th>
                      <th scope="col" className="num">
                        Rows
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rejects.map((r) => (
                      <tr key={`${r.source}/${r.entity}/${r.reason}`}>
                        <td>
                          <code>{r.source}</code>
                        </td>
                        <td>{r.entity}</td>
                        <td>
                          <code>{r.reason}</code>
                        </td>
                        <td className="num">{fmtInt(r.rows)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </ResourceView>
      </Card>
    </div>
  );
}
