import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { ARTIFACTS } from '../publish/exportArtifacts.js';
import {
  MAX_RADIUS_MILES,
  findRoofingLeads,
  getAtlasDatasetInfo,
  getAtlasSchema,
  getOracleProperty,
  queryAtlas,
} from './queries.js';
import { MAX_QUERY_ROWS, QueryRejectedError } from './sqlGuard.js';
import type { Store } from './store.js';

export const SERVER_INFO = { name: 'oracle-property-intelligence-san-diego', version: '1.0.0' } as const;

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  const text = JSON.stringify(payload);
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? { content: [{ type: 'text', text }], structuredContent: payload as Record<string, unknown> }
    : { content: [{ type: 'text', text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function readArtifactJson(store: Store, name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(store.artifactDir, ...name.split('/')), 'utf8')) as unknown;
}

/**
 * The Oracle's public interface. Every tool is read-only. The roofing CRM, the explorer UI and
 * any agent use these same tools, so there is one data contract and no second way in.
 */
export function buildMcpServer(store: Store, today: () => string): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Read-only property intelligence for San Diego County, CA: parcels, roof-age proxy, permits ' +
      '(roofing emphasis), contractors and licences, businesses. Call getAtlasSchema before queryAtlas.',
  });

  server.registerTool(
    'findRoofingLeads',
    {
      title: 'Find roofing leads in a radius',
      description:
        'Properties within a radius of a point that have a roof at or above an age threshold and/or ' +
        'open roofing permits. Returns totals and rows with roof-age basis, open duration and coordinates.',
      inputSchema: {
        center: z.object({ lat: z.number(), lon: z.number() }),
        radiusMiles: z.number().positive().max(MAX_RADIUS_MILES).optional(),
        minRoofAgeYears: z.number().int().min(0).max(150).optional(),
        minOpenYears: z.number().min(0).max(60).optional(),
        signal: z.enum(['any', 'aged_roof', 'open_permit', 'both']).optional(),
        permitStatus: z.enum(['any', 'open', 'closed']).optional(),
        sort: z.enum(['score', 'distance', 'roof_age', 'open_days']).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await findRoofingLeads(store, args, today()));
      } catch (e) {
        return fail(e instanceof z.ZodError ? `Invalid input: ${e.message}` : String(e));
      }
    },
  );

  server.registerTool(
    'getOracleProperty',
    {
      title: 'Get one property',
      description:
        'One parcel by APN with roof basis, ownership fields and every permit: status, open duration, ' +
        'contractor, CSLB licence, BBB rating or the reason it is absent, and source provenance.',
      inputSchema: { apn: z.string().min(3).max(32) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ apn }) => {
      const property = await getOracleProperty(store, apn, today());
      // `null` is a valid answer ("no such parcel"), so it travels as JSON text, not as an error.
      return property ? ok(property) : { content: [{ type: 'text', text: 'null' }] };
    },
  );

  server.registerTool(
    'getAtlasDatasetInfo',
    {
      title: 'Dataset info',
      description:
        'County, as-of time, record counts per table, sources with limits, and the published root CID.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ok(await getAtlasDatasetInfo(store)),
  );

  server.registerTool(
    'getAtlasSchema',
    {
      title: 'Query schema',
      description:
        'Relations and columns available to queryAtlas, with notes on how to compute roof age, open duration and distance.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: 'text', text: await getAtlasSchema(store) }] }),
  );

  server.registerTool(
    'queryAtlas',
    {
      title: 'Read-only SQL',
      description: `Run ONE read-only DuckDB SELECT over parcel, permit, contractor, business and place. Capped at ${MAX_QUERY_ROWS} rows. Anything else is rejected.`,
      inputSchema: { sql: z.string().min(1).max(4000) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sql }) => {
      try {
        return ok(await queryAtlas(store, sql));
      } catch (e) {
        if (e instanceof QueryRejectedError) return fail(`Query rejected: ${e.message}`);
        return fail(`Query failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown error'}`);
      }
    },
  );

  server.registerTool(
    'getPipelineRuns',
    {
      title: 'Pipeline run history',
      description:
        'Every pipeline run with window, timestamps and per-source counts of fetched, inserted, updated, unchanged and rejected records.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ok(await readArtifactJson(store, ARTIFACTS.runHistory)),
  );

  server.registerTool(
    'getCoverage',
    {
      title: 'Coverage and limitations',
      description:
        'Counts per table, roofing totals, rejected-row reasons and the documented source limitations for this run.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ok(await readArtifactJson(store, ARTIFACTS.coverage)),
  );

  server.registerTool(
    'getArtifactManifest',
    {
      title: 'Published artifact manifest',
      description:
        'The IPFS manifest for the run being served: root CID, and each object with CID, size, codec and SHA-256.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(await readArtifactJson(store, 'manifest.json'));
      } catch {
        return fail('No manifest is present for this run: the artifacts have not been published yet.');
      }
    },
  );

  return server;
}

/**
 * Stateless streamable HTTP: one server and transport per request, JSON responses, no sessions.
 * That is what lets this run on a function that scales to zero.
 */
export async function handleMcpRequest(
  store: Store,
  request: Request,
  today: () => string,
): Promise<Response> {
  // No sessionIdGenerator: the transport runs stateless.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = buildMcpServer(store, today);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
