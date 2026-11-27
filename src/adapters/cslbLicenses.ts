import { blankToNull, normalizeLicense, normalizeName, usDate, zip5 } from '../normalize.js';
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

const URL_MASTER =
  'https://www.cslb.ca.gov/onlineservices/dataportal/DownLoadFile.ashx?fName=MasterLicenseData&type=C';

/** "C-39", "C39 ", "C39| B" all describe the same classification list; store it as `B|C39`. */
export function normalizeClassifications(raw: string | null | undefined): string | null {
  const value = blankToNull(raw);
  if (value === null) return null;
  const codes = value
    .toUpperCase()
    .split(/[|,;\s]+/)
    .map((c) => c.replace(/-/g, '').trim())
    .filter((c) => c !== '');
  return codes.length === 0 ? null : [...new Set(codes)].sort().join('|');
}

export const cslbLicenses: SourceAdapter = {
  info: {
    id: 'cslb_license_master',
    name: 'California CSLB licence master (statewide)',
    url: 'https://www.cslb.ca.gov/onlineservices/dataportal/ContractorList.aspx',
    licence:
      'California Contractors State License Board public data portal. Public record; no email addresses (Business and Professions Code s.27).',
    limits:
      'One CSV of about 78 MB served slowly (about 0.5 MB/s measured). The portal form postback is blocked by its firewall for scripts (HTTP 503); the direct download handler behind the form works. Only renewed or renewable licences are listed.',
    changeDetection: 'snapshot',
  },
  entities: ['cslbLicense'],

  fetch: (ctx: FetchContext): Promise<FetchResult> =>
    // If the handler sends no ETag or Last-Modified, the file is simply downloaded once per run date.
    fetchSnapshotFiles(ctx, 'cslb_license_master', [{ name: 'MasterLicenseData.csv', url: URL_MASTER }]),

  async *rows(files: readonly RawFile[], ctx: ParseContext): AsyncGenerator<StagedRecord> {
    for (const file of files) {
      const malformed: StagedRecord[] = [];
      const onMalformed = (line: number, message: string): void => {
        malformed.push(reject('cslbLicense', `${file.url}#line${line}`, 'csv_malformed', { line, message }));
      };
      for await (const { record } of readCsv(file, 'latin1', onMalformed)) {
        const licenseRaw = blankToNull(record['LicenseNo']);
        const license = normalizeLicense(licenseRaw);
        if (license === null) {
          yield reject('cslbLicense', licenseRaw, 'license_no:license_not_numeric', record);
          continue;
        }
        const name = blankToNull(record['BusinessName']);
        const classifications = normalizeClassifications(record['Classifications(s)']);
        yield validate(
          ctx.entities,
          'cslbLicense',
          {
            license_no: license,
            business_name: name,
            name_norm: normalizeName(name),
            full_business_name: blankToNull(record['FullBusinessName']),
            address: blankToNull(record['MailingAddress']),
            city: blankToNull(record['City']),
            state: blankToNull(record['State']),
            county: blankToNull(record['County']),
            zip: zip5(record['ZIPCode']),
            phone: blankToNull(record['BusinessPhone']),
            business_type: blankToNull(record['BusinessType']),
            issue_date: usDate(record['IssueDate']),
            expiration_date: usDate(record['ExpirationDate']),
            primary_status: blankToNull(record['PrimaryStatus']),
            secondary_status: blankToNull(record['SecondaryStatus']),
            classifications,
            is_c39: classifications !== null && classifications.split('|').includes('C39'),
            workers_comp_type: blankToNull(record['WorkersCompCoverageType']),
            bond_surety: blankToNull(record['CBSuretyCompany']),
            source_updated_on: usDate(record['LastUpdate']),
          },
          {
            sourceRecordId: license,
            sourceUrl: `https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx?LicNum=${license}`,
            fetchedAt: file.fetchedAt,
          },
          record,
        );
      }
      for (const m of malformed) yield m;
    }
  },
};
