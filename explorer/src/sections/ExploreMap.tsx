import type { ReactNode } from 'react';
import { Fragment, Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from 'react';
import { MARKER_COLORS, type MapPoint } from '../components/mapColors';
import { ErrorNotice, Loading, ResourceView, SourceLink } from '../components/ui';
import {
  findLeads,
  getPermitStatusGroups,
  getProperty,
  queryAtlas,
  type LeadSearchArgs,
} from '../lib/api';
import { fmtInt, fmtOpenDuration, fmtTimestamp, fullAddress, roofBasisLabel } from '../lib/format';
import { DEFAULT_PLACE, MAX_RADIUS_MILES, PLACES, inCounty, type Point } from '../lib/places';
import type { LeadRow, LeadSearch, Permit, Property, Provenance } from '../lib/schemas';
import { useResource } from '../lib/useResource';

const MapView = lazy(() => import('../components/MapView'));

export type Tab = 'aged' | 'permits' | 'ownership' | 'outOfArea';

const PAGE_SIZE = 20;

export interface Search {
  center: Point;
  radiusMiles: number;
  minAge: number;
  minYearsHeld: number;
}

interface TabSpec {
  id: Tab;
  testId: string;
  label: (s: Search) => string;
  total: (s: Search) => string;
  order: string;
  color: string;
  legend: string;
  empty: string;
  /** One honest line shown above the results of this tab. */
  note?: string;
}

export const OUT_OF_AREA_NOTE =
  'Proxy, not a fact: these are parcels the assessor does not flag as owner-occupied. No public source holds an owner mailing address, so this over-counts (rentals, second homes and owners who never claimed the exemption all appear).';

export const TABS: readonly TabSpec[] = [
  {
    id: 'aged',
    testId: 'tab-aged',
    label: (s) => `Roofs older than ${s.minAge} years`,
    total: (s) => `properties with a roof ${s.minAge}+ years old`,
    order: 'oldest roof first',
    color: MARKER_COLORS.aged,
    legend: 'Roof at or above the age threshold',
    empty:
      'No parcel in this radius has a roof at or above the threshold. Try a wider radius or a lower threshold.',
  },
  {
    id: 'permits',
    testId: 'tab-permits',
    label: () => 'Open roofing permits (longest open first)',
    total: () => 'properties with open roofing permits',
    order: 'longest open first',
    color: MARKER_COLORS.permit,
    legend: 'Open roofing permit',
    empty:
      'No open roofing permits were found in this radius. Permit data exists only for the jurisdictions listed under County coverage on the Run summary page.',
  },
  {
    id: 'ownership',
    testId: 'tab-ownership',
    label: (s) => `Ownership unchanged ${s.minYearsHeld}+ years`,
    total: (s) => `properties with no recorded transfer for ${s.minYearsHeld}+ years`,
    order: 'nearest first',
    color: MARKER_COLORS.ownership,
    legend: 'Ownership unchanged for the chosen years',
    empty:
      'No parcel in this radius has gone that long without a recorded transfer. Try fewer years or a wider radius.',
    note: 'Measured from the date of the last recorded ownership document on the parcel.',
  },
  {
    id: 'outOfArea',
    testId: 'tab-out-of-area',
    label: () => 'Out-of-area owner (proxy)',
    total: () => 'properties not flagged owner-occupied',
    order: 'nearest first',
    color: MARKER_COLORS.outOfArea,
    legend: 'Not flagged owner-occupied (proxy)',
    empty: 'Every parcel in this radius is flagged owner-occupied.',
    note: OUT_OF_AREA_NOTE,
  },
];

/** The findRoofingLeads arguments each tab sends. */
export function leadArgs(tab: Tab, search: Search): LeadSearchArgs {
  const base = {
    center: { lat: search.center.lat, lon: search.center.lon },
    radiusMiles: search.radiusMiles,
    minRoofAgeYears: search.minAge,
  };
  if (tab === 'aged') return { ...base, signal: 'aged_roof' };
  if (tab === 'permits') return { ...base, signal: 'open_permit' };
  if (tab === 'ownership') {
    return { ...base, signal: 'any', minYearsSinceTransfer: search.minYearsHeld };
  }
  return { ...base, signal: 'any', ownerOccupied: 'no' };
}

const coord = (n: number): string => n.toFixed(5);

/** Whole years between an ISO date and the search's as-of date. */
export function yearsBetween(from: string | null, asOf: string): number | null {
  if (!from) return null;
  const a = new Date(`${from.slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${asOf.slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / (365.25 * 86_400_000));
}

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

const permitKey = (permit: Permit): string => `${permit.permitId}|${permit.provenance.source}`;

type PermitState = 'open' | 'pending' | 'closed';

function permitState(permit: Permit, group: string | null): PermitState {
  if (permit.isOpen) return 'open';
  return group === 'pending' ? 'pending' : 'closed';
}

function PermitCard({ permit, group }: { permit: Permit; group: string | null }) {
  const c = permit.contractor;
  const state = permitState(permit, group);
  return (
    <li
      className={`permit permit-${state}`}
      data-testid={`permit-${permit.permitId}`}
      data-permit-state={state}
    >
      <div className="permit-head">
        <code>{permit.permitId}</code>
        {state === 'open' ? (
          <span className="badge badge-permit">
            Open{permit.status ? ` · ${permit.status}` : ''}
          </span>
        ) : state === 'pending' ? (
          <span className="badge badge-pending" data-testid="permit-pending">
            Pending: applied, not issued{permit.status ? ` · source status “${permit.status}”` : ''}
          </span>
        ) : (
          <span className="badge badge-neutral">
            {group ? `${group[0]?.toUpperCase() ?? ''}${group.slice(1)}` : 'Closed'}
            {permit.status ? ` · ${permit.status}` : ''}
          </span>
        )}
        {permit.isRoofing ? (
          <span className="badge badge-aged">
            Roofing{permit.roofingClass ? `: ${permit.roofingClass}` : ''}
          </span>
        ) : null}
        <span className="muted">{permit.permitType ?? ''}</span>
      </div>
      {state === 'pending' ? (
        <p className="small muted">
          Not counted as an open permit: nothing has been issued yet, so no work is authorised.
        </p>
      ) : null}
      {permit.description ? <p className="small permit-desc">{permit.description}</p> : null}
      <dl className="kv">
        <dt>Dates</dt>
        <dd>
          applied {permit.appliedDate ?? '—'} · issued {permit.issuedDate ?? '—'} · closed{' '}
          {permit.closedDate ?? '—'}
        </dd>
        {state === 'pending' ? null : (
          <>
            <dt>{permit.isOpen ? 'Open for' : 'Was open'}</dt>
            <dd>{fmtOpenDuration(permit.daysOpen)}</dd>
          </>
        )}
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
                <span className="muted">No licence number is recorded on this permit.</span>
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

export function PropertyDetail({
  property,
  statusGroups,
}: {
  property: Property;
  statusGroups?: ReadonlyMap<string, string>;
}) {
  const [all, setAll] = useState(false);
  const roofing = property.permits.filter((p) => p.isRoofing);
  const shown = all ? property.permits : roofing;
  const others = property.permits.length - roofing.length;
  const groupOf = (p: Permit): string | null =>
    p.statusGroup ?? statusGroups?.get(permitKey(p)) ?? null;
  const pending = shown.filter((p) => permitState(p, groupOf(p)) === 'pending').length;
  const open = shown.filter((p) => p.isOpen).length;
  return (
    <div className="detail" data-testid={`detail-${property.apn}`}>
      <p className="detail-title" data-testid="detail-address">
        <strong>{fullAddress(property.address, property.unit)}</strong>
        <span className="muted">
          {' '}
          {[property.city, property.zip].filter(Boolean).join(' ')}
        </span>{' '}
        <code className="apn">APN {property.apn}</code>
      </p>
      <dl className="facts facts-tight">
        <div className="fact">
          <dt>Roof-age basis</dt>
          <dd>
            {roofBasisLabel(property.roofBasis)}
            {property.roofConfidence ? ` · confidence ${property.roofConfidence}` : ''}
          </dd>
        </div>
        <div className="fact">
          <dt>Roof year / assessor effective year</dt>
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
                ? 'flagged owner-occupied'
                : 'not flagged owner-occupied'}
            {property.lastTransferDate
              ? ` · last transfer ${property.lastTransferDate}${
                  property.yearsSinceTransfer === null
                    ? ''
                    : ` (${property.yearsSinceTransfer} yrs ago)`
                }`
              : ' · no transfer date recorded'}
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
      <h4 data-testid="permit-counts">
        {all ? 'All permits' : 'Roofing permits'} ({shown.length}): {open} open, {pending} pending,{' '}
        {shown.length - open - pending} closed
      </h4>
      {shown.length === 0 ? (
        <p className="empty-line">
          {roofing.length === 0 && !all
            ? 'No roofing permit is on record for this parcel, so the roof age rests on the assessor effective year, which the county does not offer as a year built.'
            : 'No permits on record for this parcel.'}
        </p>
      ) : (
        <ul className="permits">
          {shown.map((p) => (
            <PermitCard key={permitKey(p)} permit={p} group={groupOf(p)} />
          ))}
        </ul>
      )}
      {others > 0 ? (
        <button
          type="button"
          className="link-btn"
          data-testid="toggle-all-permits"
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show roofing permits only' : `Show ${others} other (non-roofing) permits too`}
        </button>
      ) : null}
    </div>
  );
}

function DetailLoader({ apn }: { apn: string }) {
  const { state, reload } = useResource(`property:${apn}`, async () => {
    const [property, groups] = await Promise.all([
      getProperty(apn),
      // The status group is a nicety; the detail still renders if this lookup fails.
      getPermitStatusGroups(apn).catch(() => new Map<string, string>()),
    ]);
    return { property, groups };
  });
  return (
    <ResourceView
      state={state}
      reload={reload}
      label="Loading permits and sources…"
      testId={`detail-${apn}`}
    >
      {({ property, groups }) =>
        property ? (
          <PropertyDetail property={property} statusGroups={groups} />
        ) : (
          <p className="empty-line">This parcel is no longer in the served run.</p>
        )
      }
    </ResourceView>
  );
}

function RoofAgeCell({ row }: { row: LeadRow }) {
  return (
    <td className="num">
      <strong>{row.roofAgeYears ?? '—'}</strong> yrs
      <div className="muted small">roof {row.roofYear ?? '—'}</div>
    </td>
  );
}

function TransferCell({ row, asOf }: { row: LeadRow; asOf: string }) {
  const years = yearsBetween(row.lastTransferDate, asOf);
  return (
    <td>
      <strong>{years === null ? '—' : `${years} yrs`}</strong>
      <div className="muted small">
        {row.lastTransferDate ? `last transfer ${row.lastTransferDate}` : 'no transfer recorded'}
      </div>
    </td>
  );
}

function OccupancyCell({ row }: { row: LeadRow }) {
  return (
    <td>
      {row.ownerOccupied === true ? (
        'Flagged owner-occupied'
      ) : (
        <span className="badge badge-out">Not flagged owner-occupied</span>
      )}
    </td>
  );
}

const HEADERS: Record<Tab, readonly { label: string; num?: boolean }[]> = {
  aged: [{ label: 'Roof age', num: true }, { label: 'Roof-age basis' }, { label: 'Open permits' }],
  permits: [
    { label: 'Longest open' },
    { label: 'Permit' },
    { label: 'Contractor' },
    { label: 'Licence' },
  ],
  ownership: [
    { label: 'Ownership unchanged' },
    { label: 'Owner-occupied flag' },
    { label: 'Roof age', num: true },
  ],
  outOfArea: [
    { label: 'Owner-occupied flag' },
    { label: 'Ownership unchanged' },
    { label: 'Roof age', num: true },
  ],
};

const EXPAND_LABEL: Record<Tab, string> = {
  aged: 'Sources',
  permits: 'Permits, BBB, sources',
  ownership: 'Sources',
  outOfArea: 'Sources',
};

function TabCells({ tab, row, asOf }: { tab: Tab; row: LeadRow; asOf: string }) {
  if (tab === 'aged') {
    return (
      <>
        <RoofAgeCell row={row} />
        <td>
          {roofBasisLabel(row.roofBasis)}
          <div className="muted small">confidence {row.roofConfidence ?? 'n/a'}</div>
        </td>
        <td>{row.openRoofPermits > 0 ? row.openRoofPermits : '—'}</td>
      </>
    );
  }
  if (tab === 'permits') {
    return (
      <>
        <td>
          <strong>{fmtOpenDuration(row.longestOpenDays)}</strong>
          <div className="muted small">
            {row.openRoofPermits} open roofing {row.openRoofPermits === 1 ? 'permit' : 'permits'}
          </div>
        </td>
        <td>
          <code>{row.topOpenPermitId ?? '—'}</code>
          <div>
            <span className="badge badge-permit">Open</span>
          </div>
        </td>
        <td>{row.topOpenContractor ?? <span className="muted">not listed</span>}</td>
        <td>
          {row.topOpenLicenseNo ? (
            `#${row.topOpenLicenseNo}`
          ) : (
            <span className="muted">none on permit</span>
          )}
        </td>
      </>
    );
  }
  if (tab === 'ownership') {
    return (
      <>
        <TransferCell row={row} asOf={asOf} />
        <OccupancyCell row={row} />
        <RoofAgeCell row={row} />
      </>
    );
  }
  return (
    <>
      <OccupancyCell row={row} />
      <TransferCell row={row} asOf={asOf} />
      <RoofAgeCell row={row} />
    </>
  );
}

