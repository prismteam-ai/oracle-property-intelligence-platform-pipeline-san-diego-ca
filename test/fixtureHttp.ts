import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { HeadInfo, HttpClient } from '../src/http.js';

/**
 * Offline stand-in for the network. It answers the exact URLs the adapters build, from the recorded
 * real rows under a fixture directory, and applies the same window filter and paging the live
 * services do, so the adapters' own request logic is what the tests exercise.
 */

const Records = z.array(z.record(z.string(), z.unknown()));
const Parcels = z.object({
  features: z.array(z.looseObject({ attributes: z.looseObject({ objectid: z.number() }) })),
});

const SOCRATA: Readonly<Record<string, string>> = {
  'red2-qccu': 'sdcounty_permits/permits.json',
  'beua-23q8': 'sdcounty_permit_status/status.json',
  '4ju2-mf55': 'sdcounty_permit_contractors/contractors.json',
};

const FILES: readonly (readonly [string, string])[] = [
  ['approvals_active_datasd.csv', 'sdcity_permits/approvals_active_datasd.csv'],
  ['approvals_closed_datasd.csv', 'sdcity_permits/approvals_closed_datasd.csv'],
  ['sd_businesses_active_datasd.csv', 'sdcity_businesses/sd_businesses_active_datasd.csv'],
  ['MasterLicenseData', 'cslb_license_master/MasterLicenseData.csv'],
];

export interface FixtureHttp extends HttpClient {
  readonly requests: string[];
}

export function createFixtureHttp(fixtureDir: string): FixtureHttp {
  const requests: string[] = [];
  const read = (relative: string): Promise<string> => readFile(path.join(fixtureDir, relative), 'utf8');
  const fileFor = (url: string): string => {
    const match = FILES.find(([needle]) => url.includes(needle));
    if (match === undefined) throw new Error(`fixture http: no file for ${url}`);
    return path.join(fixtureDir, match[1]);
  };

  const socrata = async (url: URL, resource: string): Promise<string> => {
    const file = SOCRATA[resource];
    if (file === undefined) throw new Error(`fixture http: unknown Socrata resource ${resource}`);
    let rows = Records.parse(JSON.parse(await read(file)));
    const where = url.searchParams.get('$where') ?? '';
    for (const m of where.matchAll(/(\w+) (>=|<) '([^']+)'/g)) {
      const [, column, op, bound] = m;
      if (column === undefined || bound === undefined) continue;
      rows = rows.filter((r) => {
        const value = r[column];
        if (typeof value !== 'string') return false;
        return op === '>=' ? value >= bound : value < bound;
      });
    }
    const offset = Number(url.searchParams.get('$offset') ?? '0');
    const limit = Number(url.searchParams.get('$limit') ?? '1000');
    return JSON.stringify(rows.slice(offset, offset + limit));
  };

  const arcgis = async (url: URL): Promise<string> => {
    if (!url.pathname.endsWith('/query')) return read('sandag_parcels/layer.json');
    const { features } = Parcels.parse(JSON.parse(await read('sandag_parcels/parcels.json')));
    if (url.searchParams.has('outStatistics')) {
      const mx = Math.max(0, ...features.map((f) => f.attributes.objectid));
      return JSON.stringify({ features: [{ attributes: { mx } }] });
    }
    const range = /objectid > (\d+) AND objectid <= (\d+)/.exec(url.searchParams.get('where') ?? '');
    if (range === null) throw new Error(`fixture http: unsupported parcel query ${url.search}`);
    const [low, high] = [Number(range[1]), Number(range[2])];
    return JSON.stringify({
      features: features.filter((f) => f.attributes.objectid > low && f.attributes.objectid <= high),
    });
  };

  return {
    requests,
    async getText(rawUrl: string): Promise<string> {
      requests.push(rawUrl);
      const url = new URL(rawUrl);
      if (url.hostname === 'data.sandiegocounty.gov') {
        return socrata(url, path.basename(url.pathname, '.json'));
      }
      if (url.hostname === 'geo.sandag.org') return arcgis(url);
      throw new Error(`fixture http: unexpected request ${rawUrl}`);
    },
    async head(rawUrl: string): Promise<HeadInfo> {
      requests.push(`HEAD ${rawUrl}`);
      const body = await readFile(fileFor(rawUrl));
      return {
        etag: createHash('sha1').update(body).digest('hex'),
        lastModified: null,
        contentLength: body.length,
      };
    },
    async download(rawUrl: string, destPath: string): Promise<number> {
      requests.push(rawUrl);
      await mkdir(path.dirname(destPath), { recursive: true });
      await copyFile(fileFor(rawUrl), destPath);
      return (await readFile(destPath)).length;
    },
  };
}
