import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { mapLimit } from '../http.js';
import {
  blankToNull,
  normalizeApn,
  resolveMmddyy,
  resolveTwoDigitYear,
  toNumber,
  zip5,
} from '../normalize.js';
import { fileIfExists, sourceDir } from './shared.js';
import type {
  FetchContext,
  FetchResult,
  ParseContext,
  RawFile,
  SourceAdapter,
  StagedRecord,
} from './types.js';
import { reject, validate } from './types.js';

const LAYER = 'https://geo.sandag.org/server/rest/services/Hosted/Parcels/FeatureServer/0';
const PAGE = 2000;
const CONCURRENCY = 4;

const OUT_FIELDS = [
  'objectid',
  'apn',
  'apn_8',
  'situs_juris',
  'situs_street',
  'situs_suffix',
  'situs_post_dir',
  'situs_pre_dir',
  'situs_address',
  'situs_fraction',
  'situs_suite',
  'situs_community',
  'situs_zip',
  'year_effective',
  'docdate',
  'doctype',
  'docnmbr',
  'ownerocc',
  'asr_land',
  'asr_impr',
  'asr_total',
  'acreage',
  'nucleus_use_cd',
  'asr_landuse',
  'nucleus_zone_cd',
  'unitqty',
  'total_lvg_area',
  'bedrooms',
  'baths',
  'pool',
  'taxstat',
  'SHAPE__Area',
] as const;

const nullableText = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();

/** Raw shape check: the fields we read must have the types the layer documents. */
const Feature = z.object({
  attributes: z.object({
    objectid: z.number(),
    apn: nullableText,
    apn_8: nullableText,
    situs_juris: nullableText,
    situs_street: nullableText,
    situs_suffix: nullableText,
    situs_post_dir: nullableText,
    situs_pre_dir: nullableText,
    situs_address: nullableNumber,
    situs_fraction: nullableText,
    situs_suite: nullableText,
    situs_community: nullableText,
    situs_zip: nullableText,
    year_effective: nullableText,
    docdate: nullableText,
    doctype: nullableText,
    docnmbr: nullableText,
    ownerocc: nullableText,
    asr_land: nullableNumber,
    asr_impr: nullableNumber,
    asr_total: nullableNumber,
    acreage: nullableNumber,
    nucleus_use_cd: nullableText,
    asr_landuse: nullableNumber,
    nucleus_zone_cd: nullableText,
    unitqty: nullableNumber,
    total_lvg_area: nullableNumber,
    bedrooms: nullableText,
    baths: nullableText,
    pool: nullableText,
    taxstat: nullableText,
    SHAPE__Area: nullableNumber,
  }),
  centroid: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
});
const Page = z.object({ features: z.array(z.unknown()) });
const LayerInfo = z.object({ editingInfo: z.object({ lastEditDate: z.number() }).optional() });
const MaxStat = z.object({
  features: z.array(z.object({ attributes: z.object({ mx: z.number() }) })).min(1),
});

const OWNER_FIELDS_NOTE =
  'owner name and mailing address are not published in the public SANDAG/SanGIS parcel layer';
const OUT_OF_AREA_BASIS =
  'proxy: true when the assessor owner-occupied flag is not Y (no public owner mailing address to compare)';

function pageUrl(startExclusive: number): string {
  const params = new URLSearchParams({
    where: `objectid > ${startExclusive} AND objectid <= ${startExclusive + PAGE}`,
    outFields: OUT_FIELDS.join(','),
    returnGeometry: 'false',
    returnCentroid: 'true',
    outSR: '4326',
    orderByFields: 'objectid',
    f: 'json',
  });
  return `${LAYER}/query?${params.toString()}`;
}

function recordUrl(apn: string): string {
  return `${LAYER}/query?${new URLSearchParams({ where: `apn='${apn}'`, outFields: '*', f: 'json' }).toString()}`;
}