function ResultsTable({
  tab,
  rows,
  asOf,
  expanded,
  onToggle,
}: {
  tab: Tab;
  rows: readonly LeadRow[];
  asOf: string;
  expanded: string | null;
  onToggle: (apn: string) => void;
}) {
  const headers = HEADERS[tab];
  return (
    <div className="table-scroll" tabIndex={0} role="group" aria-label="Matching properties">
      <table className="results-table" data-testid="results-table">
        <caption className="sr-only">Matching properties</caption>
        <thead>
          <tr>
            <th scope="col">Property</th>
            {headers.map((h) => (
              <th key={h.label} scope="col" className={h.num ? 'num' : undefined}>
                {h.label}
              </th>
            ))}
            <th scope="col">Coordinates</th>
            <th scope="col" className="num">
              Distance
            </th>
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
                    <span className="prop-address">{fullAddress(r.address, r.unit)}</span>
                    <span className="muted small">{[r.city, r.zip].filter(Boolean).join(' ')}</span>
                    <code className="apn" data-testid={`apn-${r.apn}`}>
                      APN {r.apn}
                    </code>
                  </th>
                  <TabCells tab={tab} row={r} asOf={asOf} />
                  <td className="coords">
                    {coord(r.lat)}, {coord(r.lon)}
                  </td>
                  <td className="num">{r.distanceMiles.toFixed(2)} mi</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-expanded={open}
                      data-testid={`expand-${r.apn}`}
                      onClick={() => onToggle(r.apn)}
                    >
                      {open ? 'Hide' : EXPAND_LABEL[tab]}
                    </button>
                  </td>
                </tr>
                {open ? (
                  <tr className="detail-row">
                    <td colSpan={headers.length + 4}>
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

export function ResultsBody({
  tab,
  data,
  search,
  expanded,
  onToggle,
  extraNote,
}: {
  tab: Tab;
  data: LeadSearch;
  search: Search;
  expanded: string | null;
  onToggle: (apn: string) => void;
  /** Live context for the tab, rendered under its note. */
  extraNote?: ReactNode;
}) {
  const [shown, setShown] = useState(PAGE_SIZE);
  const spec = TABS.find((t) => t.id === tab) ?? (TABS[0] as TabSpec);
  return (
    <div className="stack-tight">
      <p className="result-meta" data-testid="results-meta">
        <strong data-testid="results-total">
          {fmtInt(data.total)} {spec.total(search)}
        </strong>
        <span className="muted">
          within {search.radiusMiles} mi · showing {fmtInt(Math.min(shown, data.rows.length))} ·{' '}
          {spec.order} · as of {data.asOf}
        </span>
      </p>
      {spec.note ? (
        <p
          className={`notice ${tab === 'outOfArea' ? 'notice-warn' : 'notice-info'}`}
          data-testid={tab === 'outOfArea' ? 'out-of-area-note' : 'tab-note'}
        >
          {spec.note}
        </p>
      ) : null}
      {extraNote}
      {data.coverageNote ? (
        <p className="notice notice-warn" data-testid="coverage-note">
          {data.coverageNote}
        </p>
      ) : null}
      {data.rows.length === 0 ? (
        <div className="empty" data-testid="results-empty">
          <h3>No matches in this radius</h3>
          <p>{spec.empty}</p>
        </div>
      ) : (
        <>
          <ResultsTable
            tab={tab}
            rows={data.rows.slice(0, shown)}
            asOf={data.asOf}
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

export const TRANSFER_BASE_SQL =
  'SELECT count(*) FILTER (last_transfer_date IS NOT NULL AND NOT coalesce(last_transfer_ambiguous, false)) AS usable, count(*) AS total FROM parcel';

export function transferBaseSentence(usable: number, total: number): string {
  const share = total > 0 ? ((usable / total) * 100).toFixed(1) : '0';
  return `This filter can use ${fmtInt(usable)} of ${fmtInt(total)} parcels (${share}%): the rest have a transfer date whose century is uncertain, or none at all.`;
}

/** How many parcels the ownership filter can actually judge, counted live for the whole county. */
function TransferBase() {
  const { state } = useResource('transferBase', () => queryAtlas(TRANSFER_BASE_SQL));
  if (state.status === 'loading') {
    return <p className="muted small">Counting the parcels this filter can use…</p>;
  }
  if (state.status !== 'ok') {
    return (
      <p className="muted small" data-testid="transfer-base">
        The count of parcels with a usable transfer date is unavailable right now.
      </p>
    );
  }
  const row = state.data.rows[0] ?? {};
  return (
    <p className="notice notice-warn" data-testid="transfer-base">
      {transferBaseSentence(Number(row.usable), Number(row.total))}
    </p>
  );
}

export default function ExploreMap() {
  const [search, setSearch] = useState<Search>({
    center: DEFAULT_PLACE,
    radiusMiles: 1,
    minAge: 15,
    minYearsHeld: 10,
  });
  const [draft, setDraft] = useState({
    lat: String(DEFAULT_PLACE.lat),
    lon: String(DEFAULT_PLACE.lon),
    radius: '1',
    minAge: '15',
    minYearsHeld: '10',
  });
  const [tab, setTab] = useState<Tab>('aged');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const formId = useId();
  const autoExpanded = useRef<string | null>(null);
  const spec = TABS.find((t) => t.id === tab) ?? (TABS[0] as TabSpec);

  const args = leadArgs(tab, search);
  const key = `leads:${JSON.stringify(args)}`;
  const { state, reload } = useResource(key, () => findLeads(args));

  // Open the first row once per search so provenance is visible without an extra click.
  useEffect(() => {
    if (state.status !== 'ok' || autoExpanded.current === key) return;
    autoExpanded.current = key;
    setExpanded(state.data.rows[0]?.apn ?? null);
  }, [state, key]);

  const points = useMemo<MapPoint[]>(() => {
    if (state.status !== 'ok' || formError !== null) return [];
    const asOf = state.data.asOf;
    return state.data.rows.map((r) => {
      const held = yearsBetween(r.lastTransferDate, asOf);
      const what =
        tab === 'aged'
          ? `roof ${r.roofAgeYears ?? '?'} yrs`
          : tab === 'permits'
            ? `open ${fmtOpenDuration(r.longestOpenDays)}`
            : tab === 'ownership'
              ? `unchanged ${held ?? '?'} yrs`
              : 'not flagged owner-occupied';
      return {
        id: r.apn,
        lat: r.lat,
        lon: r.lon,
        color: spec.color,
        label: `${r.address ?? r.apn}: ${what}`,
      };
    });
  }, [state, tab, spec.color, formError]);

  /**
   * Starts a search. The form submits strictly: any bad field shows a message and hides the old
   * rows. A jump or a map click only supplies a point, so fields left in a bad state fall back to
   * the last good values and any earlier error is cleared.
   */
  const commit = (center: Point, strict: boolean): void => {
    const pick = (text: string, ok: (n: number) => boolean, last: number): number | null => {
      const n = Number(text);
      if (text.trim() !== '' && Number.isFinite(n) && ok(n)) return n;
      return strict ? null : last;
    };
    const radius = pick(draft.radius, (n) => n > 0 && n <= MAX_RADIUS_MILES, search.radiusMiles);
    const minAge = pick(
      draft.minAge,
      (n) => Number.isInteger(n) && n >= 0 && n <= 150,
      search.minAge,
    );
    const minYearsHeld = pick(draft.minYearsHeld, (n) => n >= 0 && n <= 120, search.minYearsHeld);
    const problem =
      !Number.isFinite(center.lat) || !Number.isFinite(center.lon)
        ? 'Latitude and longitude must be numbers, for example 32.7157 and -117.1611.'
        : !inCounty(center)
          ? 'That point is outside San Diego County (latitude 32.5 to 33.55, longitude -117.65 to -116.05).'
          : radius === null
            ? `Radius must be a number above 0 and at most ${MAX_RADIUS_MILES} miles.`
            : minAge === null
              ? 'Roof-age threshold must be a whole number of years from 0 to 150.'
              : minYearsHeld === null
                ? 'Years since the last transfer must be a number from 0 to 120.'
                : null;
    if (problem !== null || radius === null || minAge === null || minYearsHeld === null) {
      setFormError(problem);
      setExpanded(null);
      return;
    }
    setFormError(null);
    setExpanded(null);
    setDraft({
      lat: String(center.lat),
      lon: String(center.lon),
      radius: String(radius),
      minAge: String(minAge),
      minYearsHeld: String(minYearsHeld),
    });
    setSearch({ center, radiusMiles: radius, minAge, minYearsHeld });
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
          commit(
            {
              lat: draft.lat.trim() === '' ? Number.NaN : Number(draft.lat),
              lon: draft.lon.trim() === '' ? Number.NaN : Number(draft.lon),
            },
            true,
          );
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
                  onClick={() => commit(p, false)}
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
          <label className="field field-narrow">
            <span className="field-label">Ownership unchanged (years)</span>
            <input
              type="number"
              min={0}
              max={120}
              step={1}
              data-testid="input-min-years-held"
              value={draft.minYearsHeld}
              onChange={(e) => setDraft({ ...draft, minYearsHeld: e.target.value })}
            />
          </label>
          <button type="submit" className="btn btn-primary" data-testid="search-submit">
            Search this area
          </button>
        </div>
        {formError ? (
          <p className="notice notice-error" role="alert" data-testid="search-form-error">
            {formError} Nothing was searched.
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
              onPinChange={(p) => commit(round(p), false)}
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
              <span className="legend-dot" style={{ background: spec.color }} /> {spec.legend}
            </li>
          </ul>
        </div>

        <section className="card results" aria-label="Results">
          <div className="tabs tabs-wrap" role="tablist" aria-label="Result type">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={t.testId}
                aria-selected={tab === t.id}
                aria-controls="results-panel"
                data-testid={t.testId}
                onClick={() => {
                  setTab(t.id);
                  setExpanded(null);
                }}
              >
                {t.label(search)}
              </button>
            ))}
          </div>
          <div
            id="results-panel"
            role="tabpanel"
            aria-labelledby={spec.testId}
            className="results-body"
            data-testid="results-panel"
          >
            {formError !== null ? (
              <div className="empty" data-testid="results-stale">
                <h3>No results to show</h3>
                <p>
                  The search fields above are not valid, so the earlier results have been cleared.
                  Correct them and search again, or pick a place under “Jump to”.
                </p>
              </div>
            ) : (
              <>
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
                    extraNote={tab === 'ownership' ? <TransferBase /> : undefined}
                  />
                ) : null}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
