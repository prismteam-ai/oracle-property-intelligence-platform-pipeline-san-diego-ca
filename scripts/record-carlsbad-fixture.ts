/**
 * Records the Carlsbad test fixture from the live feature service. Every feature is a real record,
 * copied unmodified. Needs the network; tests never run this.
 *
 *   npx tsx scripts/record-carlsbad-fixture.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { USER_AGENT } from '../src/config.js';

const LAYER =
  'https://services.arcgis.com/ay9ePoQ2UfAX3U38/arcgis/rest/services/BuildingPermits/FeatureServer/0';
const OUT = path.resolve('test/fixtures/carlsbad_permits');
const Features = z.object({
  features: z.array(z.looseObject({ attributes: z.looseObject({ OBJECTID: z.number() }) })),
});
type Feature = z.infer<typeof Features>['features'][number];

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function query(where: string, limit: number): Promise<Feature[]> {
  const params = new URLSearchParams({
    where,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    orderByFields: 'OBJECTID',
    resultRecordCount: String(limit),
    f: 'json',
  });
  return Features.parse(await getJson(`${LAYER}/query?${params.toString()}`)).features;
}

const reroof = "(Description LIKE '%REROOF%' OR Description LIKE '%RE-ROOF%')";
const solar =
  "(Description LIKE '%PHOTOVOLTAIC%' OR Description LIKE '%SOLAR%' OR Description LIKE '% PV %')";
const picks = [
  ...(await query(`${reroof} AND NOT ${solar} AND StatusCurrent = 'Closed - Finaled'`, 20)),
  ...(await query(`${reroof} AND NOT ${solar} AND StatusCurrent = 'Issued - Active'`, 20)),
  ...(await query(`${reroof} AND ${solar}`, 12)),
  ...(await query(`${solar} AND NOT ${reroof} AND Description LIKE '%ROOF%'`, 15)),
  ...(await query(`Description NOT LIKE '%ROOF%'`, 15)),
  ...(await query(`StatusCurrent NOT IN ('Closed - Finaled', 'Issued - Active')`, 12)),
];
const unique = [...new Map(picks.map((f) => [f.attributes.OBJECTID, f])).values()];
const layer = z
  .object({ editingInfo: z.object({ lastEditDate: z.number() }) })
  .parse(await getJson(`${LAYER}?f=json`));

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'permits.json'), JSON.stringify({ features: unique }, null, 1), 'utf8');
await writeFile(path.join(OUT, 'layer.json'), JSON.stringify({ editingInfo: layer.editingInfo }), 'utf8');
process.stdout.write(`wrote ${unique.length} Carlsbad features\n`);

// The parcels at the fixture permits' street numbers, so the offline tests can exercise
// address-to-parcel linking. They are merged into the shared parcel fixture (keyed on objectid, so
// re-recording is idempotent).
const PARCELS = 'https://geo.sandag.org/server/rest/services/Hosted/Parcels/FeatureServer/0';
const OUT_FIELDS =
  'objectid,apn,apn_8,situs_juris,situs_street,situs_suffix,situs_post_dir,situs_pre_dir,situs_address,situs_fraction,situs_suite,situs_community,situs_zip,year_effective,docdate,doctype,docnmbr,ownerocc,asr_land,asr_impr,asr_total,acreage,nucleus_use_cd,asr_landuse,nucleus_zone_cd,unitqty,total_lvg_area,bedrooms,baths,pool,taxstat,SHAPE__Area';
const ParcelFeatures = z.object({
  features: z.array(z.looseObject({ attributes: z.looseObject({ objectid: z.number() }) })),
});
const addresses = unique
  .map((f) => /^(\d+) ([A-Z]+)/.exec(z.string().catch('').parse(f.attributes['OriginalAddress1'])))
  .filter((m) => m !== null)
  .slice(0, 40);
const clauses = addresses.map(
  (m) => `(situs_address = ${m[1] ?? '0'} AND situs_street LIKE '${m[2] ?? ''}%')`,
);
const parcelParams = new URLSearchParams({
  where: `situs_juris = 'CB' AND (${clauses.join(' OR ')})`,
  outFields: OUT_FIELDS,
  returnGeometry: 'false',
  returnCentroid: 'true',
  outSR: '4326',
  orderByFields: 'objectid',
  resultRecordCount: '500',
  f: 'json',
});
const carlsbadParcels = ParcelFeatures.parse(
  await getJson(`${PARCELS}/query?${parcelParams.toString()}`),
).features;
const parcelFile = path.resolve('test/fixtures/sandag_parcels/parcels.json');
const existing = ParcelFeatures.parse(JSON.parse(await readFile(parcelFile, 'utf8'))).features;
const merged = [
  ...new Map([...existing, ...carlsbadParcels].map((f) => [f.attributes.objectid, f])).values(),
];
await writeFile(parcelFile, JSON.stringify({ features: merged }, null, 1), 'utf8');
process.stdout.write(`parcel fixture: ${existing.length} -> ${merged.length} features\n`);
