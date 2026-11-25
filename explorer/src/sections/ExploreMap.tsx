import { Fragment, Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from 'react';
import { MARKER_COLORS, type MapPoint } from '../components/mapColors';
import { ErrorNotice, Loading, ResourceView, SourceLink } from '../components/ui';
import { findLeads, getProperty } from '../lib/api';
import { fmtInt, fmtOpenDuration, fmtTimestamp, roofBasisLabel } from '../lib/format';
import { DEFAULT_PLACE, MAX_RADIUS_MILES, PLACES, inCounty, type Point } from '../lib/places';
import type { LeadRow, LeadSearch, Permit, Property, Provenance } from '../lib/schemas';
import { useResource } from '../lib/useResource';

const MapView = lazy(() => import('../components/MapView'));

type Tab = 'aged' | 'permits';

const PAGE_SIZE = 20;

interface Search {
  center: Point;
  radiusMiles: number;
  minAge: number;
}

const coord = (n: number): string => n.toFixed(5);

function ProvenanceLine({ provenance, what }: { provenance: Provenance; what: string }) {
  return (
    <p className="source" data-testid="provenance">
      <span className="source-tag">Source</span> {what}: <code>{provenance.source}</code>
      {provenance.sourceRecordId ? <> · record {provenance.sourceRecordId}</> : null}
      {provenance.fetchedAt ? <> · collected {fmtTimestamp(provenance.fetchedAt)}</> : null} ·{' '}
      <SourceLink url={provenance.sourceUrl} label="open source" />
    </p>
  );
}

function PermitCard({ permit }: { permit: Permit }) {
  const c = permit.contractor;
  return (
    <li
      className={`permit ${permit.isOpen ? 'permit-open' : ''}`}
      data-testid={`permit-${permit.permitId}`}
    >
      <div className="permit-head">
        <code>{permit.permitId}</code>
        <span className={`badge ${permit.isOpen ? 'badge-permit' : 'badge-neutral'}`}>
          {permit.isOpen ? 'Open' : 'Closed'}
          {permit.status ? ` · ${permit.status}` : ''}
        </span>
        {permit.isRoofing ? (
          <span className="badge badge-aged">
            Roofing{permit.roofingClass ? `: ${permit.roofingClass}` : ''}
          </span>
        ) : null}
        <span className="muted">{permit.permitType ?? ''}</span>
      </div>
      {permit.description ? <p className="small permit-desc">{permit.description}</p> : null}
      <dl className="kv">
        <dt>Dates</dt>
        <dd>
          applied {permit.appliedDate ?? '—'} · issued {permit.issuedDate ?? '—'} · closed{' '}
          {permit.closedDate ?? '—'}
        </dd>
        <dt>{permit.isOpen ? 'Open for' : 'Was open'}</dt>
        <dd>{fmtOpenDuration(permit.daysOpen)}</dd>
        <dt>Contractor</dt>
        <dd>
          {c ? (
            <>
              {c.name ?? 'name not listed'}
              {c.phone ? ` · ${c.phone}` : ''}
            </>
          ) : (
            <span className="muted">No contractor is listed on this permit in the source.</span>
          )}
        </dd>
        {c ? (
          <>
            <dt>CSLB licence</dt>
            <dd>
              {c.licenseNumber ? (
                <>
                  #{c.licenseNumber}
                  {c.licenseStatus ? ` · ${c.licenseStatus}` : ''}
                  {c.classifications ? ` · ${c.classifications}` : ''}
                </>
              ) : (
                <span className="muted">
                  No licence number on this permit (the city feed carries only a free-text holder).
                </span>
              )}
            </dd>
            <dt>BBB</dt>
            <dd data-testid="bbb">
              {c.bbbRating ? (
                <>
                  <span className="bbb-rating">{c.bbbRating}</span>{' '}
                  {c.bbbUrl ? <SourceLink url={c.bbbUrl} label="BBB profile" /> : null}
                </>
              ) : (
                <span className="muted">
                  Not available: {c.bbbNote ?? 'no rating in the source data.'}
                </span>
              )}
            </dd>
          </>
        ) : null}
      </dl>
      <ProvenanceLine provenance={permit.provenance} what="permit" />
    </li>
  );
}

export function PropertyDetail({ property }: { property: Property }) {
  const [all, setAll] = useState(false);
  const roofing = property.permits.filter((p) => p.isRoofing);
  const shown = all ? property.permits : roofing;
  const others = property.permits.length - roofing.length;
  return (
    <div className="detail" data-testid={`detail-${property.apn}`}>
      <dl className="facts facts-tight">
        <div className="fact">
          <dt>Roof-age basis</dt>
          <dd>
            {roofBasisLabel(property.roofBasis)}
            {property.roofConfidence ? ` · confidence ${property.roofConfidence}` : ''}
          </dd>
        </div>
        <div className="fact">
          <dt>Roof year / year built</dt>
          <dd>
            {property.roofYear ?? '—'} / {property.yearBuilt ?? '—'}
          </dd>
        </div>
        <div className="fact">
          <dt>Ownership</dt>
          <dd>
            {property.ownerOccupied === null
              ? 'owner-occupancy unknown'
              : property.ownerOccupied
                ? 'owner-occupied'
                : 'not flagged owner-occupied'}
            {property.lastTransferDate ? ` · last transfer ${property.lastTransferDate}` : ''}
            {property.ownerName
              ? ` · ${property.ownerName}`
              : ' · owner name not in any public source'}
          </dd>
        </div>
        <div className="fact">
          <dt>Use</dt>
          <dd>{property.useType ?? '—'}</dd>
        </div>
      </dl>
      <ProvenanceLine provenance={property.provenance} what="parcel" />
      <h4>
        {all ? 'All permits' : 'Roofing permits'} ({shown.length})
      </h4>
      {shown.length === 0 ? (
        <p className="empty-line">
          {roofing.length === 0 && !all
            ? 'No roofing permit is on record for this parcel, so the roof age rests on the assessor year.'
            : 'No permits on record for this parcel.'}
        </p>
      ) : (
        <ul className="permits">
          {shown.map((p) => (
            <PermitCard key={`${p.permitId}/${p.provenance.source}`} permit={p} />
          ))}
        </ul>
      )}
      {others > 0 ? (
        <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>
          {all ? 'Show roofing permits only' : `Show ${others} other (non-roofing) permits too`}
        </button>
      ) : null}
    </div>
  );
}

function DetailLoader({ apn }: { apn: string }) {
  const { state, reload } = useResource(`property:${apn}`, () => getProperty(apn));
  return (
    <ResourceView
      state={state}
      reload={reload}
      label="Loading permits and sources…"
      testId={`detail-${apn}`}
    >
      {(property) =>
        property ? (
          <PropertyDetail property={property} />
        ) : (
          <p className="empty-line">This parcel is no longer in the served run.</p>
        )
      }
    </ResourceView>
  );
}

function ResultsTable({
  tab,
  rows,
  expanded,
  onToggle,
}: {
  tab: Tab;
  rows: readonly LeadRow[];
  expanded: string | null;
  onToggle: (apn: string) => void;
}) {
  const columns = tab === 'aged' ? 7 : 8;
  return (
    <div className="table-scroll" tabIndex={0} role="group" aria-label="Matching properties">
      <table className="results-table" data-testid="results-table">
        <caption className="sr-only">
          {tab === 'aged' ? 'Properties with aged roofs' : 'Properties with open roofing permits'}
        </caption>
        <thead>
          <tr>
            <th scope="col">Property</th>
            {tab === 'aged' ? (
              <>
                <th scope="col" className="num">
                  Roof age
                </th>
                <th scope="col">Roof-age basis</th>
              </>
            ) : (
              <>
                <th scope="col">Longest open</th>
                <th scope="col">Permit</th>
                <th scope="col">Contractor</th>
                <th scope="col">Licence</th>
              </>
            )}
            <th scope="col">Coordinates</th>
            <th scope="col" className="num">
              Distance
            </th>
            {tab === 'aged' ? <th scope="col">Open permits</th> : null}
            <th scope="col">Sources</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = expanded === r.apn;
            return (
              <Fragment key={r.apn}>
                <tr
                  data-testid={`row-${r.apn}`}
                  className={open ? 'is-open' : undefined}
                  id={`row-${r.apn}`}
                >
                  <th scope="row" className="prop-cell">
                    <span className="prop-address">{r.address ?? 'No situs address'}</span>
                    <span className="muted small">
                      {[r.city, r.zip].filter(Boolean).join(' ')} · APN {r.apn}
                    </span>
                  </th>
                  {tab === 'aged' ? (
                    <>
                      <td className="num">
                        <strong>{r.roofAgeYears ?? '—'}</strong> yrs
                        <div className="muted small">roof {r.roofYear ?? '—'}</div>
                      </td>
                      <td>
                        {roofBasisLabel(r.roofBasis)}
                        <div className="muted small">confidence {r.roofConfidence ?? 'n/a'}</div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <strong>{fmtOpenDuration(r.longestOpenDays)}</strong>
                        <div className="muted small">
                          {r.openRoofPermits} open roofing{' '}
                          {r.openRoofPermits === 1 ? 'permit' : 'permits'}
                        </div>
                      </td>
                      <td>
                        <code>{r.topOpenPermitId ?? '—'}</code>
                        <div>
                          <span className="badge badge-permit">Open</span>
                        </div>
                      </td>
                      <td>{r.topOpenContractor ?? <span className="muted">not listed</span>}</td>
                      <td>
                        {r.topOpenLicenseNo ? (
                          `#${r.topOpenLicenseNo}`
                        ) : (
                          <span className="muted">none on permit</span>
                        )}
                      </td>
                    </>
                  )}
                  <td className="coords">
                    {coord(r.lat)}, {coord(r.lon)}
                  </td>
                  <td className="num">{r.distanceMiles.toFixed(2)} mi</td>
                  {tab === 'aged' ? (
                    <td>{r.openRoofPermits > 0 ? r.openRoofPermits : '—'}</td>
                  ) : null}
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-expanded={open}
                      data-testid={`expand-${r.apn}`}
                      onClick={() => onToggle(r.apn)}
                    >
                      {open ? 'Hide' : tab === 'aged' ? 'Sources' : 'Permits, BBB, sources'}
                    </button>
                  </td>
                </tr>
                {open ? (
                  <tr className="detail-row">
                    <td colSpan={columns}>
                      <DetailLoader apn={r.apn} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ResultsBody({
  tab,
  data,
  search,
  expanded,
  onToggle,
}: {
  tab: Tab;
  data: LeadSearch;
  search: Search;
  expanded: string | null;
  onToggle: (apn: string) => void;
}) {
  const [shown, setShown] = useState(PAGE_SIZE);
  return (
    <div className="stack-tight">
      <p className="result-meta" data-testid="results-meta">
        <strong data-testid="results-total">
          {fmtInt(data.total)}{' '}
          {tab === 'aged'
            ? `properties with a roof ${search.minAge}+ years old`
            : 'properties with open roofing permits'}
        </strong>
        <span className="muted">
          within {search.radiusMiles} mi · showing {fmtInt(Math.min(shown, data.rows.length))} ·{' '}
          {tab === 'aged' ? 'oldest roof first' : 'longest open first'} · as of {data.asOf}
        </span>
      </p>
      {data.coverageNote ? (
        <p className="notice notice-warn" data-testid="coverage-note">
          {data.coverageNote}
        </p>
      ) : null}
      {data.rows.length === 0 ? (
        <div className="empty" data-testid="results-empty">
          <h3>No matches in this radius</h3>
          <p>
            {tab === 'permits'
              ? 'No open roofing permits were found here. Permit data exists only for the City of San Diego and the unincorporated county.'
              : 'No parcel in this radius has a roof at or above the threshold. Try a wider radius or a lower threshold.'}
          </p>
        </div>
      ) : (
        <>
          <ResultsTable
            tab={tab}
            rows={data.rows.slice(0, shown)}
            expanded={expanded}
            onToggle={onToggle}
          />
          {data.rows.length > shown ? (
            <button
              type="button"
              className="btn"
              data-testid="results-more"
              onClick={() => setShown((n) => n + PAGE_SIZE)}
            >
              Show {Math.min(PAGE_SIZE, data.rows.length - shown)} more (of{' '}
              {fmtInt(data.rows.length)} loaded)
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

export default function ExploreMap() {
  const [search, setSearch] = useState<Search>({
    center: DEFAULT_PLACE,
    radiusMiles: 1,
    minAge: 15,
  });
  const [draft, setDraft] = useState({
    lat: String(DEFAULT_PLACE.lat),
    lon: String(DEFAULT_PLACE.lon),
    radius: '1',
    minAge: '15',
  });
  const [tab, setTab] = useState<Tab>('aged');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const formId = useId();
  const autoExpanded = useRef<string | null>(null);

  const key = `leads:${tab}:${search.center.lat}:${search.center.lon}:${search.radiusMiles}:${search.minAge}`;
  const { state, reload } = useResource(key, () =>
    findLeads({
      center: search.center,
      radiusMiles: search.radiusMiles,
      minRoofAgeYears: search.minAge,
      signal: tab === 'aged' ? 'aged_roof' : 'open_permit',
    }),
  );

  // Open the first row once per search so provenance is visible without an extra click.
  useEffect(() => {
    if (state.status !== 'ok' || autoExpanded.current === key) return;
    autoExpanded.current = key;
    setExpanded(state.data.rows[0]?.apn ?? null);
  }, [state, key]);

  const points = useMemo<MapPoint[]>(
    () =>
      state.status === 'ok'
        ? state.data.rows.map((r) => ({
            id: r.apn,
            lat: r.lat,
            lon: r.lon,
            color: tab === 'aged' ? MARKER_COLORS.aged : MARKER_COLORS.permit,
            label:
              tab === 'aged'
                ? `${r.address ?? r.apn}: roof ${r.roofAgeYears ?? '?'} yrs`
                : `${r.address ?? r.apn}: open ${fmtOpenDuration(r.longestOpenDays)}`,
          }))
        : [],
    [state, tab],
  );

  const commit = (center: Point, radiusText = draft.radius, ageText = draft.minAge): void => {
    const radius = Number(radiusText);
    const minAge = Number(ageText);
    if (!Number.isFinite(center.lat) || !Number.isFinite(center.lon) || !inCounty(center)) {
      setFormError(
        'That point is outside San Diego County (latitude 32.5 to 33.55, longitude -117.65 to -116.05).',
      );
      return;
    }
    if (!Number.isFinite(radius) || radius <= 0 || radius > MAX_RADIUS_MILES) {
      setFormError(`Radius must be between 0.1 and ${MAX_RADIUS_MILES} miles.`);
      return;
    }
    if (!Number.isInteger(minAge) || minAge < 0 || minAge > 150) {
      setFormError('Roof-age threshold must be a whole number of years from 0 to 150.');
      return;
    }
    setFormError(null);
    setExpanded(null);
    setDraft({
      lat: String(center.lat),
      lon: String(center.lon),
      radius: String(radius),
      minAge: String(minAge),
    });
    setSearch({ center, radiusMiles: radius, minAge });
  };

  const round = (p: Point): Point => ({
    lat: Number(p.lat.toFixed(5)),
    lon: Number(p.lon.toFixed(5)),
  });
  const activePlace = PLACES.find(
    (p) => p.lat === search.center.lat && p.lon === search.center.lon,
  );

  const toggle = (apn: string): void => setExpanded((current) => (current === apn ? null : apn));

  return (
    <div className="page" data-testid="section-map">
      <div className="page-head">
        <div>
          <h2>Explore map</h2>
          <p className="muted">
            Pick a point and a radius; the same findRoofingLeads tool the agent and the roofing CRM
            use returns the matches.
          </p>
        </div>
      </div>

      <form
        className="card controls"
        aria-label="Search area"
        onSubmit={(event) => {
          event.preventDefault();
          commit({ lat: Number(draft.lat), lon: Number(draft.lon) });
        }}
      >
        <div>
          <p className="field-label" id={`${formId}-jump`}>
            Jump to
          </p>
          <ul className="chips" aria-labelledby={`${formId}-jump`}>
            {PLACES.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="chip-btn"
                  aria-pressed={activePlace?.id === p.id}
                  data-testid={`place-${p.id}`}
                  onClick={() => commit(p)}
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="controls-row">
          <label className="field">
            <span className="field-label">Latitude</span>
            <input
              type="text"
              inputMode="decimal"
              data-testid="input-lat"
              value={draft.lat}
              onChange={(e) => setDraft({ ...draft, lat: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Longitude</span>
            <input
              type="text"
              inputMode="decimal"
              data-testid="input-lon"
              value={draft.lon}
              onChange={(e) => setDraft({ ...draft, lon: e.target.value })}
            />
          </label>
          <label className="field field-narrow">
            <span className="field-label">Radius (miles)</span>
            <input
              type="number"
              min={0.1}
              max={MAX_RADIUS_MILES}
              step={0.1}
              data-testid="input-radius"
              value={draft.radius}
              onChange={(e) => setDraft({ ...draft, radius: e.target.value })}
            />
          </label>
          <label className="field field-narrow">
            <span className="field-label">Roof age at least (years)</span>
            <input
              type="number"
              min={0}
              max={150}
              step={1}
              data-testid="input-min-age"
              value={draft.minAge}
              onChange={(e) => setDraft({ ...draft, minAge: e.target.value })}
            />
          </label>
          <button type="submit" className="btn btn-primary" data-testid="search-submit">
            Search this area
          </button>
        </div>
        {formError ? (
          <p className="notice notice-error" role="alert" data-testid="search-form-error">
            {formError}
          </p>
        ) : (
          <p className="muted small">Or click the map to move the pin.</p>
        )}
      </form>

      <div className="map-and-results">
        <div className="map-box">
          <Suspense fallback={<Loading label="Loading the map…" />}>
            <MapView
              testId="explore-map"
              ariaLabel="Map of San Diego County with the search pin and matching properties"
              pin={search.center}
              radiusMiles={search.radiusMiles}
              points={points}
              selectedId={expanded}
              onPinChange={(p) => commit(round(p))}
              onSelect={(apn) => {
                setExpanded(apn);
                document
                  .getElementById(`row-${apn}`)
                  ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }}
            />
          </Suspense>
          <ul className="map-legend" aria-label="Map legend">
            <li>
              <span className="legend-dot" style={{ background: MARKER_COLORS.aged }} /> Roof older
              than threshold
            </li>
            <li>
              <span className="legend-dot" style={{ background: MARKER_COLORS.permit }} /> Open
              roofing permit
            </li>
          </ul>
        </div>

        <section className="card results" aria-label="Results">
          <div className="tabs" role="tablist" aria-label="Result type">
            <button
              type="button"
              role="tab"
              id="tab-aged"
              aria-selected={tab === 'aged'}
              aria-controls="results-panel"
              data-testid="tab-aged"
              onClick={() => {
                setTab('aged');
                setExpanded(null);
              }}
            >
              Roofs older than {search.minAge} years
            </button>
            <button
              type="button"
              role="tab"
              id="tab-permits"
              aria-selected={tab === 'permits'}
              aria-controls="results-panel"
              data-testid="tab-permits"
              onClick={() => {
                setTab('permits');
                setExpanded(null);
              }}
            >
              Open roofing permits (longest open first)
            </button>
          </div>
          <div
            id="results-panel"
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
            className="results-body"
            data-testid="results-panel"
          >
            {state.status === 'loading' ? (
              <Loading label="Searching the radius…" testId="results-loading" />
            ) : null}
            {state.status === 'error' ? (
              <ErrorNotice error={state.error} onRetry={reload} testId="results-error" />
            ) : null}
            {state.status === 'ok' ? (
              <ResultsBody
                key={key}
                tab={tab}
                data={state.data}
                search={search}
                expanded={expanded}
                onToggle={toggle}
              />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
