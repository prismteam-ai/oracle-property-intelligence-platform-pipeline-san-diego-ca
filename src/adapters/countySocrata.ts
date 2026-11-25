import { z } from 'zod';
import {
  blankToNull,
  countyCoordinate,
  isoDatePart,
  normalizeApn,
  normalizeLicense,
  normalizeName,
  toNumber,
  truncate,
  zip5,
} from '../normalize.js';
import { classifyPermitRoofing } from '../roofing.js';
import { fetchSocrata, readSocrataPages, str } from './shared.js';
import type {
  FetchContext,
  FetchResult,
  ParseContext,
  RawFile,
  SourceAdapter,
  StagedRecord,
} from './types.js';
import { reject, validate } from './types.js';

const BASE = 'https://data.sandiegocounty.gov/resource';
const LICENCE =
  'County of San Diego open data portal (Socrata), public, no login or app token used. No licence is declared on the dataset.';
const LIMITS =
  'SODA paging with $limit/$offset (50,000 rows per page used); anonymous requests share a throttled pool. Covers unincorporated county only.';

export const COUNTY_PERMIT_PREFIX = 'sdcounty:';

/**
 * One meaning per group, the same in every source:
 *  - `open`      issued, work not finalled. The only group with `is_open = true`.
 *  - `pending`   applied for but not yet issued (in review, awaiting payment, plan check).
 *  - `completed` finalled or closed.
 *  - `expired`   lapsed without a final.
 *  - `cancelled` cancelled, withdrawn, denied, void or revoked.
 *  - `other`     the source gave no status.
 */
export type StatusGroup = 'open' | 'pending' | 'completed' | 'expired' | 'cancelled' | 'other';

/**
 * County (Accela) record statuses, grouped. "Open" here means the application is open: only 3 of
 * 1,450 such records have an issue date, so it is `pending`, as is "PC About to Expire" (plan check).
 */
export function countyStatusGroup(status: string | null): StatusGroup {
  const s = (status ?? '').toUpperCase();
  if (s === '') return 'other';
  if (s === 'COMPLETED' || s === 'DONE') return 'completed';
  if (s.includes('EXPIRED') || s === 'EXPR') return 'expired';
  if (/VOID|WITHDRAWN|CANCEL|CNCL|REVOKED/.test(s)) return 'cancelled';
  if (s.startsWith('ISSUED')) return 'open';
  return 'pending';
}

const Point = z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) });

function timestamp(raw: string | null): string | null {
  const value = blankToNull(raw);
  return value !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)
    ? value.slice(0, 19).replace('T', ' ')
    : null;
}

/** A date that is present but unreadable is a reject; an absent date is simply null. */
function dateField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): { value: string | null; bad: boolean } {
  const raw = blankToNull(str(record, key));
  const value = isoDatePart(raw);
  return { value, bad: raw !== null && value === null };
}

function socrataAdapter(
  spec: {
    readonly id: string;
    readonly name: string;
    readonly resource: string;
    readonly changeColumn: string;
    readonly entity: 'permit' | 'permitStatus' | 'permitContractorRecord';
  },
  toRecords: (record: Record<string, unknown>, file: RawFile, ctx: ParseContext) => StagedRecord,
): SourceAdapter {
  const resourceUrl = `${BASE}/${spec.resource}.json`;
  return {
    info: {
      id: spec.id,
      name: spec.name,
      url: `https://data.sandiegocounty.gov/d/${spec.resource}`,
      licence: LICENCE,
      limits: `${LIMITS} Incremental cursor: ${spec.changeColumn}.`,
      changeDetection: 'cursor',
    },
    entities: [spec.entity],
    fetch: (ctx: FetchContext): Promise<FetchResult> =>
      fetchSocrata(ctx, {
        sourceId: spec.id,
        resourceUrl,
        changeColumn: spec.changeColumn,
        pageSize: 50_000,
      }),
    async *rows(files: readonly RawFile[], ctx: ParseContext): AsyncGenerator<StagedRecord> {
      for await (const { record, file } of readSocrataPages(files)) yield toRecords(record, file, ctx);
    },
  };
}

