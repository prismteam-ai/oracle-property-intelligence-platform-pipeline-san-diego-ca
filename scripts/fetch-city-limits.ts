/**
 * Writes the city-limit polygons the two maps shade where a city publishes no permits.
 * Source: SANDAG Municipal_Boundaries (public, the same publisher as the parcel layer).
 * Its `code` field equals parcel.jurisdiction (EC, LM, ST, SD...). Unincorporated land (CN) is left out.
 *
 *   npx tsx scripts/fetch-city-limits.ts explorer/public/cities.geojson [more output paths]
 */
import { writeFileSync } from 'node:fs';

const URL_BASE =
  'https://geo.sandag.org/server/rest/services/Hosted/Municipal_Boundaries/FeatureServer/0/query';

async function main(): Promise<void> {
  const outputs = process.argv.slice(2);
  if (outputs.length === 0) throw new Error('Give at least one output path.');
  const params = new URLSearchParams({
    where: "code<>'CN'",
    outFields: 'code,name',
    outSR: '4326',
    maxAllowableOffset: '0.0005',
    geometryPrecision: '5',
    f: 'geojson',
  });
  const response = await fetch(`${URL_BASE}?${params.toString()}`);
  if (!response.ok) throw new Error(`SANDAG returned ${response.status}`);
  const body = (await response.json()) as { features?: unknown[] };
  if (!Array.isArray(body.features) || body.features.length === 0)
    throw new Error('No city polygons returned.');
  const text = JSON.stringify(body);
  for (const out of outputs) writeFileSync(out, text);
  console.log(`${body.features.length} polygons, ${text.length} bytes -> ${outputs.join(', ')}`);
}

void main();
