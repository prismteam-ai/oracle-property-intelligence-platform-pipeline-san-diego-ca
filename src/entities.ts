import { z } from 'zod';
import { COUNTY_BBOX, MAX_FUTURE_DATE, MIN_DATE, addDays } from './config.js';

/**
 * Canonical row contracts. Each entity has one Zod schema (the step-boundary validation every row
 * must pass before it is staged) and one column list (the DuckDB types of the stage file and table).
 * A unit test asserts the two stay in step.
 */

export type DuckType = 'VARCHAR' | 'INTEGER' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP';

export interface EntitySpec<TSchema extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly table: string;
  readonly key: readonly string[];
  readonly columns: Readonly<Record<string, DuckType>>;
  /**
   * Columns added after the first production load. They enter the row hash only when set, so adding
   * one does not make every existing row look changed on the next run.
   */
  readonly lateColumns?: readonly string[];
  readonly schema: TSchema;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fields(today: string) {
  const latestEvent = addDays(today, 1);
  const text = z.string().min(1).nullable();
  const dateBetween = (max: string) =>
    z
      .string()
      .regex(DATE_RE, 'bad_date_format')
      .refine((d) => d >= MIN_DATE, 'date_before_1900')
      .refine((d) => d <= max, 'date_in_future')
      .nullable();
  return {
    text,
    requiredText: z.string().min(1),
    apn: z.string().regex(/^\d{10}$/, 'apn_not_10_digits'),
    /** A date something already happened on: cannot be in the future. */
    eventDate: dateBetween(latestEvent),
    /** A forward-looking date such as an expiry. */
    anyDate: dateBetween(MAX_FUTURE_DATE),
    lat: z
      .number()
      .min(COUNTY_BBOX.minLat, 'lat_outside_county')
      .max(COUNTY_BBOX.maxLat, 'lat_outside_county')
      .nullable(),
    lon: z
      .number()
      .min(COUNTY_BBOX.minLon, 'lon_outside_county')
      .max(COUNTY_BBOX.maxLon, 'lon_outside_county')
      .nullable(),
    /** Businesses may legitimately sit outside the county (out-of-town firms certified to trade in the city). */
    worldLat: z.number().min(-90, 'lat_invalid').max(90, 'lat_invalid').nullable(),
    worldLon: z.number().min(-180, 'lon_invalid').max(180, 'lon_invalid').nullable(),
    /** A founding or planned start date: may predate 1900 or lie in the near future. */
    looseDate: z
      .string()
      .regex(DATE_RE, 'bad_date_format')
      .refine((d) => d >= '1700-01-01' && d <= MAX_FUTURE_DATE, 'date_out_of_range')
      .nullable(),
    year: z
      .number()
      .int()
      .min(1800, 'year_before_1800')
      .max(Number(today.slice(0, 4)), 'year_in_future')
      .nullable(),
    nonNegative: z.number().min(0, 'negative_number').nullable(),
    int: z.number().int().nullable(),
    bool: z.boolean(),
    timestamp: z.string().min(10).nullable(),
  };
}

