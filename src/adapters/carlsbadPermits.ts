import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isoDate } from '../config.js';
import { mapLimit } from '../http.js';
import { blankToNull, countyCoordinate, isoDatePart, truncate, zip5 } from '../normalize.js';
import { classifyRoofing } from '../roofing.js';
import type { StatusGroup } from './countySocrata.js';
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

const LAYER =
  'https://services.arcgis.com/ay9ePoQ2UfAX3U38/arcgis/rest/services/BuildingPermits/FeatureServer/0';
const PAGE = 2000;
const LAYER_FILE = 'layer.json';

export const CARLSBAD_PERMIT_PREFIX = 'carlsbad:';

const text = z.string().nullable().optional();
const Feature = z.object({
  attributes: z.object({
    OBJECTID: z.number(),
    PermitNum: text,
    Description: text,
    AppliedDate: text,
    IssuedDate: text,
    CompletedDate: text,
    StatusCurrent: text,
    OriginalAddress1: text,
    OriginalCity: text,
    OriginalZip: text,
    PermitClass: text,
    PermitClassMapped: text,
  }),
  geometry: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
});
const Page = z.object({ features: z.array(z.unknown()) });
const LayerInfo = z.object({ editingInfo: z.object({ lastEditDate: z.number() }).optional() });
const MaxStat = z.object({
  features: z.array(z.object({ attributes: z.object({ mx: z.number() }) })).min(1),
});

/** Carlsbad (EnerGov) statuses, grouped. */
export function carlsbadStatusGroup(status: string | null): StatusGroup {
  const s = (status ?? '').toUpperCase();
  if (s === '') return 'other';
  if (s === 'CLOSED - FINALED') return 'completed';
  if (s === 'CLOSED - EXPIRED') return 'expired';
  if (s.startsWith('CLOSED')) return 'cancelled'; // withdrawn, denied, revoked, error
  if (s.startsWith('ISSUED')) return 'open';
  return 'other'; // pending, under review, approved but not yet issued
}

function pageUrl(startExclusive: number): string {
  const params = new URLSearchParams({
    where: `OBJECTID > ${startExclusive} AND OBJECTID <= ${startExclusive + PAGE}`,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    orderByFields: 'OBJECTID',
    f: 'json',
  });
  return `${LAYER}/query?${params.toString()}`;
}

function recordUrl(permitNumber: string): string {
  const params = new URLSearchParams({ where: `PermitNum='${permitNumber}'`, outFields: '*', f: 'json' });
  return `${LAYER}/query?${params.toString()}`;
}

async function saveText(dest: string, body: string): Promise<void> {
  await writeFile(`${dest}.part`, body, 'utf8');
  await rename(`${dest}.part`, dest);
}

