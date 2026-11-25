import { Logger } from '@aws-lambda-powertools/logger';
import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { isoDate } from '../config.js';
import { createAnthropic } from '@ai-sdk/anthropic';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { LanguageModel } from 'ai';
import { agentAskInput, askAgent } from './agent.js';
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
  model: LanguageModel | null;
  modelName: string;
}

/** Model key from SSM SecureString; never in code, env files or logs. No key means no agent. */
async function loadModel(): Promise<{ model: LanguageModel | null; modelName: string }> {
  const parameter = process.env['AGENT_KEY_PARAMETER'];
  const modelName = process.env['AGENT_MODEL'] ?? 'claude-sonnet-5-5';
  if (!parameter) return { model: null, modelName: 'none' };
  try {
    const out = await new SSMClient({}).send(
      new GetParameterCommand({ Name: parameter, WithDecryption: true }),
    );
    const apiKey = out.Parameter?.Value;
    if (!apiKey) return { model: null, modelName: 'none' };
    return { model: createAnthropic({ apiKey })(modelName), modelName };
  } catch {
    logger.warn('agent key parameter not readable; agent disabled');
    return { model: null, modelName: 'none' };
  }
}

let ready: Promise<Ready> | null = null;

/**
 * The agent endpoint is public and each answer costs model tokens. Calls are counted per running
 * container per day (a soft cap; the provider key also has a hard monthly spend limit).
 */
const AGENT_DAILY_LIMIT = Number(process.env['AGENT_DAILY_LIMIT'] ?? 150);
let agentDay = '';
let agentCalls = 0;

async function start(): Promise<Ready> {
  const bucket = process.env['ARTIFACT_BUCKET'];
  const prefix = process.env['ARTIFACT_PREFIX'];
  if (!bucket || !prefix) throw new Error('ARTIFACT_BUCKET and ARTIFACT_PREFIX are required');
  const hydrated = await hydrate(bucket, prefix, '/tmp/artifacts');
  logger.info('artifacts ready', { ...hydrated });
  metrics.addMetric('ColdStartHydrateMs', MetricUnit.Milliseconds, hydrated.ms);
  return { store: await Store.open(hydrated.dir), hydrated, ...(await loadModel()) };
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
    const { store, hydrated, model, modelName } = await ready;

    if (method === 'GET' && (route === '/health' || route === '/')) {
      return json(200, {
        ok: true,
        service: SERVICE,
        mcp: 'POST /mcp',
        agent: model ? `POST /agent (${modelName})` : 'not configured',
        rootCid: hydrated.rootCid,
        filesVerifiedAgainstManifest: hydrated.verified,
        bytes: hydrated.bytes,
      });
    }
    if (route === '/agent') {
      if (method !== 'POST') return json(405, { error: 'POST /agent only' });
      const raw =
        event.body === undefined
          ? '{}'
          : event.isBase64Encoded
            ? Buffer.from(event.body, 'base64').toString('utf8')
            : event.body;
      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        return json(400, { error: 'Request body must be JSON: {"question": "..."}' });
      }
      const parsed = agentAskInput.safeParse(body);
      if (!parsed.success) return json(400, { error: 'Invalid question', issues: parsed.error.issues });
      const day = isoDate(new Date());
      if (agentDay !== day) {
        agentDay = day;
        agentCalls = 0;
      }
      agentCalls += 1;
      if (model && agentCalls > AGENT_DAILY_LIMIT) {
        return json(429, {
          error:
            'The agent has reached its daily question limit for this demo. The MCP tools and the UI still work.',
        });
      }
      const answer = await askAgent({ store, model, modelName, today: isoDate(new Date()) }, parsed.data);
      metrics.addMetric('AgentQuestionsAnswered', MetricUnit.Count, 1);
      return json(200, answer);
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