function buildEntities(today: string) {
  const f = fields(today);

  const property = {
    name: 'property',
    table: 'property',
    key: ['apn'],
    columns: {
      apn: 'VARCHAR',
      apn_8: 'VARCHAR',
      situs_address: 'VARCHAR',
      situs_number: 'INTEGER',
      situs_street: 'VARCHAR',
      situs_unit: 'VARCHAR',
      situs_city: 'VARCHAR',
      situs_juris: 'VARCHAR',
      situs_zip: 'VARCHAR',
      lat: 'DOUBLE',
      lon: 'DOUBLE',
      year_effective_raw: 'VARCHAR',
      year_effective: 'INTEGER',
      year_ambiguous: 'BOOLEAN',
      year_rule: 'VARCHAR',
      use_code: 'VARCHAR',
      land_use: 'INTEGER',
      zone_code: 'VARCHAR',
      units: 'INTEGER',
      living_area_sqft: 'INTEGER',
      bedrooms: 'INTEGER',
      baths: 'DOUBLE',
      pool: 'BOOLEAN',
      acreage: 'DOUBLE',
      assessed_land: 'BIGINT',
      assessed_improvements: 'BIGINT',
      assessed_total: 'BIGINT',
      tax_status: 'VARCHAR',
    },
    schema: z.strictObject({
      apn: f.apn,
      apn_8: f.text,
      situs_address: f.text,
      situs_number: f.int,
      situs_street: f.text,
      situs_unit: f.text,
      situs_city: f.text,
      situs_juris: f.text,
      situs_zip: f.text,
      // A parcel without a usable coordinate cannot serve radius search, so lat/lon are required here.
      lat: f.lat.unwrap(),
      lon: f.lon.unwrap(),
      year_effective_raw: f.text,
      year_effective: f.year,
      year_ambiguous: f.bool,
      year_rule: f.requiredText,
      use_code: f.text,
      land_use: f.int,
      zone_code: f.text,
      units: f.int,
      living_area_sqft: f.int,
      bedrooms: f.int,
      baths: f.nonNegative,
      pool: z.boolean().nullable(),
      acreage: f.nonNegative,
      assessed_land: f.nonNegative,
      assessed_improvements: f.nonNegative,
      assessed_total: f.nonNegative,
      tax_status: f.text,
    }),
  } as const satisfies EntitySpec;

  const ownership = {
    name: 'ownership',
    table: 'ownership',
    key: ['apn'],
    columns: {
      apn: 'VARCHAR',
      owner_name: 'VARCHAR',
      mail_address: 'VARCHAR',
      mail_city: 'VARCHAR',
      mail_state: 'VARCHAR',
      mail_zip: 'VARCHAR',
      owner_fields_note: 'VARCHAR',
      owner_occupied: 'BOOLEAN',
      last_transfer_date_raw: 'VARCHAR',
      last_transfer_date: 'DATE',
      last_transfer_ambiguous: 'BOOLEAN',
      last_transfer_rule: 'VARCHAR',
      doc_type: 'VARCHAR',
      doc_number: 'VARCHAR',
      out_of_area: 'BOOLEAN',
      out_of_area_basis: 'VARCHAR',
    },
    schema: z.strictObject({
      apn: f.apn,
      owner_name: f.text,
      mail_address: f.text,
      mail_city: f.text,
      mail_state: f.text,
      mail_zip: f.text,
      owner_fields_note: f.requiredText,
      owner_occupied: f.bool,
      last_transfer_date_raw: f.text,
      last_transfer_date: f.eventDate,
      last_transfer_ambiguous: f.bool,
      last_transfer_rule: f.requiredText,
      doc_type: f.text,
      doc_number: f.text,
      out_of_area: f.bool,
      out_of_area_basis: f.requiredText,
    }),
  } as const satisfies EntitySpec;

  const permit = {
    name: 'permit',
    table: 'permit',
    key: ['permit_uid'],
    columns: {
      permit_uid: 'VARCHAR',
      source_permit_id: 'VARCHAR',
      jurisdiction: 'VARCHAR',
      apn: 'VARCHAR',
      apn_raw: 'VARCHAR',
      permit_type: 'VARCHAR',
      permit_subtype: 'VARCHAR',
      description: 'VARCHAR',
      project_title: 'VARCHAR',
      roofing_class: 'VARCHAR',
      is_roofing: 'BOOLEAN',
      roofing_rule: 'VARCHAR',
      status: 'VARCHAR',
      status_group: 'VARCHAR',
      is_open: 'BOOLEAN',
      applied_date: 'DATE',
      issued_date: 'DATE',
      closed_date: 'DATE',
      expire_date: 'DATE',
      valuation: 'DOUBLE',
      holder_name: 'VARCHAR',
      holder_name_norm: 'VARCHAR',
      address: 'VARCHAR',
      city: 'VARCHAR',
      zip: 'VARCHAR',
      lat: 'DOUBLE',
      lon: 'DOUBLE',
      source_updated_at: 'TIMESTAMP',
      coord_note: 'VARCHAR',
      status_as_of: 'DATE',
    },
    lateColumns: ['coord_note', 'status_as_of'],
    schema: z.strictObject({
      permit_uid: f.requiredText,
      source_permit_id: f.requiredText,
      jurisdiction: f.requiredText,
      apn: f.apn.nullable(),
      apn_raw: f.text,
      permit_type: f.text,
      permit_subtype: f.text,
      description: f.text,
      project_title: f.text,
      roofing_class: z.enum(['reroof', 'roof repair', 'roof structural', 'solar-on-roof', 'other']),
      is_roofing: f.bool,
      roofing_rule: f.text,
      status: f.text,
      status_group: z.enum(['open', 'pending', 'completed', 'expired', 'cancelled', 'other']),
      is_open: f.bool,
      applied_date: f.eventDate,
      issued_date: f.eventDate,
      closed_date: f.eventDate,
      expire_date: f.anyDate,
      valuation: f.nonNegative,
      holder_name: f.text,
      holder_name_norm: f.text,
      address: f.text,
      city: f.text,
      zip: f.text,
      lat: f.lat,
      lon: f.lon,
      source_updated_at: f.timestamp,
      // Why a coordinate the source supplied was discarded (the permit itself is kept).
      coord_note: f.text,
      // For frozen snapshots: the date the status was true. Null means "as of fetched_at".
      status_as_of: f.eventDate,
    }),
  } as const satisfies EntitySpec;

  const permitStatus = {
    name: 'permit_status',
    table: 'permit_status_history',
    key: ['permit_uid', 'status_id'],
    columns: {
      permit_uid: 'VARCHAR',
      status_id: 'VARCHAR',
      status: 'VARCHAR',
      mapped_status: 'VARCHAR',
      status_date: 'DATE',
    },
    schema: z.strictObject({
      permit_uid: f.requiredText,
      status_id: f.requiredText,
      status: f.requiredText,
      mapped_status: f.text,
      status_date: f.eventDate.unwrap(),
    }),
  } as const satisfies EntitySpec;

  const permitContractorRecord = {
    name: 'permit_contractor_record',
    table: 'permit_contractor_record',
    key: ['permit_uid', 'contractor_id'],
    columns: {
      permit_uid: 'VARCHAR',
      contractor_id: 'VARCHAR',
      license_no: 'VARCHAR',
      license_raw: 'VARCHAR',
      license_state: 'VARCHAR',
      company_name: 'VARCHAR',
      name_norm: 'VARCHAR',
      person_name: 'VARCHAR',
      trade: 'VARCHAR',
      phone: 'VARCHAR',
      address: 'VARCHAR',
      city: 'VARCHAR',
      state: 'VARCHAR',
      zip: 'VARCHAR',
      source_updated_at: 'TIMESTAMP',
    },
    schema: z.strictObject({
      permit_uid: f.requiredText,
      contractor_id: f.requiredText,
      license_no: f.text,
      license_raw: f.text,
      license_state: f.text,
      company_name: f.text,
      name_norm: f.text,
      person_name: f.text,
      trade: f.text,
      phone: f.text,
      address: f.text,
      city: f.text,
      state: f.text,
      zip: f.text,
      source_updated_at: f.timestamp,
    }),
  } as const satisfies EntitySpec;

  const cslbLicense = {
    name: 'cslb_license',
    table: 'cslb_license',
    key: ['license_no'],
    columns: {
      license_no: 'VARCHAR',
      business_name: 'VARCHAR',
      name_norm: 'VARCHAR',
      full_business_name: 'VARCHAR',
      address: 'VARCHAR',
      city: 'VARCHAR',
      state: 'VARCHAR',
      county: 'VARCHAR',
      zip: 'VARCHAR',
      phone: 'VARCHAR',
      business_type: 'VARCHAR',
      issue_date: 'DATE',
      expiration_date: 'DATE',
      primary_status: 'VARCHAR',
      secondary_status: 'VARCHAR',
      classifications: 'VARCHAR',
      is_c39: 'BOOLEAN',
      workers_comp_type: 'VARCHAR',
      bond_surety: 'VARCHAR',
      source_updated_on: 'DATE',
    },
    schema: z.strictObject({
      license_no: z.string().regex(/^\d{1,8}$/, 'license_not_numeric'),
      business_name: f.requiredText,
      name_norm: f.text,
      full_business_name: f.text,
      address: f.text,
      city: f.text,
      state: f.text,
      county: f.text,
      zip: f.text,
      phone: f.text,
      business_type: f.text,
      issue_date: f.eventDate,
      expiration_date: f.anyDate,
      primary_status: f.text,
      secondary_status: f.text,
      classifications: f.text,
      is_c39: f.bool,
      workers_comp_type: f.text,
      bond_surety: f.text,
      source_updated_on: f.eventDate,
    }),
  } as const satisfies EntitySpec;

  const contractor = {
    name: 'contractor',
    table: 'contractor',
    key: ['contractor_id'],
    columns: {
      contractor_id: 'VARCHAR',
      license_no: 'VARCHAR',
      name: 'VARCHAR',
      name_norm: 'VARCHAR',
      license_status: 'VARCHAR',
      classifications: 'VARCHAR',
      is_c39: 'BOOLEAN',
      address: 'VARCHAR',
      city: 'VARCHAR',
      state: 'VARCHAR',
      zip: 'VARCHAR',
      county: 'VARCHAR',
      phone: 'VARCHAR',
      in_cslb_master: 'BOOLEAN',
      in_county_permits: 'BOOLEAN',
      identity_basis: 'VARCHAR',
    },
    // Built in SQL from already-validated tables (see reconcile.ts), so this schema documents the shape.
    schema: z.strictObject({
      contractor_id: f.requiredText,
      license_no: f.text,
      name: f.text,
      name_norm: f.text,
      license_status: f.text,
      classifications: f.text,
      is_c39: z.boolean().nullable(),
      address: f.text,
      city: f.text,
      state: f.text,
      zip: f.text,
      county: f.text,
      phone: f.text,
      in_cslb_master: f.bool,
      in_county_permits: f.bool,
      identity_basis: f.requiredText,
    }),
  } as const satisfies EntitySpec;

  const business = {
    name: 'business',
    table: 'business',
    key: ['account_key'],
    columns: {
      account_key: 'VARCHAR',
      dba_name: 'VARCHAR',
      owner_name: 'VARCHAR',
      name_norm: 'VARCHAR',
      owner_name_norm: 'VARCHAR',
      ownership_type: 'VARCHAR',
      status: 'VARCHAR',
      naics_code: 'VARCHAR',
      naics_description: 'VARCHAR',
      business_start_date: 'DATE',
      account_created_date: 'DATE',
      cert_expiration_date: 'DATE',
      address: 'VARCHAR',
      city: 'VARCHAR',
      state: 'VARCHAR',
      zip: 'VARCHAR',
      lat: 'DOUBLE',
      lon: 'DOUBLE',
    },
    schema: z.strictObject({
      account_key: f.requiredText,
      dba_name: f.text,
      owner_name: f.text,
      name_norm: f.text,
      owner_name_norm: f.text,
      ownership_type: f.text,
      status: f.text,
      naics_code: f.text,
      naics_description: f.text,
      business_start_date: f.looseDate,
      account_created_date: f.eventDate,
      cert_expiration_date: f.anyDate,
      address: f.text,
      city: f.text,
      state: f.text,
      zip: f.text,
      lat: f.worldLat,
      lon: f.worldLon,
    }),
  } as const satisfies EntitySpec;

  return {
    property,
    ownership,
    permit,
    permitStatus,
    permitContractorRecord,
    cslbLicense,
    contractor,
    business,
  };
}

export type Entities = ReturnType<typeof buildEntities>;
export type EntityKey = keyof Entities;
export type RowOf<K extends EntityKey> = z.infer<Entities[K]['schema']>;

/** `today` (YYYY-MM-DD) is injected so "not in the future" checks are deterministic in tests. */
export function makeEntities(today: string): Entities {
  return buildEntities(today);
}

export const ENTITY_KEYS: readonly EntityKey[] = [
  'property',
  'ownership',
  'permit',
  'permitStatus',
  'permitContractorRecord',
  'cslbLicense',
  'contractor',
  'business',
];

/** Provenance columns carried by every data row. */
export const PROVENANCE_COLUMNS: Readonly<Record<string, DuckType>> = {
  source_id: 'VARCHAR',
  source_record_id: 'VARCHAR',
  source_url: 'VARCHAR',
  fetched_at: 'TIMESTAMP',
  first_seen_run: 'INTEGER',
  last_seen_run: 'INTEGER',
  row_hash: 'VARCHAR',
};
