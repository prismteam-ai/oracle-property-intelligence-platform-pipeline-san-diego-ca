/**
 * Records the small offline test fixtures from the live sources. Every fixture row is a real record,
 * copied unmodified. Needs the network, and the big CSVs already downloaded by a pipeline run:
 *
 *   npx tsx scripts/record-fixtures.ts data/raw/<...>/<run-date>
 *
 * Tests never run this; they read what it wrote under test/fixtures/.
 */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse';
import { z } from 'zod';
import { USER_AGENT } from '../src/config.js';

const OUT = path.resolve('test/fixtures');
const Records = z.array(z.record(z.string(), z.unknown()));
const CsvRow = z.record(z.string(), z.string());

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function save(relative: string, body: string): Promise<void> {
  const dest = path.join(OUT, relative);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, body, 'utf8');
  process.stdout.write(`wrote ${relative} (${body.length} bytes)\n`);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function toCsv(rows: readonly Readonly<Record<string, string>>[], quoteAll: boolean): string {
  const header = Object.keys(rows[0] ?? {});
  const cell = (v: string): string => (quoteAll || /[",\n\r]/.test(v) ? csvCell(v) : v);
  return `${[header.map(cell).join(','), ...rows.map((r) => header.map((h) => cell(r[h] ?? '')).join(','))].join('\n')}\n`;
}

/** Streams a big CSV and keeps the first `limit` rows matching each named predicate. */
async function sampleCsv(
  file: string,
  encoding: BufferEncoding,
  picks: readonly {
    readonly limit: number;
    readonly test: (row: Readonly<Record<string, string>>) => boolean;
  }[],
): Promise<Record<string, string>[]> {
  const taken = picks.map(() => 0);
  const out: Record<string, string>[] = [];
  const parser = createReadStream(file, { encoding }).pipe(
    parse({ columns: true, bom: true, relax_quotes: true }),
  );
  for await (const item of parser) {
    const row = CsvRow.parse(item);
    const i = picks.findIndex((p, index) => (taken[index] ?? 0) < p.limit && p.test(row));
    if (i >= 0) {
      taken[i] = (taken[i] ?? 0) + 1;
      out.push(row);
    }
    if (picks.every((p, index) => (taken[index] ?? 0) >= p.limit)) break;
  }
  return out;
}

async function findFile(root: string, name: string): Promise<string> {
  for (const entry of await readdir(root, { recursive: true })) {
    if (path.basename(entry) === name) return path.join(root, entry);
  }
  throw new Error(`${name} not found under ${root}; run the pipeline first`);
}

async function socrata(resource: string, params: Record<string, string>): Promise<Record<string, unknown>[]> {
  const url = `https://data.sandiegocounty.gov/resource/${resource}.json?${new URLSearchParams(params).toString()}`;
  return Records.parse(await getJson(url));
}

function text(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function inList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
}

async function main(): Promise<void> {
  const rawRoot = path.resolve(process.argv[2] ?? 'data/raw');

  // County permits around Spring Valley (91977): reroofs, roof-mounted solar, and unrelated work.
  const reroofWhere = "(upper(use) like '%REROOF%' OR upper(use) like '%RE-ROOF%')";
  const permits = [
    ...(await socrata('red2-qccu', {
      $where: `zip_code='91977' AND ${reroofWhere}`,
      $order: 'record_id',
      $limit: '60',
    })),
    ...(await socrata('red2-qccu', {
      $where: `zip_code='91977' AND upper(primary_scope_code) like '%SOLAR%'`,
      $order: 'record_id DESC',
      $limit: '25',
    })),
    ...(await socrata('red2-qccu', {
      $where: `zip_code='91977' AND NOT upper(use) like '%ROOF%'`,
      $order: 'record_id DESC',
      $limit: '25',
    })),
    // Long-open reroofs anywhere in the unincorporated county.
    ...(await socrata('red2-qccu', {
      $where: `record_status in ('Issued','Issued About to Expire') AND ${reroofWhere} AND issued_date < '2024-01-01'`,
      $order: 'issued_date',
      $limit: '12',
    })),
  ];
  const byId = new Map(permits.map((p) => [text(p, 'record_id'), p]));
  const unique = [...byId.values()];
  await save('sdcounty_permits/permits.json', JSON.stringify(unique, null, 1));
  const ids = [...byId.keys()];
  await save(
    'sdcounty_permit_status/status.json',
    JSON.stringify(
      await socrata('beua-23q8', {
        $where: `permit_number in (${inList(ids)})`,
        $order: 'status_id',
        $limit: '5000',
      }),
      null,
      1,
    ),
  );
  const contractors = await socrata('4ju2-mf55', {
    $where: `permit_number in (${inList(ids)})`,
    $order: ':id',
    $limit: '5000',
  });
  await save(
    'sdcounty_permit_contractors/contractors.json',
    JSON.stringify(
      contractors.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'contractor_email'))),
      null,
      1,
    ),
  );

  // Parcels for those permits, plus the neighbourhood around one of them, plus two real keyless rows.
  const LAYER = 'https://geo.sandag.org/server/rest/services/Hosted/Parcels/FeatureServer/0';
  const outFields =
    'objectid,apn,apn_8,situs_juris,situs_street,situs_suffix,situs_post_dir,situs_pre_dir,situs_address,situs_fraction,situs_suite,situs_community,situs_zip,year_effective,docdate,doctype,docnmbr,ownerocc,asr_land,asr_impr,asr_total,acreage,nucleus_use_cd,asr_landuse,nucleus_zone_cd,unitqty,total_lvg_area,bedrooms,baths,pool,taxstat,SHAPE__Area';
  const Features = z.object({ features: z.array(z.record(z.string(), z.unknown())) });
  const query = async (where: string, limit: number): Promise<Record<string, unknown>[]> =>
    Features.parse(
      await getJson(
        `${LAYER}/query?${new URLSearchParams({ where, outFields, returnGeometry: 'false', returnCentroid: 'true', outSR: '4326', resultRecordCount: String(limit), orderByFields: 'objectid', f: 'json' }).toString()}`,
      ),
    ).features;
  const apns = [
    ...new Set(
      unique.map((p) => text(p, 'parcel_number').replace(/-/g, '')).filter((a) => /^\d{10}$/.test(a)),
    ),
  ];
  const features = [
    ...(await query(`apn in (${inList(apns)})`, 500)),
    ...(await query(`apn like '5840%' AND situs_zip like '91977%'`, 150)),
    ...(await query('apn is null', 2)),
  ];
  const seen = new Set<unknown>();
  const parcels = features.filter((f) => {
    const oid = z.object({ attributes: z.object({ objectid: z.number() }) }).parse(f).attributes.objectid;
    if (seen.has(oid)) return false;
    seen.add(oid);
    return true;
  });
  await save('sandag_parcels/parcels.json', JSON.stringify({ features: parcels }, null, 1));
  await save(
    'sandag_parcels/layer.json',
    JSON.stringify({
      editingInfo: {
        lastEditDate: z
          .object({ editingInfo: z.object({ lastEditDate: z.number() }) })
          .parse(await getJson(`${LAYER}?f=json`)).editingInfo.lastEditDate,
      },
    }),
  );

  // City approvals: real rows sampled from the downloaded CSVs.
  const blob = (r: Readonly<Record<string, string>>): string =>
    `${r['APPROVAL_TYPE'] ?? ''} ${r['PROJECT_TITLE'] ?? ''} ${r['APPROVAL_SCOPE'] ?? ''}`.toUpperCase();
  const isSolar = (r: Readonly<Record<string, string>>): boolean => /PHOTOVOLTAIC|\bPV\b|SOLAR/.test(blob(r));
  const cityPicks = [
    {
      limit: 40,
      test: (r: Readonly<Record<string, string>>) =>
        /RE-?ROOF|ROOF REPAIR|ROOF REPLACEMENT/.test(blob(r)) && !isSolar(r),
    },
    { limit: 25, test: (r: Readonly<Record<string, string>>) => blob(r).includes('ROOF') && isSolar(r) },
    {
      limit: 15,
      test: (r: Readonly<Record<string, string>>) => /ROOF ?TOP|ROOF MOUNT/.test(blob(r)) && !isSolar(r),
    },
    { limit: 30, test: (r: Readonly<Record<string, string>>) => !blob(r).includes('ROOF') },
  ];
  for (const name of ['approvals_closed_datasd.csv', 'approvals_active_datasd.csv']) {
    const rows = await sampleCsv(await findFile(rawRoot, name), 'utf8', cityPicks);
    await save(`sdcity_permits/${name}`, toCsv(rows, true));
  }

  const businesses = await sampleCsv(await findFile(rawRoot, 'sd_businesses_active_datasd.csv'), 'utf8', [
    { limit: 40, test: (r) => /ROOF/i.test(`${r['dba_name'] ?? ''} ${r['business_owner_name'] ?? ''}`) },
    { limit: 60, test: (r) => (r['address_city'] ?? '') === 'SAN DIEGO' },
    { limit: 6, test: (r) => (r['address_state'] ?? '') !== 'CA' && (r['lat'] ?? '') !== '' },
  ]);
  await save('sdcity_businesses/sd_businesses_active_datasd.csv', toCsv(businesses, true));

  // CSLB: the licences named on the fixture permits, plus C-39 roofers based in San Diego County.
  const wanted = new Set(contractors.map((c) => text(c, 'contractor_license_number').replace(/^0+/, '')));
  const cslb = await sampleCsv(await findFile(rawRoot, 'MasterLicenseData.csv'), 'latin1', [
    { limit: 400, test: (r) => wanted.has((r['LicenseNo'] ?? '').replace(/^0+/, '')) },
    { limit: 40, test: (r) => r['County'] === 'San Diego' && /C-?39/.test(r['Classifications(s)'] ?? '') },
    { limit: 20, test: () => true },
  ]);
  await mkdir(path.join(OUT, 'cslb_license_master'), { recursive: true });
  await writeFile(path.join(OUT, 'cslb_license_master/MasterLicenseData.csv'), toCsv(cslb, false), 'latin1');
  process.stdout.write(`wrote cslb_license_master/MasterLicenseData.csv (${cslb.length} rows)\n`);
}

await main();
