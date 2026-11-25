import { describe, expect, it, vi } from 'vitest';
import { McpError, callTool, listTools, parseRpcBody } from './mcp';

const json = (body: unknown, status = 200, contentType = 'application/json'): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });

const result = (r: unknown): unknown => ({ jsonrpc: '2.0', id: 1, result: r });

const fetchOnce = (...responses: (Response | Error)[]) => {
  const mock = vi.fn<typeof fetch>();
  for (const r of responses) {
    if (r instanceof Error) mock.mockRejectedValueOnce(r);
    else mock.mockResolvedValueOnce(r);
  }
  return mock;
};

describe('callTool', () => {
  it('sends a JSON-RPC tools/call with the MCP headers', async () => {
    const fetchImpl = fetchOnce(json(result({ content: [{ type: 'text', text: '{"a":1}' }] })));
    await callTool('getCoverage', { x: 1 }, { fetchImpl, url: 'https://api.test/mcp' });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://api.test/mcp');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'getCoverage', arguments: { x: 1 } },
    });
  });

  it('prefers structuredContent over the text block', async () => {
    const fetchImpl = fetchOnce(
      json(
        result({
          content: [{ type: 'text', text: '{"from":"text"}' }],
          structuredContent: { from: 'structured' },
        }),
      ),
    );
    await expect(callTool('t', {}, { fetchImpl })).resolves.toEqual({ from: 'structured' });
  });

  it('falls back to parsing the text block as JSON', async () => {
    const fetchImpl = fetchOnce(json(result({ content: [{ type: 'text', text: '[1,2,3]' }] })));
    await expect(callTool('t', {}, { fetchImpl })).resolves.toEqual([1, 2, 3]);
  });

  it('returns null for the JSON text "null" (no such parcel)', async () => {
    const fetchImpl = fetchOnce(json(result({ content: [{ type: 'text', text: 'null' }] })));
    await expect(callTool('getOracleProperty', {}, { fetchImpl })).resolves.toBeNull();
  });

  it('returns plain text when the text block is not JSON (the schema tool)', async () => {
    const fetchImpl = fetchOnce(
      json(result({ content: [{ type: 'text', text: 'parcel(apn VARCHAR)' }] })),
    );
    await expect(callTool('getAtlasSchema', {}, { fetchImpl })).resolves.toBe(
      'parcel(apn VARCHAR)',
    );
  });

  it('turns an isError result into a tool_error carrying the server text', async () => {
    const fetchImpl = fetchOnce(
      json(
        result({
          content: [
            { type: 'text', text: 'Query rejected: Only SELECT (or WITH ... SELECT) is allowed.' },
          ],
          isError: true,
        }),
      ),
    );
    const error = await callTool('queryAtlas', { sql: 'DROP' }, { fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).kind).toBe('tool_error');
    expect((error as McpError).message).toBe(
      'Query rejected: Only SELECT (or WITH ... SELECT) is allowed.',
    );
  });

  it('recognises a tool that does not exist yet', async () => {
    const fetchImpl = fetchOnce(
      json(
        result({
          content: [
            { type: 'text', text: 'MCP error -32602: Tool getPublicationHistory not found' },
          ],
          isError: true,
        }),
      ),
    );
    await expect(callTool('getPublicationHistory', {}, { fetchImpl })).rejects.toMatchObject({
      kind: 'tool_not_found',
    });
  });

  it('retries once after a network failure', async () => {
    const fetchImpl = fetchOnce(
      new TypeError('Failed to fetch'),
      json(result({ content: [], structuredContent: { ok: true } })),
    );
    await expect(callTool('t', {}, { fetchImpl, retryDelayMs: 0 })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries once after a 5xx and then reports the HTTP status', async () => {
    const fetchImpl = fetchOnce(json({}, 503), json({}, 503));
    await expect(callTool('t', {}, { fetchImpl, retryDelayMs: 0 })).rejects.toMatchObject({
      kind: 'http',
      status: 503,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx', async () => {
    const fetchImpl = fetchOnce(json({}, 400));
    await expect(callTool('t', {}, { fetchImpl, retryDelayMs: 0 })).rejects.toMatchObject({
      kind: 'http',
      status: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a JSON-RPC error envelope and a non-JSON body as protocol errors', async () => {
    const rpcError = fetchOnce(
      json({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'bad' } }),
    );
    await expect(callTool('t', {}, { fetchImpl: rpcError })).rejects.toMatchObject({
      kind: 'protocol',
      message: 'MCP error: bad',
    });
    const html = fetchOnce(json('<html>', 200, 'text/html'));
    await expect(callTool('t', {}, { fetchImpl: html })).rejects.toMatchObject({
      kind: 'protocol',
    });
  });
});

describe('parseRpcBody', () => {
  it('reads the last data event of an SSE answer', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n';
    expect(parseRpcBody(body, 'text/event-stream')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { x: 1 },
    });
  });
});

describe('listTools', () => {
  it('returns the catalogue', async () => {
    const fetchImpl = fetchOnce(
      json(result({ tools: [{ name: 'queryAtlas', description: 'd', inputSchema: {} }] })),
    );
    const tools = await listTools({ fetchImpl });
    expect(tools.map((t) => t.name)).toEqual(['queryAtlas']);
  });
});