/** SANDAG stores small integers as zero-padded text ("003" bedrooms, "020" = 2.0 baths). */
function paddedInt(raw: string | null | undefined): number | null {
  const value = blankToNull(raw);
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

function situsAddress(a: z.infer<typeof Feature>['attributes']): string | null {
  const number = a.situs_address ?? 0;
  const street = blankToNull(a.situs_street);
  if (number <= 0 || street === null) return null;
  const parts = [
    String(number),
    blankToNull(a.situs_fraction),
    blankToNull(a.situs_pre_dir),
    street,
    blankToNull(a.situs_suffix),
    blankToNull(a.situs_post_dir),
  ].filter((p): p is string => p !== null);
  return parts.join(' ');
}

export const sandagParcels: SourceAdapter = {
  info: {
    id: 'sandag_parcels',
    name: 'SANDAG / SanGIS Parcels (assessor attributes, parcel centroids)',
    url: LAYER,
    licence:
      'Public ArcGIS feature service, no login. Attribution: SanGIS using legal recorded data from the County Recorder and Assessor.',
    limits: `maxRecordCount ${PAGE} per query; fetched as objectid ranges, ${CONCURRENCY} in flight. No per-row change date; the layer lastEditDate is the change token. No owner name or mailing address.`,
    changeDetection: 'snapshot',
  },
  entities: ['property', 'ownership'],

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const info = LayerInfo.parse(JSON.parse(await ctx.http.getText(`${LAYER}?f=json`)));
    const stateToken = `lastEditDate=${info.editingInfo?.lastEditDate ?? 'unknown'}`;
    if (!ctx.force && ctx.previousStateToken !== null && ctx.previousStateToken === stateToken) {
      return {
        files: [],
        bytes: 0,
        skipped: 'layer not edited since last load (same lastEditDate)',
        stateToken,
        notes: [],
      };
    }
    const statsUrl = `${LAYER}/query?${new URLSearchParams({
      where: '1=1',
      outStatistics: JSON.stringify([
        { statisticType: 'max', onStatisticField: 'objectid', outStatisticFieldName: 'mx' },
      ]),
      f: 'json',
    }).toString()}`;
    const maxId = MaxStat.parse(JSON.parse(await ctx.http.getText(statsUrl))).features[0]?.attributes.mx ?? 0;
    const starts = Array.from({ length: Math.ceil(maxId / PAGE) }, (_, i) => i * PAGE);
    const dir = sourceDir(ctx, 'sandag_parcels');
    await mkdir(dir, { recursive: true });
    let bytes = 0;
    let reused = 0;
    let done = 0;
    const files = await mapLimit(starts, CONCURRENCY, async (start): Promise<RawFile> => {
      const url = pageUrl(start);
      const dest = path.join(dir, `oid_${String(start).padStart(8, '0')}.json`);
      const existing = await fileIfExists(dest, url);
      if (existing !== null) {
        reused++;
        return existing;
      }
      const body = await ctx.http.getText(url);
      // ArcGIS reports errors inside a 200 response; a page without `features` must not be saved.
      Page.parse(JSON.parse(body));
      await writeFile(`${dest}.part`, body, 'utf8');
      await rename(`${dest}.part`, dest);
      const size = Buffer.byteLength(body);
      bytes += size;
      done++;
      if (done % 50 === 0) ctx.log.info('parcel pages', { done, total: starts.length, bytes });
      return { path: dest, url, fetchedAt: new Date().toISOString(), bytes: size };
    });
    return {
      files,
      bytes,
      skipped: null,
      stateToken,
      notes: reused > 0 ? [`resumed: reused ${reused} of ${starts.length} page files already on disk`] : [],
    };
  },

  async *rows(files: readonly RawFile[], ctx: ParseContext): AsyncGenerator<StagedRecord> {
    const currentYear = Number(ctx.today.slice(0, 4));
    for (const file of files) {
      const page = Page.parse(JSON.parse(await readFile(file.path, 'utf8')));
      for (const rawFeature of page.features) {
        const parsed = Feature.safeParse(rawFeature);
        if (!parsed.success) {
          yield reject('property', null, 'raw_shape_mismatch', rawFeature);
          continue;
        }
        const a = parsed.data.attributes;
        const apn = normalizeApn(a.apn);
        const recordId = apn ?? `objectid:${a.objectid}`;
        if (apn === null) {
          yield reject(
            'property',
            recordId,
            blankToNull(a.apn) === null ? 'apn:missing' : 'apn:apn_not_10_digits',
            rawFeature,
          );
          continue;
        }
        if (parsed.data.centroid === null || parsed.data.centroid === undefined) {
          yield reject('property', recordId, 'lat:missing_centroid', rawFeature);
          continue;
        }
        const provenance = {
          sourceRecordId: apn,
          sourceUrl: recordUrl(apn),
          fetchedAt: file.fetchedAt,
          rank: a.SHAPE__Area ?? 0,
        };
        const year = resolveTwoDigitYear(a.year_effective, currentYear);
        const baths = paddedInt(a.baths);
        const property = validate(
          ctx.entities,
          'property',
          {
            apn,
            apn_8: blankToNull(a.apn_8),
            situs_address: situsAddress(a),
            situs_number:
              a.situs_address !== null && a.situs_address !== undefined && a.situs_address > 0
                ? a.situs_address
                : null,
            situs_street: blankToNull(a.situs_street),
            situs_unit: blankToNull(a.situs_suite),
            situs_city: blankToNull(a.situs_community),
            situs_juris: blankToNull(a.situs_juris),
            situs_zip: zip5(a.situs_zip),
            lat: parsed.data.centroid.y,
            lon: parsed.data.centroid.x,
            year_effective_raw: blankToNull(a.year_effective),
            year_effective: year.year,
            year_ambiguous: year.ambiguous,
            year_rule: year.rule,
            use_code: blankToNull(a.nucleus_use_cd),
            land_use: a.asr_landuse ?? null,
            zone_code: blankToNull(a.nucleus_zone_cd),
            units: a.unitqty ?? null,
            living_area_sqft: a.total_lvg_area ?? null,
            bedrooms: paddedInt(a.bedrooms),
            baths: baths === null ? null : baths / 10,
            pool: a.pool === 'Y' ? true : a.pool === 'N' ? false : null,
            acreage: toNumber(a.acreage),
            assessed_land: a.asr_land ?? null,
            assessed_improvements: a.asr_impr ?? null,
            assessed_total: a.asr_total ?? null,
            tax_status: blankToNull(a.taxstat),
          },
          provenance,
          rawFeature,
        );
        yield property;
        if (!property.ok) continue;
        const transfer = resolveMmddyy(a.docdate, ctx.today);
        const ownerOccupied = a.ownerocc === 'Y';
        yield validate(
          ctx.entities,
          'ownership',
          {
            apn,
            owner_name: null,
            mail_address: null,
            mail_city: null,
            mail_state: null,
            mail_zip: null,
            owner_fields_note: OWNER_FIELDS_NOTE,
            owner_occupied: ownerOccupied,
            last_transfer_date_raw: blankToNull(a.docdate),
            last_transfer_date: transfer.date,
            last_transfer_ambiguous: transfer.ambiguous,
            last_transfer_rule: transfer.rule,
            doc_type: blankToNull(a.doctype),
            doc_number: blankToNull(a.docnmbr),
            out_of_area: !ownerOccupied,
            out_of_area_basis: OUT_OF_AREA_BASIS,
          },
          provenance,
          rawFeature,
        );
      }
    }
  },
};
