import { Logger } from '@aws-lambda-powertools/logger';
import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { isoDate } from '../config.js';
import { hydrate, type HydrateResult } from './hydrate.js';
import { handleMcpRequest } from './mcp.js';
import { Store } from './store.js';

const SERVICE = 'oracle-pipeline-mcp';
const logger = new Logger({ serviceName: SERVICE });
const tracer = new Tracer({ serviceName: SERVICE });
const metrics = new Metrics({ serviceName: SERVICE, namespace: 'OraclePipeline' });

interface Ready {
  store: Store;
  hydrated: HydrateResult;
}

let ready: Promise<Ready> | null = null;

async function start(): Promise<Ready> {
  const bucket = process.env['ARTIFACT_BUCKET'];
  const prefix = process.env['ARTIFACT_PREFIX'];
  if (!bucket || !prefix) throw new Error('ARTIFACT_BUCKET and ARTIFACT_PREFIX are required');
  const hydrated = await hydrate(bucket, prefix, '/tmp/artifacts');
  logger.info('artifacts ready', { ...hydrated });
  metrics.addMetric('ColdStartHydrateMs', MetricUnit.Milliseconds, hydrated.ms);
  return { store: await Store.open(hydrated.dir), hydrated };
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '3600',
};

function json(status: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

/**
 * Public, read-only entry point: `POST /mcp` (stateless streamable HTTP) and `GET /health`.
 * No sessions and no server: the function loads the published snapshot once per cold start.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
  logger.addContext(context);
  const started = Date.now();
  const method = event.requestContext.http.method;
  const route = event.rawPath.replace(/\/+$/, '') || '/';
  const subsegment = tracer.getSegment()?.addNewSubsegment('request');
  try {
    if (method === 'OPTIONS') return { statusCode: 204, headers: CORS };
    ready ??= start().catch((e: unknown) => {
      ready = null; // let the next request retry instead of caching a failed start
      throw e;
    });
    const { store, hydrated } = await ready;

    if (method === 'GET' && (route === '/health' || route === '/')) {
      return json(200, {
        ok: true,
        service: SERVICE,
        mcp: 'POST /mcp',
        rootCid: hydrated.rootCid,
        filesVerifiedAgainstManifest: hydrated.verified,
        bytes: hydrated.bytes,
      });
    }
    if (route !== '/mcp') return json(404, { error: 'not found' });
    if (method !== 'POST') return json(405, { error: 'POST /mcp only (stateless, no SSE stream)' });

    const headers = new Headers();
    for (const [k, v] of Object.entries(event.headers)) if (v !== undefined) headers.set(k, v);
    const body =
      event.body === undefined
        ? ''
        : event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf8')
          : event.body;
    const request = new Request(`https://${event.requestContext.domainName}/mcp`, {
      method: 'POST',
      headers,
      body,
    });
    const response = await handleMcpRequest(store, request, () => isoDate(new Date()));
    metrics.addMetric('McpRequestsProcessed', MetricUnit.Count, 1);
    return {
      statusCode: response.status,
      headers: { ...Object.fromEntries(response.headers), ...CORS },
      body: await response.text(),
    };
  } catch (e) {
    metrics.addMetric('McpRequestsFailed', MetricUnit.Count, 1);
    logger.critical('request failed', { route, error: e instanceof Error ? e.message : String(e) });
    return json(500, { error: 'The Oracle data service failed to answer.' });
  } finally {
    metrics.addMetric('RequestDuration', MetricUnit.Milliseconds, Date.now() - started);
    subsegment?.close();
    metrics.publishStoredMetrics();
  }
};