export const countyPermits: SourceAdapter = socrataAdapter(
  {
    id: 'sdcounty_permits',
    name: 'County of San Diego building permits (unincorporated)',
    resource: 'red2-qccu',
    changeColumn: 'last_updated',
    entity: 'permit',
  },
  (record, file, ctx) => {
    const id = blankToNull(str(record, 'record_id'));
    if (id === null) return reject('permit', null, 'source_permit_id:missing', record);
    const applied = dateField(record, 'open_date');
    const issued = dateField(record, 'issued_date');
    if (applied.bad || issued.bad)
      return reject(
        'permit',
        id,
        applied.bad ? 'applied_date:bad_date_format' : 'issued_date:bad_date_format',
        record,
      );
    const point = Point.safeParse(record['geo_reference']);
    const located = countyCoordinate(
      point.success ? point.data.coordinates[1] : null,
      point.success ? point.data.coordinates[0] : null,
    );
    const description = blankToNull(str(record, 'use'));
    const scope = blankToNull(str(record, 'primary_scope_code'));
    const category = blankToNull(str(record, 'record_category'));
    const roofing = classifyPermitRoofing(category, scope, description);
    const status = blankToNull(str(record, 'record_status'));
    const group = countyStatusGroup(status);
    const holder = blankToNull(str(record, 'contractor_name'));
    const apnRaw = blankToNull(str(record, 'parcel_number'));
    return validate(
      ctx.entities,
      'permit',
      {
        permit_uid: `${COUNTY_PERMIT_PREFIX}${id}`,
        source_permit_id: id,
        jurisdiction: 'County of San Diego (unincorporated)',
        apn: normalizeApn(apnRaw),
        apn_raw: apnRaw,
        permit_type: category,
        permit_subtype: scope,
        description: truncate(description, 2000),
        project_title: null,
        roofing_class: roofing.roofingClass,
        is_roofing: roofing.isRoofing,
        roofing_rule: roofing.rule,
        status,
        status_group: group,
        is_open: group === 'open',
        applied_date: applied.value,
        issued_date: issued.value,
        closed_date: null,
        expire_date: null,
        valuation: toNumber(str(record, 'valuation')),
        holder_name: holder,
        holder_name_norm: normalizeName(holder),
        address: blankToNull(str(record, 'street_address')),
        city: blankToNull(str(record, 'city')),
        zip: zip5(str(record, 'zip_code')),
        lat: located.lat,
        lon: located.lon,
        source_updated_at: timestamp(str(record, 'last_updated')),
        coord_note: located.note,
        status_as_of: null,
      },
      {
        sourceRecordId: id,
        sourceUrl: `${BASE}/red2-qccu.json?record_id=${encodeURIComponent(id)}`,
        fetchedAt: file.fetchedAt,
      },
      record,
    );
  },
);

export const countyPermitStatus: SourceAdapter = socrataAdapter(
  {
    id: 'sdcounty_permit_status',
    name: 'County of San Diego building permits: status history',
    resource: 'beua-23q8',
    changeColumn: 'status_date',
    entity: 'permitStatus',
  },
  (record, file, ctx) => {
    const permit = blankToNull(str(record, 'permit_number'));
    const statusId = blankToNull(str(record, 'status_id'));
    const recordId = permit !== null && statusId !== null ? `${permit}#${statusId}` : null;
    if (permit === null || statusId === null)
      return reject('permitStatus', recordId, 'permit_uid:missing_key', record);
    const date = dateField(record, 'status_date');
    if (date.bad) return reject('permitStatus', recordId, 'status_date:bad_date_format', record);
    return validate(
      ctx.entities,
      'permitStatus',
      {
        permit_uid: `${COUNTY_PERMIT_PREFIX}${permit}`,
        status_id: statusId,
        status: blankToNull(str(record, 'status')),
        mapped_status: blankToNull(str(record, 'mapped_status')),
        status_date: date.value,
      },
      {
        sourceRecordId: `${permit}#${statusId}`,
        sourceUrl: `${BASE}/beua-23q8.json?status_id=${encodeURIComponent(statusId)}`,
        fetchedAt: file.fetchedAt,
      },
      record,
    );
  },
);

export const countyPermitContractors: SourceAdapter = socrataAdapter(
  {
    id: 'sdcounty_permit_contractors',
    name: 'County of San Diego building permits: contractors',
    resource: '4ju2-mf55',
    changeColumn: 'last_updated',
    entity: 'permitContractorRecord',
  },
  (record, file, ctx) => {
    const permit = blankToNull(str(record, 'permit_number'));
    if (permit === null) return reject('permitContractorRecord', null, 'permit_uid:missing_key', record);
    // The publisher's column really is spelled "constractor_company_name".
    const company = blankToNull(str(record, 'constractor_company_name'));
    const person = blankToNull(str(record, 'contractor_full_name'));
    const licenseRaw = blankToNull(str(record, 'contractor_license_number'));
    const licenseState = blankToNull(str(record, 'contractor_license_state'));
    const trade = blankToNull(str(record, 'contractor_trade'));
    // Only a CSLB licence identifies a California contractor; other trades (engineers, architects) key on name.
    const license =
      trade === 'CSLB Contractor' && (licenseState === null || licenseState === 'CA')
        ? normalizeLicense(licenseRaw)
        : null;
    const nameNorm = normalizeName(company ?? person);
    const contractorId = license !== null ? `CSLB:${license}` : nameNorm !== null ? `NAME:${nameNorm}` : null;
    const recordId = `${permit}#${licenseRaw ?? company ?? ''}`;
    if (contractorId === null)
      return reject('permitContractorRecord', recordId, 'contractor_id:no_license_and_no_name', record);
    const address = [
      blankToNull(str(record, 'contractor_address_1')),
      blankToNull(str(record, 'contractor_address_2')),
    ]
      .filter((p): p is string => p !== null)
      .join(', ');
    return validate(
      ctx.entities,
      'permitContractorRecord',
      {
        permit_uid: `${COUNTY_PERMIT_PREFIX}${permit}`,
        contractor_id: contractorId,
        license_no: license,
        license_raw: licenseRaw,
        license_state: licenseState,
        company_name: company,
        name_norm: nameNorm,
        person_name: person,
        trade,
        phone: blankToNull(str(record, 'contractor_phone')),
        address: blankToNull(address),
        city: blankToNull(str(record, 'contractor_city')),
        state: blankToNull(str(record, 'contractor_state')),
        zip: zip5(str(record, 'contractor_zip_code')),
        source_updated_at: timestamp(str(record, 'last_updated')),
      },
      {
        sourceRecordId: recordId,
        sourceUrl: `${BASE}/4ju2-mf55.json?permit_number=${encodeURIComponent(permit)}`,
        fetchedAt: file.fetchedAt,
      },
      record,
    );
  },
);
