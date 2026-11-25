import type { z } from 'zod';
import { AGENT_URL } from './config';
import { McpError, callTool, type RpcOptions } from './mcp';
import {
  agentResponseSchema,
  coverageSchema,
  datasetInfoSchema,
  leadSearchSchema,
  manifestSchema,
  pipelineRunsSchema,
  propertySchema,
  publicationHistorySchema,
  queryResultSchema,
  type AgentResponse,
  type Coverage,
  type DatasetInfo,
  type LeadSearch,
  type Manifest,
  type PipelineRuns,
  type Property,
  type Publication,
  type QueryResult,
} from './schemas';

async function typed<S extends z.ZodTypeAny>(
  schema: S,
  tool: string,
  args: Record<string, unknown> = {},
  options: RpcOptions = {},
): Promise<z.output<S>> {
  const payload = await callTool(tool, args, options);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.') ?? '';
    throw new McpError('protocol', `${tool} returned an unexpected shape (${where || 'root'}).`);
  }
  return parsed.data as z.output<S>;
}

export interface LeadSearchArgs {
  center: { lat: number; lon: number };
  radiusMiles: number;
  minRoofAgeYears: number;
  signal: 'aged_roof' | 'open_permit' | 'any';
  /** Only parcels whose last recorded transfer is at least this many years old. */
  minYearsSinceTransfer?: number;
  /** 'no' is the out-of-area proxy: the parcel is not flagged owner-occupied. */
  ownerOccupied?: 'yes' | 'no';
  limit?: number;
}

export const getDatasetInfo = (o?: RpcOptions): Promise<DatasetInfo> =>
  typed(datasetInfoSchema, 'getAtlasDatasetInfo', {}, o);
export const getPipelineRuns = (o?: RpcOptions): Promise<PipelineRuns> =>
  typed(pipelineRunsSchema, 'getPipelineRuns', {}, o);
export const getCoverage = (o?: RpcOptions): Promise<Coverage> =>
  typed(coverageSchema, 'getCoverage', {}, o);
export const getManifest = (o?: RpcOptions): Promise<Manifest> =>
  typed(manifestSchema, 'getArtifactManifest', {}, o);
export const getPublicationHistory = (o?: RpcOptions): Promise<Publication[]> =>
  typed(publicationHistorySchema, 'getPublicationHistory', {}, o);
export const queryAtlas = (sql: string, o?: RpcOptions): Promise<QueryResult> =>
  typed(queryResultSchema, 'queryAtlas', { sql }, o);

export async function getSchemaText(o?: RpcOptions): Promise<string> {
  const payload = await callTool('getAtlasSchema', {}, o);
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

export function findLeads(args: LeadSearchArgs, o?: RpcOptions): Promise<LeadSearch> {
  const sort =
    args.signal === 'aged_roof'
      ? 'roof_age'
      : args.signal === 'open_permit'
        ? 'open_days'
        : 'distance';
  return typed(
    leadSearchSchema,
    'findRoofingLeads',
    {
      center: args.center,
      radiusMiles: args.radiusMiles,
      minRoofAgeYears: args.minRoofAgeYears,
      signal: args.signal,
      ...(args.signal === 'open_permit' ? { permitStatus: 'open' } : {}),
      ...(args.minYearsSinceTransfer === undefined
        ? {}
        : { minYearsSinceTransfer: args.minYearsSinceTransfer }),
      ...(args.ownerOccupied === undefined ? {} : { ownerOccupied: args.ownerOccupied }),
      sort,
      limit: args.limit ?? 100,
    },
    o,
  );
}

/** status_group per permit on one parcel: open, pending, completed, cancelled, expired, other. */
export async function getPermitStatusGroups(
  apn: string,
  o?: RpcOptions,
): Promise<Map<string, string>> {
  const digits = apn.replace(/[^0-9]/g, '');
  const groups = new Map<string, string>();
  if (digits === '') return groups;
  const result = await queryAtlas(
    `SELECT permit_id, source_id, status_group FROM permit WHERE apn = '${digits}'`,
    o,
  );
  for (const row of result.rows) {
    if (typeof row.status_group === 'string') {
      groups.set(`${String(row.permit_id)}|${String(row.source_id)}`, row.status_group);
    }
  }
  return groups;
}

export async function getProperty(apn: string, o?: RpcOptions): Promise<Property | null> {
  const payload = await callTool('getOracleProperty', { apn }, o);
  if (payload === null) return null;
  const parsed = propertySchema.safeParse(payload);
  if (!parsed.success) {
    throw new McpError('protocol', 'getOracleProperty returned an unexpected shape.');
  }
  return parsed.data;
}

export interface AgentRequest {
  question: string;
  center?: { lat: number; lon: number };
  radiusMiles?: number;
}

export class AgentUnavailableError extends Error {
  constructor() {
    super('The agent endpoint is not available yet.');
    this.name = 'AgentUnavailableError';
  }
}

/** POST <api>/agent. A 404 means the endpoint has not been deployed, which the panel says. */
export async function askAgent(
  request: AgentRequest,
  options: { fetchImpl?: typeof fetch; url?: string; signal?: AbortSignal } = {},
): Promise<AgentResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.url ?? AGENT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
      signal: options.signal,
    });
  } catch (error) {
    throw new Error(
      `Could not reach the agent (${error instanceof Error ? error.message : 'network error'}).`,
    );
  }
  if (response.status === 404) throw new AgentUnavailableError();
  const bodyText = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : bodyText.slice(0, 200);
    throw new Error(`The agent answered HTTP ${response.status}${detail ? `: ${detail}` : '.'}`);
  }
  const parsed = agentResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error('The agent answer had an unexpected shape.');
  return parsed.data;
}