export const carlsbadPermits: SourceAdapter = {
  info: {
    id: 'carlsbad_permits',
    name: 'City of Carlsbad building permits (open-data snapshot, applied 2022 to 2023)',
    url: LAYER,
    licence:
      'Public ArcGIS feature service published by the City of Carlsbad GIS and tagged "open data"; no login. No licence text is declared on the item.',
    limits:
      'A frozen snapshot: 9,886 permits applied 2022-01-01 to 2023-12-29, last edited January 2024. Statuses are as of that date, so a permit shown as open may have been finalled since. No APN, no contractor, no valuation. 2,000 records per query. The layer lastEditDate is the change token.',
    changeDetection: 'snapshot',
  },
  entities: ['permit'],

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const layerBody = await ctx.http.getText(`${LAYER}?f=json`);
    const info = LayerInfo.parse(JSON.parse(layerBody));
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
    const dir = sourceDir(ctx, 'carlsbad_permits');
    await mkdir(dir, { recursive: true });
    const layerPath = path.join(dir, LAYER_FILE);
    await saveText(layerPath, layerBody);
    const layerFile: RawFile = {
      path: layerPath,
      url: `${LAYER}?f=json`,
      fetchedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(layerBody),
    };

    const statsUrl = `${LAYER}/query?${new URLSearchParams({
      where: '1=1',
      outStatistics: JSON.stringify([
        { statisticType: 'max', onStatisticField: 'OBJECTID', outStatisticFieldName: 'mx' },
      ]),
      f: 'json',
    }).toString()}`;
    const maxId = MaxStat.parse(JSON.parse(await ctx.http.getText(statsUrl))).features[0]?.attributes.mx ?? 0;
    const starts = Array.from({ length: Math.ceil(maxId / PAGE) }, (_, i) => i * PAGE);
    let bytes = layerFile.bytes;
    let reused = 0;
    const pages = await mapLimit(starts, 2, async (start): Promise<RawFile> => {
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
      await saveText(dest, body);
      bytes += Buffer.byteLength(body);
      return { path: dest, url, fetchedAt: new Date().toISOString(), bytes: Buffer.byteLength(body) };
    });
    return {
      files: [layerFile, ...pages],
      bytes,
      skipped: null,
      stateToken,
      notes: reused > 0 ? [`resumed: reused ${reused} of ${starts.length} page files already on disk`] : [],
    };
  },

  async *rows(files: readonly RawFile[], ctx: ParseContext): AsyncGenerator<StagedRecord> {
    // Statuses in this snapshot were true on the day the layer was last edited, not today.
    let statusAsOf: string | null = null;
    for (const file of files) {
      const body: unknown = JSON.parse(await readFile(file.path, 'utf8'));
      if (path.basename(file.path) === LAYER_FILE) {
        const edited = LayerInfo.parse(body).editingInfo?.lastEditDate;
        statusAsOf = edited === undefined ? null : isoDate(new Date(edited));
        continue;
      }
      for (const rawFeature of Page.parse(body).features) {
        const parsed = Feature.safeParse(rawFeature);
        if (!parsed.success) {
          yield reject('permit', null, 'raw_shape_mismatch', rawFeature);
          continue;
        }
        const a = parsed.data.attributes;
        const id = blankToNull(a.PermitNum);
        if (id === null) {
          yield reject('permit', `objectid:${a.OBJECTID}`, 'source_permit_id:missing', rawFeature);
          continue;
        }
        const dates = {
          applied_date: blankToNull(a.AppliedDate),
          issued_date: blankToNull(a.IssuedDate),
          closed_date: blankToNull(a.CompletedDate),
        };
        const badDate = Object.entries(dates).find(([, raw]) => raw !== null && isoDatePart(raw) === null);
        if (badDate !== undefined) {
          yield reject('permit', id, `${badDate[0]}:bad_date_format`, rawFeature);
          continue;
        }
        const description = blankToNull(a.Description);
        const roofing = classifyRoofing(description);
        const status = blankToNull(a.StatusCurrent);
        const group = carlsbadStatusGroup(status);
        const located = countyCoordinate(parsed.data.geometry?.y, parsed.data.geometry?.x);
        yield validate(
          ctx.entities,
          'permit',
          {
            permit_uid: `${CARLSBAD_PERMIT_PREFIX}${id}`,
            source_permit_id: id,
            jurisdiction: 'City of Carlsbad',
            apn: null,
            apn_raw: null,
            permit_type: blankToNull(a.PermitClass),
            permit_subtype: blankToNull(a.PermitClassMapped),
            description: truncate(description, 2000),
            project_title: null,
            roofing_class: roofing.roofingClass,
            is_roofing: roofing.isRoofing,
            roofing_rule: roofing.rule,
            status,
            status_group: group,
            is_open: group === 'open',
            applied_date: isoDatePart(dates.applied_date),
            issued_date: isoDatePart(dates.issued_date),
            closed_date: isoDatePart(dates.closed_date),
            expire_date: null,
            valuation: null,
            holder_name: null,
            holder_name_norm: null,
            address: blankToNull(a.OriginalAddress1),
            city: blankToNull(a.OriginalCity)?.toUpperCase() ?? null,
            zip: zip5(a.OriginalZip),
            lat: located.lat,
            lon: located.lon,
            source_updated_at: null,
            coord_note: located.note,
            status_as_of: statusAsOf,
          },
          { sourceRecordId: id, sourceUrl: recordUrl(id), fetchedAt: file.fetchedAt, rank: a.OBJECTID },
          rawFeature,
        );
      }
    }
  },
};
