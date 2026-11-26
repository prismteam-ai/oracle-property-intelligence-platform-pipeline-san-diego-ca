import {
  blankToNull,
  cityPermitHolder,
  countyCoordinate,
  isoDatePart,
  normalizeApn,
  toNumber,
  truncate,
} from '../normalize.js';
import { classifyPermitRoofing } from '../roofing.js';
import type { StatusGroup } from './countySocrata.js';
import { fetchSnapshotFiles, readCsv } from './shared.js';
import type {
  FetchContext,
  FetchResult,
  ParseContext,
  RawFile,
  SourceAdapter,
  StagedRecord,
} from './types.js';
import { reject, validate } from './types.js';

const BASE = 'https://seshat.datasd.org/development_permits';
const FILES = [
  { name: 'approvals_active_datasd.csv', url: `${BASE}/approvals_active_datasd.csv` },
  { name: 'approvals_closed_datasd.csv', url: `${BASE}/approvals_closed_datasd.csv` },
] as const;

export const CITY_PERMIT_PREFIX = 'sdcity:';

/** City of San Diego (Accela / legacy PTS) approval statuses, grouped. */
export function cityStatusGroup(status: string | null): StatusGroup {
  const s = (status ?? '').toUpperCase();
  if (s === '') return 'other';
  if (/CANCEL|WITHDRAW|DENIED|VOID|REVOKED|REJECT/.test(s)) return 'cancelled';
  if (s.includes('EXPIRED')) return 'expired';
  // "Approved Upon Final Payment" and "Review Phase Complete" are pre-issuance steps, not completion.
  if (/^(?:COMPLETED|CLOSED|FINAL CLOSED|FINALED)$/.test(s)) return 'completed';
  if (/^ISSUED|^INSPECT/.test(s)) return 'open';
  // Everything else is a step before issuance: Created, Opened, Open, In Review, Pending Invoice
  // Payment, Recheck Required and so on. Of 22,249 "Opened" records, 13 have an issue date.
  return 'pending';
}

function dateField(
  record: Readonly<Record<string, string>>,
  key: string,
): { value: string | null; bad: boolean } {
  const raw = blankToNull(record[key]);
  const value = isoDatePart(raw);
  return { value, bad: raw !== null && value === null };
}

export const cityPermits: SourceAdapter = {
  info: {
    id: 'sdcity_permits',
    name: 'City of San Diego development permit approvals (active and closed)',
    url: 'https://data.sandiego.gov/datasets/development-permits-set2/',
    licence:
      'City of San Diego Open Data Portal, published under the Open Data Commons Public Domain Dedication and Licence (PDDL) per the portal.',
    limits:
      'Two whole-file CSVs (about 270 MB and 410 MB), refreshed daily; no row-level change feed, so the HTTP ETag is the change token and row hashes find the changed rows. City limits only.',
    changeDetection: 'snapshot',
  },
  entities: ['permit'],

  fetch: (ctx: FetchContext): Promise<FetchResult> => fetchSnapshotFiles(ctx, 'sdcity_permits', FILES),

  async *rows(files: readonly RawFile[], ctx: ParseContext): AsyncGenerator<StagedRecord> {
    for (const [fileIndex, file] of files.entries()) {
      const malformed: StagedRecord[] = [];
      const onMalformed = (line: number, message: string): void => {
        malformed.push(reject('permit', `${file.url}#line${line}`, 'csv_malformed', { line, message }));
      };
      for await (const { record } of readCsv(file, 'utf8', onMalformed)) {
        const id = blankToNull(record['APPROVAL_ID']);
        if (id === null) {
          yield reject('permit', null, 'source_permit_id:missing', record);
          continue;
        }
        const applied = dateField(record, 'APPROVAL_CREATE_DATE');
        const issued = dateField(record, 'APPROVAL_ISSUE_DATE');
        const closed = dateField(record, 'APPROVAL_CLOSE_DATE');
        const expire = dateField(record, 'APPROVAL_EXPIRE_DATE');
        const badDate = Object.entries({
          applied_date: applied,
          issued_date: issued,
          closed_date: closed,
          expire_date: expire,
        }).find(([, d]) => d.bad);
        if (badDate !== undefined) {
          yield reject('permit', id, `${badDate[0]}:bad_date_format`, record);
          continue;
        }
        const type = blankToNull(record['APPROVAL_TYPE']);
        const scope = blankToNull(record['APPROVAL_SCOPE']) ?? blankToNull(record['PROJECT_SCOPE']);
        const title = blankToNull(record['PROJECT_TITLE']);
        const roofing = classifyPermitRoofing(type, title, scope);
        const status = blankToNull(record['APPROVAL_STATUS']);
        const group = cityStatusGroup(status);
        const holder = cityPermitHolder(record['APPROVAL_PERMIT_HOLDER']);
        const apnRaw = blankToNull(record['GIS_APN']);
        const located = countyCoordinate(record['GIS_LATITUDE'], record['GIS_LONGITUDE']);
        yield validate(
          ctx.entities,
          'permit',
          {
            permit_uid: `${CITY_PERMIT_PREFIX}${id}`,
            source_permit_id: id,
            jurisdiction: 'City of San Diego',
            apn: normalizeApn(apnRaw),
            apn_raw: apnRaw,
            permit_type: type,
            permit_subtype: blankToNull(record['JOB_BC_CODE_DESCRIPTION']),
            description: truncate(scope, 2000),
            project_title: truncate(title, 500),
            roofing_class: roofing.roofingClass,
            is_roofing: roofing.isRoofing,
            roofing_rule: roofing.rule,
            status,
            status_group: group,
            is_open: group === 'open',
            applied_date: applied.value,
            issued_date: issued.value,
            closed_date: closed.value,
            expire_date: expire.value,
            valuation: toNumber(record['APPROVAL_VALUATION']),
            holder_name: holder.name,
            holder_name_norm: holder.nameNorm,
            address: blankToNull(record['GIS_ADDRESS']),
            city: 'SAN DIEGO',
            zip: null,
            lat: located.lat,
            lon: located.lon,
            source_updated_at: null,
            coord_note: located.note,
            status_as_of: null,
          },
          // The closed file outranks the active file if an approval appears in both.
          { sourceRecordId: id, sourceUrl: file.url, fetchedAt: file.fetchedAt, rank: fileIndex },
          record,
        );
        while (malformed.length > 0) {
          const m = malformed.shift();
          if (m !== undefined) yield m;
        }
      }
      for (const m of malformed) yield m;
    }
  },
};
