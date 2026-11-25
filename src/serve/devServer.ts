import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { isoDate } from '../config.js';
import { handleMcpRequest } from './mcp.js';
import { Store } from './store.js';

/**
 * Local MCP endpoint for development: `npm run serve -- --artifacts <run folder>`.
 * Serves the same handler the Lambda uses, over the published Parquet files on disk.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      artifacts: { type: 'string' },
      port: { type: 'string', default: '8790' },
    },
  });
  if (!values.artifacts)
    throw new Error('usage: npm run serve -- --artifacts data/artifacts/publish/san-diego/run-0003');
  const store = await Store.open(values.artifacts);
  const port = Number(values.port);
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
  };

  createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404, cors).end('not found');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const init: RequestInit = { method: req.method ?? 'GET', headers };
      if (req.method === 'POST') init.body = Buffer.concat(chunks);
      const request = new Request(url, init);
      const response = await handleMcpRequest(store, request, () => isoDate(new Date()));
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...cors });
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((e: unknown) => {
      res.writeHead(500, cors).end(e instanceof Error ? e.message : 'error');
    });
  }).listen(port, '127.0.0.1', () => {
    process.stdout.write(
      `Oracle MCP listening on http://127.0.0.1:${port}/mcp (artifacts: ${values.artifacts})\n`,
    );
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
});
