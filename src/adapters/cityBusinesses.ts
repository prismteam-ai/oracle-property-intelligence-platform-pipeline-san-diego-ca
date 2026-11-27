import { blankToNull, coordinate, isoDatePart, normalizeName, zip5 } from '../normalize.js';
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

const URL_ACTIVE = 'https://seshat.datasd.org/business_tax_certificates/sd_businesses_active_datasd.csv';

export const cityBusinesses: SourceAdapter = {
  info: {
    id: 'sdcity_businesses',
    name: 'City of San Diego active business tax certificates',
    url: 'https://data.sandiego.gov/datasets/business-listings/',
    licence:
      'City of San Diego Open Data Portal, published under the Open Data Commons Public Domain Dedication and Licence (PDDL) per the portal.',
    limits:
      'One whole-file CSV (about 19 MB); ETag is the change token. Businesses registered with the City of San Diego only; inactive files not loaded.',
    changeDetection: 'snapshot',
  },
  entities: ['business'],

  fetch: (ctx: FetchContext): Promise<FetchResult> =>
    fetchSnapshotFiles(ctx, 'sdcity_businesses', [
      { name: 'sd_businesses_active_datasd.csv', url: URL_ACTIVE },
    ]),

  async *rows(files: readonly RawFile[], ctx: ParseContext): AsyncGenerator<StagedRecord> {
    for (const file of files) {
      const malformed: StagedRecord[] = [];
      const onMalformed = (line: number, message: string): void => {
        malformed.push(reject('business', `${file.url}#line${line}`, 'csv_malformed', { line, message }));
      };
      for await (const { record } of readCsv(file, 'utf8', onMalformed)) {
        // The file writes the account number as a float ("1974000024.0").
        const key = blankToNull(record['account_key'])?.replace(/\.0$/, '') ?? null;
        if (key === null) {
          yield reject('business', null, 'account_key:missing', record);
          continue;
        }
        const dba = blankToNull(record['dba_name']);
        const owner = blankToNull(record['business_owner_name']);
        const street = [
          record['address_no'],
          record['address_no_fraction'],
          record['address_pd'],
          record['address_road'],
          record['address_sfx'],
        ]
          .map((p) => blankToNull(p))
          .filter((p): p is string => p !== null)
          .join(' ');
        const suite = blankToNull(record['address_suite']);
        const address =
          blankToNull(suite === null ? street : `${street} STE ${suite}`) ??
          blankToNull(record['address_po_box']);
        yield validate(
          ctx.entities,
          'business',
          {
            account_key: key,
            dba_name: dba,
            owner_name: owner,
            name_norm: normalizeName(dba ?? owner),
            owner_name_norm: normalizeName(owner),
            ownership_type: blankToNull(record['ownership_type']),
            status: blankToNull(record['account_status']),
            naics_code: blankToNull(record['naics_code']),
            naics_description: blankToNull(record['naics_description']),
            business_start_date: isoDatePart(record['date_business_start']),
            account_created_date: isoDatePart(record['date_account_creation']),
            cert_expiration_date: isoDatePart(record['date_cert_expiration']),
            address,
            city: blankToNull(record['address_city']),
            state: blankToNull(record['address_state']),
            zip: zip5(record['address_zip']),
            lat: coordinate(record['lat']),
            lon: coordinate(record['lng']),
          },
          { sourceRecordId: key, sourceUrl: file.url, fetchedAt: file.fetchedAt },
          record,
        );
      }
      for (const m of malformed) yield m;
    }
  },
};
