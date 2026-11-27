import { z } from 'zod';
import { MCP_URL } from './config';

export type McpErrorKind = 'tool_error' | 'tool_not_found' | 'http' | 'network' | 'protocol';

/** Every failure of an MCP call, with a kind the UI can branch on. */
export class McpError extends Error {
  readonly kind: McpErrorKind;
  readonly status: number | null;

  constructor(kind: McpErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'McpError';
    this.kind = kind;
    this.status = status;
  }
}

export interface RpcOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Extra attempts after a network failure or a 5xx/429 answer. Default 1. */
  retries?: number;
  retryDelayMs?: number;
}

const envelope = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string() }).optional(),
});

const toolResult = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
    .default([]),
  structuredContent: z.record(z.unknown()).optional(),
  isError: z.boolean().optional(),
});

const toolInfo = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.unknown().optional(),
    annotations: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type ToolInfo = z.infer<typeof toolInfo>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Streamable HTTP may answer as JSON or as a one-event SSE stream. Both end in a JSON-RPC body. */
export function parseRpcBody(body: string, contentType: string | null): unknown {
  if (contentType?.includes('text/event-stream')) {
    const data = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line !== '');
    const last = data.at(-1);
    if (last === undefined) throw new McpError('protocol', 'The event stream had no data event.');
    return JSON.parse(last) as unknown;
  }
  return JSON.parse(body) as unknown;
}

let nextId = 1;

/** One JSON-RPC call over a plain POST. Retries once on a network failure or a 5xx answer. */
export async function rpc(
  method: string,
  params: Record<string, unknown> | undefined,
  options: RpcOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 1;
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: nextId++,
    method,
    ...(params ? { params } : {}),
  });
  let lastError: McpError = new McpError('network', 'The request was not sent.');

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(options.retryDelayMs ?? 700);
    let response: Response;
    try {
      response = await fetchImpl(options.url ?? MCP_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: payload,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = new McpError(
        'network',
        `Could not reach the API (${error instanceof Error ? error.message : 'network error'}).`,
      );
      continue;
    }
    if (!response.ok) {
      lastError = new McpError(
        'http',
        `The API answered HTTP ${response.status}.`,
        response.status,
      );
      if (response.status >= 500 || response.status === 429) continue;
      throw lastError;
    }
    let parsed: z.infer<typeof envelope>;
    try {
      parsed = envelope.parse(
        parseRpcBody(await response.text(), response.headers.get('content-type')),
      );
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError('protocol', 'The API answer was not a JSON-RPC message.');
    }
    if (parsed.error) throw new McpError('protocol', `MCP error: ${parsed.error.message}`);
    return parsed.result;
  }
  throw lastError;
}

/**
 * Calls one tool and returns its payload: `structuredContent` when present, otherwise the text
 * block parsed as JSON, otherwise the raw text. An `isError` result becomes an McpError whose
 * message is the server's own text, so a rejected query can be shown word for word.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  options: RpcOptions = {},
): Promise<unknown> {
  const raw = await rpc('tools/call', { name, arguments: args }, options);
  const parsed = toolResult.safeParse(raw);
  if (!parsed.success) throw new McpError('protocol', `Tool ${name} returned an unexpected shape.`);
  const text = parsed.data.content.find((c) => c.type === 'text')?.text ?? '';
  if (parsed.data.isError) {
    const notFound = /tool\b.*\bnot found/i.test(text);
    throw new McpError(notFound ? 'tool_not_found' : 'tool_error', text || `Tool ${name} failed.`);
  }
  if (parsed.data.structuredContent !== undefined) return parsed.data.structuredContent;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function listTools(options: RpcOptions = {}): Promise<ToolInfo[]> {
  const raw = await rpc('tools/list', undefined, options);
  const parsed = z.object({ tools: z.array(toolInfo) }).safeParse(raw);
  if (!parsed.success) throw new McpError('protocol', 'tools/list returned an unexpected shape.');
  return parsed.data.tools;
}
